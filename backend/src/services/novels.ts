import { Agent } from '@mastra/core/agent'
import { randomUUID } from 'node:crypto'
import { and, eq, gt, isNotNull, isNull, lte, or } from 'drizzle-orm'
import { z } from 'zod'
import { createTextModel } from '../agents/index.js'
import { buildLanguageDirective } from '../agents/language.js'
import { NOVEL_PROMPTS, type NovelPromptType } from '../agents/novel-prompts.js'
import { loadAgentPromptFile } from '../agents/prompts.js'
import { loadAgentSkills } from '../agents/skills.js'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { getConfigById, parseConfigModels } from './ai.js'
import { nextEpisodeNumber } from './episode-number.js'
import { optimizeAndSplit } from './novel-manuscript.js'

const { novelJobs, novelChapters, novelManuscriptParts, novelChatTurns, dramas, episodes, aiServiceConfigs } = schema
type Job = typeof novelJobs.$inferSelect
type Generate = (prompt: string) => Promise<string>
const shortText = (max: number) => z.string().max(max).refine(value => value.trim().length > 0)
const outlineItem = z.object({
  chapter_number: z.number().int(),
  beats: shortText(900),
})
const chapterResult = z.object({
  title: shortText(160),
  content: shortText(30000),
  summary: shortText(3000),
})
const PLAN_BATCH_SIZE = 10
const LEASE_DURATION = 60_000
const LEASE_CHECK_INTERVAL = 15_000
export const clearNovelLease = { runToken: null, leaseExpiresAt: null }

export const jobFields = {
  id: novelJobs.id,
  status: novelJobs.status,
  stage: novelJobs.stage,
  workflow_mode: novelJobs.workflowMode,
  source_type: novelJobs.sourceType,
  draft_count: novelJobs.draftCount,
  draft_done: novelJobs.draftDone,
  draft_revision: novelJobs.draftRevision,
  optimized_done: novelJobs.optimizedDone,
  model: novelJobs.model,
  config_id: novelJobs.configId,
  target_length: novelJobs.targetLength,
  completed_chapters: novelJobs.completedChapters,
  episode_count: novelJobs.episodeCount,
  error_code: novelJobs.errorCode,
  created_at: novelJobs.createdAt,
}

export function findNovelProject(dramaId: number) {
  return db.select({ title: dramas.title, description: dramas.description, genre: dramas.genre })
    .from(dramas).where(and(eq(dramas.id, dramaId), isNull(dramas.deletedAt))).get()
}

export function resolveNovelModel(configId: number | null, model: string | null) {
  if (!configId || !model) return null
  const row = db.select({ serviceType: aiServiceConfigs.serviceType, models: aiServiceConfigs.model })
    .from(aiServiceConfigs).where(eq(aiServiceConfigs.id, configId)).get()
  if (row?.serviceType !== 'text') return null
  if (!parseConfigModels(row.models).includes(model)) return null
  return getConfigById(configId)
}

export function createNovelLease() {
  return { runToken: randomUUID(), leaseExpiresAt: Date.now() + LEASE_DURATION }
}

export function maintainNovelLease(expiresAt: number, renew: (deadline: number) => boolean) {
  const lease = new AbortController()
  const heartbeat = setInterval(() => {
    if (lease.signal.aborted) return
    try {
      const deadline = Date.now() + LEASE_DURATION
      if (renew(deadline)) expiresAt = deadline
      else lease.abort()
    } catch {
      if (Date.now() >= expiresAt) lease.abort()
    }
  }, LEASE_CHECK_INTERVAL).unref()
  return { signal: lease.signal, stop: () => clearInterval(heartbeat) }
}

export function recoverExpiredNovelChatTurns(jobId?: number) {
  db.update(novelChatTurns).set({ status: 'interrupted', errorCode: 'interrupted', ...clearNovelLease })
    .where(and(jobId === undefined ? undefined : eq(novelChatTurns.jobId, jobId),
      eq(novelChatTurns.status, 'running'), or(isNull(novelChatTurns.runToken),
        isNull(novelChatTurns.leaseExpiresAt), lte(novelChatTurns.leaseExpiresAt, Date.now())))).run()
}

export function activeNovelChatTurnFilter(jobId: number) {
  return and(eq(novelChatTurns.jobId, jobId), eq(novelChatTurns.status, 'running'),
    isNotNull(novelChatTurns.runToken), gt(novelChatTurns.leaseExpiresAt, Date.now()))
}

