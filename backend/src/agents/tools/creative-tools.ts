import { randomUUID } from 'node:crypto'
import { createTool } from '@mastra/core/tools'
import { and, desc, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db, schema } from '../../db/index.js'
import type { CreativeReference } from '../../db/schema.js'
import { activeEpisode, activeProject, findBlockingScript, isScriptEditable, saveProjectEpisode, saveProjectOutline,
  type ScriptTransaction } from '../../services/project-scripts.js'
import { nextEpisodeNumber } from '../../services/episode-number.js'
import { formattedScript, projectOutline } from '../../services/script-import.js'
import { getActiveConfigId } from '../../services/ai.js'
import { createNovelLease, runNovelJob } from '../../services/novels.js'
import { now } from '../../utils/response.js'

const { dramas, episodes, projectScripts, scriptJobs, novelJobs, novelManuscriptParts, novelChapters,
  creativeTurns, creativeChanges, characters, scenes, props, storyboards } = schema
const id = z.number().int().positive()
const offset = z.number().int().nonnegative().optional()
const sceneNumber = z.string().regex(/^S\d+$/i)
const revision = z.string().min(1).max(80)
const episodeTitle = z.string().trim().min(1).max(160)
const excerptSize = 9000
const sceneHeader = /^##[ \t]+(S\d+)[ \t]*\|[^\r\n]*/gim

type ToolResult = { error?: string; [key: string]: unknown }
type Change = Omit<typeof creativeChanges.$inferInsert, 'id' | 'turnId' | 'callId'>
type Run = {
  projectId: number
  sessionId: number
  turnId: number
  contentLanguage: string
  configId: number
  model: string
  authorized: (tool: string, target: Record<string, unknown>) => Promise<boolean>
  start: (tool: string, target: Record<string, unknown>, callId: string) => void
  finish: (callId: string, error?: string, target?: Record<string, unknown>) => void
  commit: (callId: string, write: (tx: ScriptTransaction) => Change | { error: string }) => ToolResult
}

function excerpt(text: string, at: number) {
  const end = Math.min(at + excerptSize, text.length)
  return { content: text.slice(at, end), next_offset: end < text.length ? end : null }
}

function uploadedScript(projectId: number) {
  return db.select({ content: sql<string>`json_extract(${scriptJobs.payload}, '$.source')` }).from(scriptJobs)
    .where(and(eq(scriptJobs.dramaId, projectId), sql`json_type(${scriptJobs.payload}, '$.source') = 'text'`))
    .orderBy(desc(scriptJobs.id)).get()?.content
}

function projectNovel(projectId: number, novelId?: number) {
  return db.select().from(novelJobs).where(and(
    eq(novelJobs.dramaId, projectId),
    novelId === undefined ? undefined : eq(novelJobs.id, novelId),
  )).orderBy(desc(novelJobs.id)).get()
}

function projectNovelInTx(tx: ScriptTransaction, projectId: number, novelId: number) {
  return tx.select().from(novelJobs).where(and(eq(novelJobs.dramaId, projectId), eq(novelJobs.id, novelId))).get()
}

function novelPartInTx(tx: ScriptTransaction, novelId: number, partNumber: number) {
  return tx.select().from(novelManuscriptParts).where(and(
    eq(novelManuscriptParts.jobId, novelId),
    eq(novelManuscriptParts.partNumber, partNumber),
  )).get()
}

function replaceUnique(source: string, original: string, replacement: string) {
  const first = source.indexOf(original)
  if (first < 0 || source.indexOf(original, first + 1) >= 0) return null
  return source.slice(0, first) + replacement + source.slice(first + original.length)
}

function novelLabel(job: typeof novelJobs.$inferSelect) {
  return job.brief.split(/\r?\n/, 1)[0].slice(0, 120) || `小说 ${job.id}`
}

function canEditNovelDraft(job: typeof novelJobs.$inferSelect) {
  return job.completedChapters === 0 && (job.status === 'ready' || job.status === 'failed')
}

