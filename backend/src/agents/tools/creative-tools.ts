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
import { now } from '../../utils/response.js'

const { dramas, episodes, projectScripts, scriptJobs, novelJobs, novelManuscriptParts, novelChapters,
  creativeTurns, creativeChanges } = schema
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

const materialNovels = (projectId: number) => and(eq(novelJobs.dramaId, projectId), sql`(
  (${novelJobs.draftCount} > 0 AND ${novelJobs.draftDone} = ${novelJobs.draftCount}) OR
  (${novelJobs.sourceType} = 'legacy' AND ${novelJobs.episodeCount} > 0 AND ${novelJobs.completedChapters} = ${novelJobs.episodeCount}))`)

export function creativeMaterials(projectId: number, afterEpisode = 0, query?: string) {
  const catalogue = db.select({ id: episodes.id, number: episodes.episodeNumber, title: episodes.title }).from(episodes)
    .where(and(eq(episodes.dramaId, projectId), isNull(episodes.deletedAt), gt(episodes.episodeNumber, afterEpisode),
      query ? sql`instr(lower(${episodes.title}), lower(${query})) > 0` : undefined))
    .orderBy(episodes.episodeNumber).limit(61).all()
  const novels = db.select({ id: novelJobs.id, title: sql<string>`substr(${novelJobs.brief}, 1, 80)`, created_at: novelJobs.createdAt }).from(novelJobs)
    .where(and(materialNovels(projectId), query ? sql`instr(lower(${novelJobs.brief}), lower(${query})) > 0` : undefined))
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
    .where(and(materialNovels(projectId), eq(novelJobs.id, reference.id ?? 0))).get()
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
    run.finish(key, typeof result.error === 'string' ? result.error : undefined,
      typeof result.episode_id === 'number' ? { episode_id: result.episode_id, episode_number: result.episode_number } : undefined)
    return result
  }
  async function write(tool: string, target: Record<string, unknown>, callId: string | undefined,
    action: (tx: ScriptTransaction) => Change | { error: string }, prepare?: () => Promise<void>) {
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
    if (prepare) await prepare()
    return run.commit(key, action)
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
    read_novel_manuscript: createTool({ id: 'read_novel_manuscript', description: 'Read a part of a novel in this project.',
      inputSchema: z.object({ novel_id: id, part_number: id, offset }),
      execute: (input, context) => read('read_novel_manuscript', { novel_id: input.novel_id, part_number: input.part_number },
        context?.agent?.toolCallId, () => {
          const job = db.select().from(novelJobs).where(and(materialNovels(project), eq(novelJobs.id, input.novel_id))).get()
          if (!job) return { error: 'not_found' }
          const part = job.draftCount > 0 ? db.select({ content: novelManuscriptParts.draft }).from(novelManuscriptParts)
            .where(and(eq(novelManuscriptParts.jobId, job.id), eq(novelManuscriptParts.partNumber, input.part_number))).get()
            : db.select({ content: novelChapters.content }).from(novelChapters)
              .where(and(eq(novelChapters.jobId, job.id), eq(novelChapters.chapterNumber, input.part_number))).get()
          return part ? { part_number: input.part_number, part_count: job.draftCount || job.completedChapters,
            ...excerpt(part.content, input.offset ?? 0) } : { error: 'not_found' }
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