export function recoverExpiredNovelJobs() {
  db.update(novelJobs).set({
    status: 'interrupted',
    errorCode: 'interrupted',
    updatedAt: now(),
    ...clearNovelLease,
  }).where(and(eq(novelJobs.status, 'running'), or(
    isNull(novelJobs.runToken), isNull(novelJobs.leaseExpiresAt), lte(novelJobs.leaseExpiresAt, Date.now()),
  ))).run()
}

export function startNovelRecovery() {
  const recover = () => {
    try {
      recoverExpiredNovelJobs()
      recoverExpiredNovelChatTurns()
    } catch { console.warn('[novels] Could not recover expired jobs or chat turns') }
  }
  recover()
  setInterval(recover, LEASE_CHECK_INTERVAL).unref()
}

function ownedJob(id: number, runToken: string) {
  return and(eq(novelJobs.id, id), eq(novelJobs.status, 'running'),
    eq(novelJobs.runToken, runToken), gt(novelJobs.leaseExpiresAt, Date.now()))
}

class LeaseLost extends Error {}
class NovelError extends Error {}

function parseResult<T>(value: string, format: z.ZodType<T>): T {
  try {
    const json = value.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1')
    return format.parse(JSON.parse(json))
  } catch {
    throw new NovelError('invalid_output')
  }
}

function updateJob(id: number, runToken: string, values: Partial<Job>) {
  const result = db.update(novelJobs).set({ ...values, updatedAt: now() })
    .where(ownedJob(id, runToken)).run()
  if (result.changes !== 1) throw new LeaseLost()
}

async function makeGenerator(job: Job, leaseSignal: AbortSignal, type: NovelPromptType): Promise<Generate> {
  const config = resolveNovelModel(job.configId, job.model)
  if (!config || !job.model) throw new NovelError('model_unavailable')
  const legacy = job.sourceType === 'legacy'
  const [custom, skills] = legacy ? [null, ''] as const : await Promise.all([
    loadAgentPromptFile(type, job.contentLanguage),
    loadAgentSkills(type, job.contentLanguage),
  ])
  const agent = new Agent({
    id: type,
    name: NOVEL_PROMPTS[type].name,
    maxRetries: 0,
    model: createTextModel(config, job.model),
    instructions: [
      legacy ? '你在创作一部完整、连续、由多章组成的小说，每章将作为一集的原文。'
        : custom?.instructions ?? NOVEL_PROMPTS[type].instructions,
      skills,
      '严格按请求返回合法 JSON。',
      ...(job.sourceType === 'import' ? [] : [buildLanguageDirective(job.contentLanguage)]),
    ].filter(Boolean).join('\n'),
  })
  return async prompt => {
    const timeout = AbortSignal.timeout(300_000)
    const signal = AbortSignal.any([leaseSignal, timeout])
    try {
      const result = await agent.generate(prompt, { maxSteps: 1, abortSignal: signal })
      if (result.finishReason === 'length') throw new NovelError('truncated')
      if (result.finishReason !== 'stop') throw new NovelError('generation_failed')
      return result.text
    } catch (error) {
      if (leaseSignal.aborted) throw new LeaseLost()
      if (timeout.aborted) throw new NovelError('timeout')
      if (error instanceof NovelError) throw error
      throw new NovelError('generation_failed')
    }
  }
}

function publish(job: Job, runToken: string) {
  const { episodeCount, imageConfigId, videoConfigId } = job
  if (!episodeCount || !imageConfigId || !videoConfigId) throw new NovelError('publish_failed')
  db.transaction(tx => {
    const finished = tx.update(novelJobs).set({ status: 'completed', updatedAt: now(), ...clearNovelLease })
      .where(ownedJob(job.id, runToken)).run()
    if (finished.changes !== 1) throw new LeaseLost()
    const project = tx.select({ id: dramas.id }).from(dramas)
      .where(and(eq(dramas.id, job.dramaId), isNull(dramas.deletedAt))).get()
    if (!project) throw new NovelError('project_unavailable')
    const chapters = tx.select().from(novelChapters).where(eq(novelChapters.jobId, job.id))
      .orderBy(novelChapters.chapterNumber).all()
    if (chapters.length !== episodeCount || chapters.some(chapter => chapter.episodeId !== null)) {
      throw new NovelError('publish_failed')
    }
    const firstNumber = nextEpisodeNumber(tx, job.dramaId)
    const timestamp = now()
    for (const chapter of chapters) {
      const episode = tx.insert(episodes).values({
        dramaId: job.dramaId,
        episodeNumber: firstNumber + chapter.chapterNumber - 1,
        title: chapter.title,
        content: chapter.content,
        imageConfigId,
        videoConfigId,
        resolution: '720p',
        createdAt: timestamp,
        updatedAt: timestamp,
      }).returning({ id: episodes.id }).get()
      tx.update(novelChapters).set({ episodeId: episode.id }).where(and(
        eq(novelChapters.jobId, job.id), eq(novelChapters.chapterNumber, chapter.chapterNumber),
      )).run()
    }
    tx.update(dramas).set({ updatedAt: timestamp }).where(eq(dramas.id, job.dramaId)).run()
  }, { behavior: 'immediate' })
}