export function creativeMaterials(projectId: number, afterEpisode = 0, query?: string) {
  const catalogue = db.select({ id: episodes.id, number: episodes.episodeNumber, title: episodes.title }).from(episodes)
    .where(and(eq(episodes.dramaId, projectId), isNull(episodes.deletedAt), gt(episodes.episodeNumber, afterEpisode),
      query ? sql`instr(lower(${episodes.title}), lower(${query})) > 0` : undefined))
    .orderBy(episodes.episodeNumber).limit(61).all()
  const novels = db.select({ id: novelJobs.id, title: sql<string>`substr(${novelJobs.brief}, 1, 80)`, status: novelJobs.status,
    part_count: novelJobs.draftCount, revision: novelJobs.draftRevision, created_at: novelJobs.createdAt }).from(novelJobs)
    .where(and(eq(novelJobs.dramaId, projectId), query ? sql`instr(lower(${novelJobs.brief}), lower(${query})) > 0` : undefined))
    .orderBy(desc(novelJobs.id)).limit(50).all()
  const source = db.select({ id: scriptJobs.id }).from(scriptJobs).where(and(eq(scriptJobs.dramaId, projectId),
    sql`json_type(${scriptJobs.payload}, '$.source') = 'text'`)).get()
  const page = catalogue.slice(0, 60)
  return { episodes: page, novels, has_source: !!source,
    next_after_episode: catalogue.length > page.length ? page.at(-1)!.number : null,
    next_episode_number: db.transaction(tx => nextEpisodeNumber(tx, projectId)) }
}

export function creativeReferenceExists(projectId: number, reference: CreativeReference) {
  if (reference.kind === 'episode') return !!reference.id && !!db.transaction(tx => activeEpisode(tx, projectId, reference.id!))
  if (reference.kind === 'novel') return !!db.select({ id: novelJobs.id }).from(novelJobs)
    .where(and(eq(novelJobs.dramaId, projectId), eq(novelJobs.id, reference.id ?? 0))).get()
  return !!uploadedScript(projectId)
}

function sceneRange(script: string, scene: string) {
  const headers = [...script.matchAll(sceneHeader)]
  const matches = headers.flatMap((header, index) => header[1].toUpperCase() === scene.toUpperCase() ? [index] : [])
  if (matches.length !== 1) return null
  const position = matches[0]
  const heading = headers[position]
  return { start: heading.index, body: heading.index + heading[0].length,
    end: headers[position + 1]?.index ?? script.length }
}

