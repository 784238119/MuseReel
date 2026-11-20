import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { and, desc, eq, gte, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { db, schema } from '../db/index.js'
import { getActiveConfigId } from '../services/ai.js'
import { getContentLanguage } from '../services/app-settings.js'
import { launchNovelChatTurn, novelChatMessage } from '../services/novel-chat.js'
import { activeNovelChatTurnFilter, createNovelLease, findNovelProject, jobFields, resolveNovelModel, runNovelJob } from '../services/novels.js'
import { splitManuscript } from '../services/novel-manuscript.js'
import { badRequest, created, notFound, now, serverError, success } from '../utils/response.js'
import novelChat from './novel-chat.js'

const app = new Hono()
app.onError((error, c) => {
  // 数据库异常的消息可能包含创作设定或正文参数。
  console.error('[novels]', c.req.method, c.req.path, error.name)
  return serverError(c)
})
const { novelJobs, novelChapters, novelManuscriptParts, novelChatTurns, episodes } = schema
const modelSelection = z.object({
  config_id: z.number().int().positive(),
  model: z.string().trim().min(1).max(256),
})
const targetLength = z.number().int().min(500).max(5000)
const novelLength = z.number().int().min(500).max(500000)
const episodeCount = z.number().int().min(1).max(100)
const requestFields = z.object({
  request_id: z.string().regex(/^[0-9a-f]{32}$/),
  content_language: z.enum(['zh', 'en', 'ja', 'ko']).optional(),
})
const startFields = requestFields.extend({
  ...modelSelection.shape, episode_count: episodeCount, workflow_mode: z.literal('automatic').optional(),
})
const prepareFields = requestFields.extend({ workflow_mode: z.literal('preview_first') })
const brief = z.string().trim().min(1).max(8000)
const sourceText = z.string().refine(value => !!value.trim())
const startRequest = z.union([
  requestFields.extend({ ...modelSelection.shape, start_mode: z.literal('chat'), message: novelChatMessage.optional() }),
  prepareFields.extend({
    ...modelSelection.shape, source_type: z.literal('ai'), brief, target_length: novelLength,
  }),
  prepareFields.extend({ source_type: z.literal('import'), source_text: sourceText }),
  startFields.extend({ source_type: z.literal('ai').optional(), brief, target_length: targetLength }),
  startFields.extend({ source_type: z.literal('import'), source_text: sourceText }),
])
const splitRequest = modelSelection.extend({ episode_count: episodeCount, draft_revision: z.number().int().nonnegative().optional() })
const MAX_SOURCE_BYTES = 5 * 1024 * 1024
const retryRequest = modelSelection.partial().extend({ target_length: novelLength.optional() })
  .refine(input => (input.config_id === undefined) === (input.model === undefined))

function launch(id: number, runToken: string) {
  void runNovelJob(id, runToken).catch(() => console.error('[novels] Failed to persist task status', id))
}

app.get('/', c => {
  const dramaId = Number(c.req.param('id'))
  if (!findNovelProject(dramaId)) return notFound(c)
  return success(c, db.select(jobFields).from(novelJobs).where(eq(novelJobs.dramaId, dramaId))
    .orderBy(desc(novelJobs.id)).all())
})

app.post('/', bodyLimit({
  // Control characters in pasted text can use six bytes each in JSON.
  maxSize: MAX_SOURCE_BYTES * 6 + 16_384,
  onError: c => badRequest(c, 'source_too_large'),
}), async c => {
  const dramaId = Number(c.req.param('id'))
  const project = findNovelProject(dramaId)
  if (!project) return notFound(c)
  const parsed = startRequest.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return badRequest(c, 'invalid_request')
  const body = parsed.data
  const requestFilter = and(eq(novelJobs.dramaId, dramaId), eq(novelJobs.requestId, body.request_id))
  const existing = db.select(jobFields).from(novelJobs).where(requestFilter).get()
  if (existing) return success(c, existing)
  const chatting = 'start_mode' in body
  const imported = !chatting && body.source_type === 'import'
  if (imported && Buffer.byteLength(body.source_text) > MAX_SOURCE_BYTES) {
    return badRequest(c, 'source_too_large')
  }
  const previewFirst = chatting || body.workflow_mode === 'preview_first'
  const savingDraft = chatting || (previewFirst && imported)
  const configId = 'config_id' in body ? body.config_id : null
  const model = 'model' in body ? body.model : null
  if ((!savingDraft || chatting) && !resolveNovelModel(configId, model)) return badRequest(c, 'model_unavailable')
  const [image, video] = previewFirst ? [null, null] : await Promise.all([
    getActiveConfigId('image'), getActiveConfigId('video'),
  ])
  if (!previewFirst && !image) return badRequest(c, 'image_unavailable')
  if (!previewFirst && !video) return badRequest(c, 'video_unavailable')
  if (!findNovelProject(dramaId)) return notFound(c)

  const timestamp = now()
  const lease = savingDraft ? null : createNovelLease()
  const drafts = imported ? splitManuscript(body.source_text) : []
  const result = db.transaction(tx => {
    const inserted = tx.insert(novelJobs).values({
      dramaId,
      requestId: body.request_id,
      brief: 'brief' in body ? body.brief : '',
      workflowMode: previewFirst ? 'preview_first' : body.workflow_mode,
      sourceType: chatting ? 'ai' : body.source_type ?? 'legacy',
      draftCount: drafts.length,
      draftDone: drafts.length,
      projectContext: JSON.stringify(project),
      configId,
      model,
      episodeCount: previewFirst ? null : body.episode_count,
      targetLength: 'target_length' in body ? body.target_length : (imported && !previewFirst ? 1000 : null),
      contentLanguage: body.content_language ?? getContentLanguage(),
      imageConfigId: image,
      videoConfigId: video,
      status: savingDraft ? 'ready' : 'running',
      ...lease,
      stage: savingDraft ? 'ready' : imported ? 'analyzing' : 'planning',
      createdAt: timestamp,
      updatedAt: timestamp,
    }).onConflictDoNothing().returning(jobFields).get()
    if (!inserted) return null
    for (const [index, draft] of drafts.entries()) {
      tx.insert(novelManuscriptParts).values({ jobId: inserted.id, partNumber: index + 1, draft }).run()
    }
    if (!chatting || !body.message) return { job: inserted }
    const chatLease = createNovelLease()
    const { id } = tx.insert(novelChatTurns).values({ jobId: inserted.id, requestId: body.request_id,
      message: body.message, configId: body.config_id, model: body.model, status: 'running', createdAt: timestamp, ...chatLease,
    }).returning({ id: novelChatTurns.id }).get()
    return { job: inserted, firstTurn: { id, runToken: chatLease.runToken } }
  }, { behavior: 'immediate' })
  if (!result) {
    const sameRequest = db.select(jobFields).from(novelJobs).where(requestFilter).get()
    if (sameRequest) return success(c, sameRequest)
    return c.json({ code: 409, message: 'job_running' }, 409)
  }
  const { job, firstTurn } = result
  if (firstTurn) launchNovelChatTurn(firstTurn.id, firstTurn.runToken)
  if (lease) launch(job.id, lease.runToken)
  return created(c, job)
})

app.get('/:jobId', c => {
  const dramaId = Number(c.req.param('id'))
  const id = Number(c.req.param('jobId'))
  if (!findNovelProject(dramaId)) return notFound(c)
  const job = db.select(jobFields).from(novelJobs)
    .where(and(eq(novelJobs.dramaId, dramaId), eq(novelJobs.id, id))).get()
  if (!job) return notFound(c)
  const chapters = job.episode_count !== null && job.completed_chapters >= job.episode_count ? db.select({
    chapter_number: novelChapters.chapterNumber,
    title: novelChapters.title,
    episode_number: episodes.episodeNumber,
    episode_id: episodes.id,
  }).from(novelChapters).leftJoin(episodes, and(
    eq(episodes.id, novelChapters.episodeId), isNull(episodes.deletedAt),
  )).where(eq(novelChapters.jobId, id)).orderBy(novelChapters.chapterNumber).all() : []
  return success(c, { ...job, chapters })
})

app.get('/:jobId/chapters/:chapterNumber', c => {
  const dramaId = Number(c.req.param('id'))
  const jobId = Number(c.req.param('jobId'))
  const number = Number(c.req.param('chapterNumber'))
  if (!findNovelProject(dramaId)) return notFound(c)
  const chapter = db.select({
    chapter_number: novelChapters.chapterNumber,
    title: novelChapters.title,
    content: novelChapters.content,
  }).from(novelChapters).innerJoin(novelJobs, eq(novelJobs.id, novelChapters.jobId))
    .where(and(eq(novelJobs.dramaId, dramaId), gte(novelJobs.completedChapters, novelJobs.episodeCount),
      eq(novelChapters.jobId, jobId), eq(novelChapters.chapterNumber, number))).get()
  return chapter ? success(c, chapter) : notFound(c)
})

app.get('/:jobId/manuscripts/:version/:partNumber', c => {
  const dramaId = Number(c.req.param('id'))
  const jobId = Number(c.req.param('jobId'))
  const partNumber = Number(c.req.param('partNumber'))
  const version = c.req.param('version')
  if (!findNovelProject(dramaId) || !['draft', 'optimized'].includes(version)) return notFound(c)
  const done = version === 'draft' ? novelJobs.draftDone : novelJobs.optimizedDone
  const part = db.select({
    content: version === 'draft' ? novelManuscriptParts.draft : novelManuscriptParts.optimized,
  }).from(novelManuscriptParts).innerJoin(novelJobs, eq(novelJobs.id, novelManuscriptParts.jobId))
    .where(and(eq(novelJobs.dramaId, dramaId), eq(novelJobs.id, jobId), eq(novelManuscriptParts.partNumber, partNumber),
      gte(done, novelJobs.draftCount))).get()
  return part?.content == null ? notFound(c) : success(c, part)
})

function canStartSplit(job: typeof novelJobs.$inferSelect) {
  return job.workflowMode === 'preview_first' && (job.status === 'ready'
    || (job.status === 'failed' && job.errorCode === 'manuscript_too_short' && job.completedChapters === 0))
}

app.post('/:jobId/split', async c => {
  const dramaId = Number(c.req.param('id'))
  const id = Number(c.req.param('jobId'))
  if (!findNovelProject(dramaId)) return notFound(c)
  const filter = and(eq(novelJobs.dramaId, dramaId), eq(novelJobs.id, id))
  const existing = db.select().from(novelJobs).where(filter).get()
  if (!existing) return notFound(c)
  if (existing.workflowMode !== 'preview_first' || !existing.draftCount || existing.draftDone !== existing.draftCount) {
    return badRequest(c, 'draft_not_ready')
  }
  const parsed = splitRequest.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return badRequest(c, 'invalid_request')
  const { config_id, model, episode_count, draft_revision = existing.draftRevision } = parsed.data
  if (!canStartSplit(existing)) return success(c, db.select(jobFields).from(novelJobs).where(filter).get())
  const [image, video] = await Promise.all([getActiveConfigId('image'), getActiveConfigId('video')])
  if (!findNovelProject(dramaId)) return notFound(c)
  const result = db.transaction(tx => {
    const current = tx.select().from(novelJobs).where(filter).get()
    if (!current) return {}
    if (!canStartSplit(current)) return { job: tx.select(jobFields).from(novelJobs).where(filter).get() }
    if (current.draftRevision !== draft_revision) return { staleDraft: true }
    if (current.errorCode === 'manuscript_too_short' && current.episodeCount !== null
      && episode_count >= current.episodeCount) return { error: 'manuscript_too_short' }
    const running = tx.select({ id: novelJobs.id }).from(novelJobs)
      .where(and(eq(novelJobs.dramaId, dramaId), eq(novelJobs.status, 'running'))).get()
    if (running) return { conflict: true }
    const runningChat = tx.select({ id: novelChatTurns.id }).from(novelChatTurns).where(activeNovelChatTurnFilter(id)).get()
    if (runningChat) return { chatRunning: true }
    if (!resolveNovelModel(config_id, model)) return { error: 'model_unavailable' }
    if (!image) return { error: 'image_unavailable' }
    if (!video) return { error: 'video_unavailable' }
    const lease = createNovelLease()
    const job = tx.update(novelJobs).set({
      status: 'running', stage: current.optimizedDone === current.draftCount ? 'splitting' : 'analyzing',
      episodeCount: episode_count, configId: config_id, model,
      imageConfigId: image, videoConfigId: video,
      errorCode: null, updatedAt: now(), ...lease,
    }).where(filter).returning(jobFields).get()
    return { job, runToken: lease.runToken }
  }, { behavior: 'immediate' })
  if (result.conflict) return c.json({ code: 409, message: 'job_running' }, 409)
  if (result.chatRunning) return c.json({ code: 409, message: 'chat_running' }, 409)
  if (result.staleDraft) return c.json({ code: 409, message: 'draft_changed' }, 409)
  if (result.error) return badRequest(c, result.error)
  if (!result.job) return notFound(c)
  if (result.runToken) launch(id, result.runToken)
  return success(c, result.job)
})

app.post('/:jobId/retry', async c => {
  const dramaId = Number(c.req.param('id'))
  const id = Number(c.req.param('jobId'))
  if (!findNovelProject(dramaId)) return notFound(c)
  const filter = and(eq(novelJobs.dramaId, dramaId), eq(novelJobs.id, id))
  const raw = await c.req.text()
  let input: unknown = {}
  if (raw.trim()) {
    try { input = JSON.parse(raw) } catch { return badRequest(c, 'invalid_request') }
  }
  const parsed = retryRequest.safeParse(input)
  if (!parsed.success) return badRequest(c, 'invalid_request')
  const { config_id, model, target_length } = parsed.data
  if (!findNovelProject(dramaId)) return notFound(c)
  const result = db.transaction(tx => {
    const current = tx.select(jobFields).from(novelJobs).where(filter).get()
    if (!current) return {}
    if (!['failed', 'interrupted'].includes(current.status)) return { job: current }
    const running = tx.select({ id: novelJobs.id }).from(novelJobs)
      .where(and(eq(novelJobs.dramaId, dramaId), eq(novelJobs.status, 'running'))).get()
    if (running) return { conflict: true }
    const runningChat = tx.select({ id: novelChatTurns.id }).from(novelChatTurns).where(activeNovelChatTurnFilter(id)).get()
    if (runningChat) return { chatRunning: true }
    const writing = current.episode_count === null || current.completed_chapters < current.episode_count
    const canChangeLength = current.target_length !== null && (current.source_type === 'legacy'
      || ['planning', 'writing'].includes(current.stage))
    if (writing && target_length !== undefined
      && (!canChangeLength || target_length > (current.target_length ?? 0))) return { invalid: true }
    if (writing && !resolveNovelModel(config_id ?? current.config_id, model ?? current.model)) {
      return { unavailable: true }
    }
    const lease = createNovelLease()
    const job = tx.update(novelJobs).set({
      status: 'running',
      errorCode: null,
      updatedAt: now(),
      ...lease,
      ...(writing ? { configId: config_id, model, targetLength: target_length } : {}),
    })
      .where(filter).returning(jobFields).get()
    return { job, runToken: lease.runToken }
  }, { behavior: 'immediate' })
  if (result.conflict) return c.json({ code: 409, message: 'job_running' }, 409)
  if (result.chatRunning) return c.json({ code: 409, message: 'chat_running' }, 409)
  if (result.invalid) return badRequest(c, 'invalid_request')
  if (result.unavailable) return badRequest(c, 'model_unavailable')
  if (!result.job) return notFound(c)
  if (result.runToken) launch(id, result.runToken)
  return success(c, result.job)
})

app.route('/:jobId/chat/turns', novelChat)

export default app