async function writeDraft(job: Job, generate: Generate, checkpoint: Parameters<typeof optimizeAndSplit>[4]) {
  const { id } = job
  const legacy = job.sourceType === 'legacy'
  const brief = JSON.stringify({ project: JSON.parse(job.projectContext), brief: job.brief })
  const automaticEpisodeCount = job.episodeCount ?? 0
  if (!job.targetLength || (job.workflowMode === 'automatic' && !automaticEpisodeCount)) {
    throw new NovelError('invalid_request')
  }
  const totalLength = job.targetLength * (job.workflowMode === 'automatic' ? automaticEpisodeCount : 1)
  const minimum = Math.max(1, Math.ceil(totalLength / 5000))
  const maximum = Math.min(150, Math.max(minimum, Math.ceil(totalLength / 800)))
  if (!legacy && !job.storyPlan) {
    const result = parseResult(await generate([
      brief,
      `规划一部篇幅约 ${totalLength} 字（英语按词计）的完整小说，覆盖起因、发展和明确结局。`,
      `根据故事结构决定章节数，范围为 ${minimum} 至 ${maximum} 章。`,
      '仅返回 JSON {"plan":"全书人物与故事规划，最多4000字","chapter_count":章节数}。',
    ].join('\n')), z.object({ plan: shortText(4000), chapter_count: z.number().int().min(minimum).max(maximum) }))
    checkpoint({ storyPlan: result.plan, draftCount: result.chapter_count })
  }
  const chapterCount = legacy ? automaticEpisodeCount : job.draftCount
  const counts = `共 ${chapterCount} 章，每章目标篇幅 ${Math.ceil(totalLength / chapterCount)} 字（英语按词数）。`
  const plan = job.storyPlan ?? parseResult(await generate([
    counts, brief, '策划完整的故事设定、人物关系、分阶段主线与明确结局。',
    '仅返回 JSON 对象 {"plan":"完整故事规划"}，plan 不超过 4000 字。',
  ].join('\n')), z.object({ plan: shortText(4000) })).plan
  if (!job.storyPlan) checkpoint({ storyPlan: plan })
  const outline: z.infer<typeof outlineItem>[] = JSON.parse(job.outline ?? '[]')
  for (let first = outline.length + 1; first <= chapterCount; first += PLAN_BATCH_SIZE) {
    if (!findNovelProject(job.dramaId)) throw new NovelError('project_unavailable')
    const last = Math.min(first + PLAN_BATCH_SIZE - 1, chapterCount)
    const batch = parseResult(await generate([
      counts, brief, plan,
      `上一批结尾提纲：${JSON.stringify(outline.slice(-3))}`,
      `仅规划第 ${first} 至 ${last} 章。按全书主线分配情节，最后一章完成结局。`,
      '返回 JSON 对象 {"chapters":[{"chapter_number":章号,"beats":"本章事件与衔接点"}]}。',
    ].join('\n')), z.object({ chapters: z.array(outlineItem).length(last - first + 1) })).chapters
    if (batch.some((item, i) => item.chapter_number !== first + i)) throw new NovelError('invalid_output')
    outline.push(...batch)
    checkpoint({ outline: JSON.stringify(outline) })
  }
  checkpoint({ stage: 'writing' })
  const done = legacy ? job.completedChapters : job.draftDone
  let previous = legacy ? db.select({ content: novelChapters.content, summary: novelChapters.summary }).from(novelChapters)
    .where(and(eq(novelChapters.jobId, id), eq(novelChapters.chapterNumber, job.completedChapters))).get()
    : db.select({ content: novelManuscriptParts.draft, summary: novelManuscriptParts.summary }).from(novelManuscriptParts)
      .where(and(eq(novelManuscriptParts.jobId, id), eq(novelManuscriptParts.partNumber, done))).get()
  for (let number = done + 1; number <= chapterCount; number++) {
    if (!findNovelProject(job.dramaId)) throw new NovelError('project_unavailable')
    const chapter = parseResult(await generate([
      counts, brief, plan,
      `全书进展摘要：${previous?.summary ?? ''}`,
      `上一章结尾：${previous?.content.slice(-1600) ?? ''}`,
      `本章提纲：${outline[number - 1].beats}`,
      `下一章提纲：${outline[number]?.beats ?? '本章完结全书'}`,
      `只写第 ${number} 章的小说正文，完整收束本章，保持与前文连续。`,
      '返回 JSON 对象 {"title":"章标题","content":"完整正文，保留段落换行","summary":"截至本章的滚动摘要"}。',
      '摘要不超过 3000 字，保留关键人物状态、因果、时间线和待解决伏笔。',
    ].join('\n')), chapterResult)
    checkpoint(legacy ? { completedChapters: number } : { draftDone: number }, tx => {
      if (legacy) tx.insert(novelChapters).values({ jobId: id, chapterNumber: number, ...chapter }).run()
      else tx.insert(novelManuscriptParts).values({
        jobId: id, partNumber: number, summary: chapter.summary,
        draft: `# ${chapter.title.trim()}\n\n${chapter.content.trim()}${number < chapterCount ? '\n\n' : ''}`,
      }).run()
    })
    previous = chapter
  }
}