export function creativeTools(run: Run) {
  const project = run.projectId
  async function read(tool: string, target: Record<string, unknown>, callId: string | undefined, action: () => ToolResult) {
    const key = callId ?? randomUUID()
    run.start(tool, target, key)
    const result = action()
    run.finish(key, typeof result.error === 'string' ? result.error : undefined, {
      ...target,
      ...(typeof result.episode_id === 'number' ? { episode_id: result.episode_id, episode_number: result.episode_number } : {}),
      ...(typeof result.novel_id === 'number' ? { novel_id: result.novel_id, part_number: result.part_number,
        job_status: result.status } : {}),
    })
    return result
  }
  async function write(tool: string, target: Record<string, unknown>, callId: string | undefined,
    action: (tx: ScriptTransaction) => Change | { error: string }, prepare?: () => Promise<void>,
    afterCommit?: (result: ToolResult) => void) {
    const key = callId ?? randomUUID()
    run.start(tool, target, key)
    const allowed = await run.authorized(tool, target).catch(() => null)
    if (allowed === null) {
      run.finish(key, 'intent_unavailable')
      return { error: 'intent_unavailable' }
    }
    if (!allowed) {
      run.finish(key, 'write_not_requested')
      return { error: 'write_not_requested' }
    }
    try {
      if (prepare) await prepare()
      const result = run.commit(key, action)
      if (!result.error && afterCommit) afterCommit(result)
      return result
    } catch (error) {
      const code = error instanceof Error && ['image_unavailable', 'video_unavailable'].includes(error.message)
        ? error.message : 'save_failed'
      run.finish(key, code)
      return { error: code }
    }
  }

  return {
    list_project_materials: createTool({ id: 'list_project_materials',
      description: 'List active project, episode IDs, novel drafts, available upload, and the next episode number.',
      inputSchema: z.object({ after_episode: offset, query: z.string().trim().min(1).max(120).optional() }),
      execute: ({ after_episode, query }, context) => read('list_project_materials', {}, context?.agent?.toolCallId, () => {
        const info = activeProject(project)
        return { title: info?.title, description: info?.description, ...creativeMaterials(project, after_episode, query) }
      }),
    }),
    read_project_outline: createTool({ id: 'read_project_outline', description: 'Read the current project outline and its revision.',
      inputSchema: z.object({}), execute: (_, context) => read('read_project_outline', {}, context?.agent?.toolCallId, () => {
        const row = db.select().from(projectScripts).where(eq(projectScripts.dramaId, project)).get()
        return { outline: row ? JSON.parse(row.outline) : null, revision: row?.revision ?? 0 }
      }),
    }),
    read_project_assets: createTool({ id: 'read_project_assets',
      description: 'Read concise project character, scene, prop, and storyboard context for continuity and script writing.',
      inputSchema: z.object({ kind: z.enum(['characters', 'scenes', 'props', 'storyboards']),
        episode_id: id.optional(), limit: z.number().int().min(1).max(100).default(60) }),
      execute: ({ kind, episode_id, limit }, context) => read('read_project_assets', { kind, episode_id },
        context?.agent?.toolCallId, () => {
        const take = limit ?? 60
        if (kind === 'characters') {
          return { items: db.select({ id: characters.id, name: characters.name, role: characters.role,
            description: characters.description, appearance: characters.appearance, styling: characters.styling,
            image_url: characters.imageUrl }).from(characters).where(and(eq(characters.dramaId, project),
            isNull(characters.deletedAt))).limit(take).all() }
        }
        if (kind === 'scenes') {
          return { items: db.select({ id: scenes.id, episode_id: scenes.episodeId, location: scenes.location, time: scenes.time,
            prompt: scenes.prompt, lighting: scenes.lighting, image_url: scenes.imageUrl }).from(scenes).where(and(
            eq(scenes.dramaId, project), isNull(scenes.deletedAt))).limit(take).all() }
        }
        if (kind === 'props') {
          return { items: db.select({ id: props.id, name: props.name, type: props.type, description: props.description,
            image_url: props.imageUrl }).from(props).where(and(eq(props.dramaId, project),
            isNull(props.deletedAt))).limit(take).all() }
        }
        const episodeIds = db.select({ id: episodes.id }).from(episodes).where(and(
          eq(episodes.dramaId, project), isNull(episodes.deletedAt),
          episode_id === undefined ? undefined : eq(episodes.id, episode_id),
        )).all()
        if (!episodeIds.length) return { items: [] }
        return { items: db.select({ id: storyboards.id, episode_id: storyboards.episodeId, number: storyboards.storyboardNumber,
          title: storyboards.title, description: storyboards.description, duration: storyboards.duration,
          status: storyboards.status }).from(storyboards).where(and(
          inArray(storyboards.episodeId, episodeIds.map(episode => episode.id)),
          isNull(storyboards.deletedAt),
        )).limit(take).all() }
        }),
    }),
    read_episode_script: createTool({ id: 'read_episode_script',
      description: 'Read the persisted episode script and revision by ID or episode number. Use scene, exact quote, offset, or tail to locate text.',
      inputSchema: z.object({ episode_id: id.optional(), episode_number: id.optional(), scene: sceneNumber.optional(),
        quote: z.string().trim().min(1).max(400).optional(), offset, tail: z.boolean().optional() }),
      execute: (input, context) => read('read_episode_script', { episode_id: input.episode_id,
        episode_number: input.episode_number, scene: input.scene }, context?.agent?.toolCallId, () => db.transaction(tx => {
        const episode = input.episode_id !== undefined ? activeEpisode(tx, project, input.episode_id) : tx.select().from(episodes)
          .where(and(eq(episodes.dramaId, project), isNull(episodes.deletedAt), eq(episodes.episodeNumber, input.episode_number ?? 0))).get()
        if (!episode) return { error: 'not_found' }
        let script = episode.scriptContent ?? episode.content ?? ''
        const range = input.scene ? sceneRange(script, input.scene) : null
        if (input.scene && !range) return { error: 'scene_not_found' }
        if (range) script = script.slice(range.start, range.end)
        const quoteAt = input.quote ? script.indexOf(input.quote) : -1
        if (input.quote && quoteAt < 0) return { error: 'quote_not_found' }
        if (input.quote && script.indexOf(input.quote, quoteAt + 1) >= 0) return { error: 'quote_ambiguous' }
        const start = input.offset ?? (input.tail ? Math.max(0, script.length - excerptSize) : Math.max(0, quoteAt - 500))
        return { episode_id: episode.id, episode_number: episode.episodeNumber, title: episode.title,
          revision: episode.updatedAt, editable: isScriptEditable(tx, episode), original_only: !episode.scriptContent,
          ...excerpt(script, start) }
      })),
    }),
    read_uploaded_source: createTool({ id: 'read_uploaded_source', description: 'Read the uploaded project source as reference material.',
      inputSchema: z.object({ offset }), execute: (input, context) => read('read_uploaded_source', {}, context?.agent?.toolCallId, () => {
        const source = uploadedScript(project)
        return source ? excerpt(source, input.offset ?? 0) : { error: 'not_found' }
      }),
    }),
    read_novel_context: createTool({ id: 'read_novel_context',
      description: 'Read a novel plan, continuity summary, part index, split status, and linked episodes before writing or splitting.',
      inputSchema: z.object({ novel_id: id.optional(), after_part_number: offset }),
      execute: (input, context) => read('read_novel_context', { novel_id: input.novel_id }, context?.agent?.toolCallId, () => {
        const job = projectNovel(project, input.novel_id)
        if (!job) return { error: 'not_found' }
        const catalogue = db.select({ part_number: novelManuscriptParts.partNumber, summary: novelManuscriptParts.summary,
          opening: sql<string>`substr(${novelManuscriptParts.draft}, 1, 180)` }).from(novelManuscriptParts)
          .where(and(eq(novelManuscriptParts.jobId, job.id),
            gt(novelManuscriptParts.partNumber, input.after_part_number ?? 0))).orderBy(novelManuscriptParts.partNumber).limit(30).all()
        const chapters = db.select({ chapter_number: novelChapters.chapterNumber, title: novelChapters.title,
          episode_id: novelChapters.episodeId }).from(novelChapters).where(eq(novelChapters.jobId, job.id))
          .orderBy(novelChapters.chapterNumber).limit(100).all()
        let outline: unknown = job.outline
        if (job.outline) {
          try { outline = JSON.parse(job.outline) } catch { outline = job.outline }
        }
        return { novel_id: job.id, title: novelLabel(job), brief: job.brief, story_plan: job.storyPlan, outline,
          status: job.status, stage: job.stage, workflow_mode: job.workflowMode, part_count: job.draftCount,
          draft_done: job.draftDone, draft_revision: job.draftRevision, optimized_done: job.optimizedDone,
          episode_count: job.episodeCount, completed_chapters: job.completedChapters, error_code: job.errorCode,
          catalogue, chapters, next_after_part_number: catalogue.length === 30 ? catalogue.at(-1)?.part_number ?? null : null }
      }),
    }),
    read_novel_manuscript: createTool({ id: 'read_novel_manuscript',
      description: 'Read a novel part by ID, exact quote, offset, or tail. Unfinished and completed project novels are supported.',
      inputSchema: z.object({ novel_id: id.optional(), part_number: id.optional(),
        quote: z.string().trim().min(1).max(400).optional(), offset, tail: z.boolean().optional() }),
      execute: (input, context) => read('read_novel_manuscript', { novel_id: input.novel_id, part_number: input.part_number },
        context?.agent?.toolCallId, () => {
          const job = projectNovel(project, input.novel_id)
          if (!job) return { error: 'not_found' }
          const parts = db.select({ part_number: novelManuscriptParts.partNumber, content: novelManuscriptParts.draft }).from(novelManuscriptParts)
            .where(eq(novelManuscriptParts.jobId, job.id)).orderBy(novelManuscriptParts.partNumber).all()
          if (parts.length) {
            let number = input.part_number
            if (number === undefined && input.quote) {
              const matching = parts.filter(part => part.content.includes(input.quote!)).map(part => part.part_number)
              if (matching.length !== 1) return { novel_id: job.id, matching_parts: matching }
              number = matching[0]
            }
            const part = parts.find(item => item.part_number === (number ?? parts.at(-1)!.part_number))
            if (!part) return { error: 'part_not_found' }
            const quoteAt = input.quote ? part.content.indexOf(input.quote) : -1
            if (input.quote && quoteAt < 0) return { error: 'quote_not_found' }
            if (input.quote && part.content.indexOf(input.quote, quoteAt + 1) >= 0) return { error: 'quote_ambiguous' }
            const start = input.offset ?? (input.tail ? Math.max(0, part.content.length - excerptSize)
              : input.quote ? Math.max(0, quoteAt - 800) : 0)
            return { novel_id: job.id, title: novelLabel(job), status: job.status, draft_revision: job.draftRevision,
              part_number: part.part_number, part_count: parts.length, ...excerpt(part.content, start) }
          }
          const chapters = db.select({ chapter_number: novelChapters.chapterNumber, title: novelChapters.title,
            content: novelChapters.content }).from(novelChapters).where(eq(novelChapters.jobId, job.id))
            .orderBy(novelChapters.chapterNumber).all()
          const chapter = chapters.find(item => item.chapter_number === input.part_number)
            ?? (input.quote ? chapters.find(item => item.content.includes(input.quote!)) : undefined)
            ?? chapters.at(-1)
          if (!chapter) return { error: 'not_found' }
          const start = input.offset ?? (input.tail ? Math.max(0, chapter.content.length - excerptSize) : 0)
          return { novel_id: job.id, title: chapter.title, status: job.status, part_number: chapter.chapter_number,
            part_count: chapters.length, ...excerpt(chapter.content, start) }
        }),
    }),
    search_conversation: createTool({ id: 'search_conversation', description: 'Find earlier choices and text from this session by exact keyword.',
      inputSchema: z.object({ query: z.string().trim().min(1).max(150), before_id: id.optional() }),
      execute: ({ query, before_id }, context) => read('search_conversation', {}, context?.agent?.toolCallId, () => {
        const rows = db.select({ id: creativeTurns.id, message: creativeTurns.message, reply: creativeTurns.assistantText })
          .from(creativeTurns).where(and(eq(creativeTurns.sessionId, run.sessionId),
            lt(creativeTurns.id, Math.min(before_id ?? run.turnId, run.turnId)),
            inArray(creativeTurns.status, ['completed', 'partial', 'failed', 'interrupted', 'stopped']),
            sql`(instr(${creativeTurns.message}, ${query}) > 0 OR instr(${creativeTurns.assistantText}, ${query}) > 0)`))
          .orderBy(desc(creativeTurns.id)).limit(8).all()
        const snippet = (value: string) => {
          const start = Math.max(0, value.indexOf(query) - 400)
          return value.slice(start, start + 2200)
        }
        return { turns: rows.map(row => ({ id: row.id, message: snippet(row.message), reply: snippet(row.reply) })),
          next_before_id: rows.length === 8 ? rows.at(-1)!.id : null }
      }),
    }),
    save_project_outline: createTool({ id: 'save_project_outline', description: 'Save the whole project outline at its current revision.',
      inputSchema: z.object({ base_revision: z.number().int().nonnegative(), outline: projectOutline }),
      execute: (input, context) => write('save_project_outline', {}, context?.agent?.toolCallId, tx => {
        const result = saveProjectOutline(tx, project, input.base_revision, input.outline)
        return result.error ? { error: result.error } : { kind: 'outline', title: '项目大纲', before: result.before,
          after: result.after, baseRevision: String(input.base_revision), revision: String(result.revision) }
      }),
    }),
    create_novel: createTool({ id: 'create_novel',
      description: 'Create a project novel workspace for planning and chapter writing. Use one workspace per novel project.',
      inputSchema: z.object({ title: z.string().trim().min(1).max(160), premise: z.string().trim().min(1).max(8000).optional() }),
      execute: (input, context) => write('create_novel', { title: input.title }, context?.agent?.toolCallId, tx => {
        const timestamp = now()
        const brief = input.premise ? `${input.title}\n\n${input.premise}` : input.title
        const novel = tx.insert(novelJobs).values({
          dramaId: project, requestId: randomUUID().replace(/-/g, ''), brief,
          projectContext: JSON.stringify(activeProject(project)), contentLanguage: run.contentLanguage,
          configId: run.configId, model: run.model, status: 'ready', stage: 'ready', workflowMode: 'preview_first',
          sourceType: 'ai', draftCount: 0, draftDone: 0, draftRevision: 1, optimizedDone: 0,
          completedChapters: 0, createdAt: timestamp, updatedAt: timestamp,
        }).returning().get()
        return { kind: 'novel', novelId: novel.id, title: input.title, before: null, after: brief,
          revision: String(novel.draftRevision) }
      }),
    }),
    save_novel_plan: createTool({ id: 'save_novel_plan',
      description: 'Save or replace the approved story plan for one novel. Read its revision first.',
      inputSchema: z.object({ novel_id: id, base_revision: id,
        plan: z.string().trim().min(1).max(30000) }),
      execute: (input, context) => write('save_novel_plan', { novel_id: input.novel_id }, context?.agent?.toolCallId, tx => {
        const novel = projectNovelInTx(tx, project, input.novel_id)
        if (!novel) return { error: 'not_found' }
        if (novel.status === 'running') return { error: 'novel_running' }
        if (!canEditNovelDraft(novel)) return { error: 'novel_locked' }
        if (novel.draftRevision !== input.base_revision) return { error: 'novel_changed' }
        const revision = novel.draftRevision + 1
        const timestamp = now()
        tx.update(novelJobs).set({ storyPlan: input.plan, draftRevision: revision, status: 'ready',
          stage: 'ready', episodeCount: null, optimizedDone: 0, errorCode: null, updatedAt: timestamp }).where(eq(novelJobs.id, novel.id)).run()
        tx.update(novelManuscriptParts).set({ optimized: null, analysis: null })
          .where(eq(novelManuscriptParts.jobId, novel.id)).run()
        tx.update(dramas).set({ updatedAt: timestamp }).where(eq(dramas.id, project)).run()
        return { kind: 'novel', novelId: novel.id, title: `${novelLabel(novel)} · 故事规划`,
          before: novel.storyPlan, after: input.plan, baseRevision: String(novel.draftRevision), revision: String(revision) }
      }),
    }),
    append_novel_part: createTool({ id: 'append_novel_part',
      description: 'Append the next novel chapter or part with its title and continuity summary. Read the novel context first.',
      inputSchema: z.object({ novel_id: id, base_revision: id, part_number: id,
        title: z.string().trim().min(1).max(160), content: z.string().trim().min(1).max(50000),
        summary: z.string().trim().min(1).max(3000) }),
      execute: (input, context) => write('append_novel_part', { novel_id: input.novel_id, part_number: input.part_number },
        context?.agent?.toolCallId, tx => {
          const novel = projectNovelInTx(tx, project, input.novel_id)
          if (!novel) return { error: 'not_found' }
          if (novel.status === 'running') return { error: 'novel_running' }
          if (!canEditNovelDraft(novel)) return { error: 'novel_locked' }
          if (novel.draftRevision !== input.base_revision) return { error: 'novel_changed' }
          if (input.part_number !== novel.draftCount + 1) return { error: 'part_number_conflict' }
          const revision = novel.draftRevision + 1
          const timestamp = now()
          const draft = `${novel.draftCount ? '\n\n' : ''}# ${input.title}\n\n${input.content}`
          tx.insert(novelManuscriptParts).values({ jobId: novel.id, partNumber: input.part_number,
            draft, summary: input.summary }).run()
          tx.update(novelJobs).set({ draftCount: input.part_number, draftDone: input.part_number,
            draftRevision: revision, optimizedDone: 0, episodeCount: null, status: 'ready', stage: 'ready',
            errorCode: null, updatedAt: timestamp }).where(eq(novelJobs.id, novel.id)).run()
          tx.update(novelManuscriptParts).set({ optimized: null, analysis: null })
            .where(eq(novelManuscriptParts.jobId, novel.id)).run()
          tx.update(dramas).set({ updatedAt: timestamp }).where(eq(dramas.id, project)).run()
          return { kind: 'novel', novelId: novel.id, partNumber: input.part_number,
            title: `${novelLabel(novel)} · 第 ${input.part_number} 部`, before: null, after: draft,
            baseRevision: String(novel.draftRevision), revision: String(revision) }
        }),
    }),
    replace_novel_text: createTool({ id: 'replace_novel_text',
      description: 'Replace one unique exact passage in a novel part. Use the revision and actual original text read from the part.',
      inputSchema: z.object({ novel_id: id, base_revision: id, part_number: id,
        original_text: z.string().min(1).max(50000), content: z.string().max(50000),
        summary: z.string().trim().min(1).max(3000) }),
      execute: (input, context) => write('replace_novel_text', { novel_id: input.novel_id, part_number: input.part_number },
        context?.agent?.toolCallId, tx => {
          const novel = projectNovelInTx(tx, project, input.novel_id)
          if (!novel) return { error: 'not_found' }
          if (novel.status === 'running') return { error: 'novel_running' }
          if (!canEditNovelDraft(novel)) return { error: 'novel_locked' }
          if (novel.draftRevision !== input.base_revision) return { error: 'novel_changed' }
          const part = novelPartInTx(tx, novel.id, input.part_number)
          if (!part) return { error: 'part_not_found' }
          const draft = replaceUnique(part.draft, input.original_text, input.content)
          if (draft === null) return { error: 'edit_target_changed' }
          const revision = novel.draftRevision + 1
          const timestamp = now()
          tx.update(novelManuscriptParts).set({ draft, summary: input.summary, optimized: null, analysis: null })
            .where(and(eq(novelManuscriptParts.jobId, novel.id), eq(novelManuscriptParts.partNumber, input.part_number))).run()
          tx.update(novelManuscriptParts).set({ summary: null, optimized: null, analysis: null }).where(and(
            eq(novelManuscriptParts.jobId, novel.id), gt(novelManuscriptParts.partNumber, input.part_number),
          )).run()
          tx.update(novelJobs).set({ draftRevision: revision, optimizedDone: 0, episodeCount: null,
            status: 'ready', stage: 'ready', errorCode: null, updatedAt: timestamp }).where(eq(novelJobs.id, novel.id)).run()
          tx.update(dramas).set({ updatedAt: timestamp }).where(eq(dramas.id, project)).run()
          return { kind: 'novel', novelId: novel.id, partNumber: input.part_number,
            title: `${novelLabel(novel)} · 第 ${input.part_number} 部`, before: input.original_text, after: input.content,
            baseRevision: String(novel.draftRevision), revision: String(revision) }
        }),
    }),
    split_novel_to_episodes: createTool({ id: 'split_novel_to_episodes',
      description: 'Start converting one completed novel draft into episodes. Report it as a background job until reading a completed status.',
      inputSchema: z.object({ novel_id: id, base_revision: id, episode_count: z.number().int().min(1).max(100) }),
      execute: (input, context) => {
        let imageConfigId: number | null = null
        let videoConfigId: number | null = null
        let lease: ReturnType<typeof createNovelLease> | null = null
        return write('split_novel_to_episodes', { novel_id: input.novel_id, episode_count: input.episode_count },
          context?.agent?.toolCallId, tx => {
            const novel = projectNovelInTx(tx, project, input.novel_id)
            if (!novel) return { error: 'not_found' }
            if (novel.status === 'running') return { error: 'novel_running' }
            if (!canEditNovelDraft(novel)) return { error: 'novel_locked' }
            if (novel.draftRevision !== input.base_revision) return { error: 'novel_changed' }
            if (!novel.draftCount || novel.draftDone !== novel.draftCount) return { error: 'draft_not_ready' }
            const running = tx.select({ id: novelJobs.id }).from(novelJobs).where(and(
              eq(novelJobs.dramaId, project), eq(novelJobs.status, 'running'),
            )).get()
            if (running) return { error: 'novel_running' }
            lease = createNovelLease()
            const timestamp = now()
            tx.update(novelJobs).set({ status: 'running', stage: 'analyzing', episodeCount: input.episode_count,
              configId: run.configId, model: run.model, imageConfigId, videoConfigId, errorCode: null,
              optimizedDone: 0, updatedAt: timestamp, ...lease }).where(eq(novelJobs.id, novel.id)).run()
            tx.update(novelManuscriptParts).set({ optimized: null, analysis: null })
              .where(eq(novelManuscriptParts.jobId, novel.id)).run()
            return { kind: 'novel', novelId: novel.id, title: `${novelLabel(novel)} · 分集任务`,
              before: novel.status, after: JSON.stringify({ status: 'running', episode_count: input.episode_count }),
              baseRevision: String(novel.draftRevision), revision: timestamp }
          }, async () => {
            [imageConfigId, videoConfigId] = await Promise.all([getActiveConfigId('image'), getActiveConfigId('video')])
            if (!imageConfigId) throw new Error('image_unavailable')
            if (!videoConfigId) throw new Error('video_unavailable')
          }, () => {
            if (lease) void runNovelJob(input.novel_id, lease.runToken)
              .catch(() => console.error('[creative-agent] novel split failed', input.novel_id))
          })
      },
    }),
    edit_episode_scene: createTool({ id: 'edit_episode_scene',
      description: 'Replace unique exact text inside one scene and save. Use the revision obtained by reading the episode.',
      inputSchema: z.object({ episode_id: id, base_revision: revision, scene: sceneNumber,
        original_text: z.string().min(1).max(30000), content: z.string().max(30000) }),
      execute: (input, context) => write('edit_episode_scene', { ...episodeTarget(input.episode_id, project), scene: input.scene },
        context?.agent?.toolCallId, tx => {
          const episode = activeEpisode(tx, project, input.episode_id)
          if (!episode) return { error: 'not_found' }
          if (!isScriptEditable(tx, episode)) return { error: 'production_locked' }
          if (episode.updatedAt !== input.base_revision) return { error: 'script_conflict' }
          const script = episode.scriptContent ?? ''
          const range = sceneRange(script, input.scene)
          if (!range) return { error: 'scene_not_found' }
          const body = script.slice(range.body, range.end)
          const match = body.indexOf(input.original_text)
          if (match < 0 || body.indexOf(input.original_text, match + 1) >= 0) return { error: 'edit_target_changed' }
          const start = range.body + match
          const proposed = script.slice(0, start) + input.content + script.slice(start + input.original_text.length)
          if (!formattedScript.safeParse(proposed).success || /^##[ \t]+S\d+[ \t]*\|/im.test(input.content)) return { error: 'invalid_script' }
          const result = saveProjectEpisode(tx, project, episode.id, { revision: input.base_revision, title: episode.title, script: proposed })
          return result.error ? { error: result.error } : { kind: 'episode', episodeId: episode.id, episodeNumber: episode.episodeNumber,
            title: episode.title, scene: input.scene.toUpperCase(), before: input.original_text, after: input.content,
            baseRevision: input.base_revision, revision: result.revision }
        }),
    }),
    save_episode_script: createTool({ id: 'save_episode_script', description: 'Replace an entire existing episode script and title when requested.',
      inputSchema: z.object({ episode_id: id, base_revision: revision, title: episodeTitle, script: formattedScript }),
      execute: (input, context) => write('save_episode_script', episodeTarget(input.episode_id, project), context?.agent?.toolCallId, tx => {
        const result = saveProjectEpisode(tx, project, input.episode_id, { ...input, revision: input.base_revision })
        return result.error ? { error: result.error } : { kind: 'episode', episodeId: result.episode.id,
          episodeNumber: result.episode.episodeNumber, title: input.title, before: result.episode.scriptContent,
          after: input.script, baseRevision: input.base_revision, revision: result.revision }
      }),
    }),
    create_episode_script: createTool({ id: 'create_episode_script', description: 'Save a complete script as the next episode. Discover its number before creating.',
      inputSchema: z.object({ episode_number: id, title: episodeTitle, script: formattedScript }),
      execute: (input, context) => {
        let imageConfigId: number | null = null
        let videoConfigId: number | null = null
        return write('create_episode_script', { episode_number: input.episode_number, title: input.title }, context?.agent?.toolCallId, tx => {
          if (findBlockingScript(tx, project)) return { error: 'script_conflict' }
          if (nextEpisodeNumber(tx, project) !== input.episode_number) return { error: 'episode_number_conflict' }
          const timestamp = now()
          const episode = tx.insert(episodes).values({ dramaId: project, episodeNumber: input.episode_number,
            title: input.title, scriptContent: input.script, status: 'draft', imageConfigId, videoConfigId,
            resolution: '720p', createdAt: timestamp, updatedAt: timestamp }).returning({ id: episodes.id }).get()
          tx.update(dramas).set({ updatedAt: timestamp }).where(eq(dramas.id, project)).run()
          return { kind: 'episode', episodeId: episode.id, episodeNumber: input.episode_number, title: input.title,
            before: null, after: input.script, revision: timestamp }
        }, async () => {
          [imageConfigId, videoConfigId] = await Promise.all([getActiveConfigId('image'), getActiveConfigId('video')])
        })
      },
    }),
  }
}

function episodeTarget(id: number, project: number) {
  const row = db.transaction(tx => activeEpisode(tx, project, id))
  return { episode_id: id, episode_number: row?.episodeNumber, title: row?.title }
}