export async function runNovelJob(id: number, runToken: string) {
  const job = db.select().from(novelJobs).where(ownedJob(id, runToken)).get()
  if (!job || job.leaseExpiresAt === null) return
  const lease = maintainNovelLease(job.leaseExpiresAt, deadline =>
    db.update(novelJobs).set({ leaseExpiresAt: deadline }).where(ownedJob(id, runToken)).run().changes === 1)
  let stage = job.stage
  const checkpoint: Parameters<typeof optimizeAndSplit>[4] = (values, write) => {
    db.transaction(tx => {
      const result = tx.update(novelJobs).set({ ...values, updatedAt: now() }).where(ownedJob(id, runToken)).run()
      if (result.changes !== 1) throw new LeaseLost()
      write?.(tx)
    }, { behavior: 'immediate' })
    Object.assign(job, values)
    stage = job.stage
  }
  try {
    if (!findNovelProject(job.dramaId)) throw new NovelError('project_unavailable')
    if (job.workflowMode === 'preview_first' && job.episodeCount === null) {
      if (!job.draftCount || job.draftDone < job.draftCount) {
        const generate = await makeGenerator(job, lease.signal, 'novel_writer')
        await writeDraft(job, generate, checkpoint)
      }
      updateJob(id, runToken, { status: 'ready', stage: 'ready', ...clearNovelLease })
      return
    }
    const episodeCount = job.episodeCount
    if (!episodeCount) throw new NovelError('invalid_request')
    if (job.completedChapters < episodeCount) {
      const generate = await makeGenerator(job, lease.signal, 'novel_writer')
      const legacy = job.sourceType === 'legacy'
      if (legacy || (job.sourceType === 'ai' && (!job.draftCount || job.draftDone < job.draftCount))) {
        await writeDraft(job, generate, checkpoint)
      }
      if (!legacy) {
        const split = await makeGenerator(job, lease.signal, 'novel_splitter')
        await optimizeAndSplit({ ...job, episodeCount }, generate, split, parseResult, checkpoint, code => { throw new NovelError(code) })
      }
    }
    stage = 'publishing'
    updateJob(id, runToken, { stage })
    publish(job, runToken)
  } catch (error) {
    if (error instanceof LeaseLost) return
    const code = error instanceof NovelError ? error.message
      : stage === 'publishing' ? 'publish_failed' : 'generation_failed'
    try {
      updateJob(id, runToken, { status: 'failed', errorCode: code, ...clearNovelLease })
    } catch (persistError) {
      if (!(persistError instanceof LeaseLost)) throw persistError
    }
  } finally {
    lease.stop()
  }
}
