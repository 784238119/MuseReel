import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { and, desc, eq, gt, lt, lte } from 'drizzle-orm'
import { z } from 'zod'
import { db, schema } from '../db/index.js'
import {
  applyNovelChatProposal, canEditNovelDraft, findNovelChatJob, launchNovelChatTurn, novelChatMessage, novelChatTurnFields,
} from '../services/novel-chat.js'
import { activeNovelChatTurnFilter, createNovelLease, recoverExpiredNovelChatTurns, resolveNovelModel } from '../services/novels.js'
import { badRequest, created, notFound, now, serverError, success } from '../utils/response.js'

const app = new Hono()
const { novelChatTurns: turns } = schema
const PAGE_SIZE = 16
const modelFields = z.object({ config_id: z.number().int().positive().optional(),
  model: z.string().trim().min(1).max(256).optional() })
const pairedModel = (input: z.infer<typeof modelFields>) => (input.config_id === undefined) === (input.model === undefined)
const sendRequest = modelFields.extend({
  request_id: z.string().regex(/^[0-9a-f]{32}$/), message: novelChatMessage,
}).refine(pairedModel)
const retryRequest = modelFields.refine(pairedModel)

app.onError((error, c) => {
  console.error('[novel-chat]', c.req.method, c.req.path, error.name)
  return serverError(c)
})
app.use('*', bodyLimit({ maxSize: 50_000, onError: c => badRequest(c, 'invalid_request') }))

function scopedJob(c: Context) {
  return findNovelChatJob(Number(c.req.param('id')), Number(c.req.param('jobId')))
}

function runningTurn(jobId: number) {
  return db.select(novelChatTurnFields).from(turns)
    .where(activeNovelChatTurnFilter(jobId)).get()
}

app.get('/', c => {
  const job = scopedJob(c)
  if (!job) return notFound(c)
  const cursor = c.req.query('before_id')
  const before = cursor === undefined ? null : Number(cursor)
  if (before !== null && (!Number.isSafeInteger(before) || before < 1)) return badRequest(c, 'invalid_request')
  const revision = c.req.query('after_revision')
  const afterRevision = revision === undefined ? null : Number(revision)
  if (afterRevision !== null && (!Number.isSafeInteger(afterRevision) || afterRevision < 0)) return badRequest(c, 'invalid_request')
  recoverExpiredNovelChatTurns(job.id)
  const latest = db.select(novelChatTurnFields).from(turns)
    .where(and(eq(turns.jobId, job.id), before === null ? undefined : lt(turns.id, before)))
    .orderBy(desc(turns.id)).limit(PAGE_SIZE + 1).all()
  const page = latest.slice(0, PAGE_SIZE)
  const appliedTurns = afterRevision !== null && afterRevision < job.draftRevision
    ? db.select({ id: turns.id, applied_at: turns.appliedAt }).from(turns).where(and(
      eq(turns.jobId, job.id), gt(turns.appliedRevision, afterRevision), lte(turns.appliedRevision, job.draftRevision),
    )).all() : []
  return success(c, {
    turns: page, before_id: latest.length > PAGE_SIZE ? page.at(-1)!.id : null,
    active_turn: runningTurn(job.id) ?? null, story_plan: job.storyPlan, draft_revision: job.draftRevision,
    applied_turns: appliedTurns,
  })
})

app.post('/', async c => {
  const parsed = sendRequest.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return badRequest(c, 'invalid_request')
  const { request_id, message, config_id, model } = parsed.data
  // All checks and the claim are synchronous. No network calls run inside this transaction.
  const result = db.transaction(tx => {
    const job = scopedJob(c)
    if (!job) return null
    const existing = tx.select(novelChatTurnFields).from(turns)
      .where(and(eq(turns.jobId, job.id), eq(turns.requestId, request_id))).get()
    if (existing) return { turn: existing }
    if (!canEditNovelDraft(job)) return { error: 'novel_locked' }
    recoverExpiredNovelChatTurns(job.id)
    if (runningTurn(job.id)) return { error: 'chat_running' }
    const configId = config_id ?? job.configId
    const modelName = model ?? job.model
    if (configId === null || !modelName || !resolveNovelModel(configId, modelName)) return { error: 'model_unavailable' }
    const lease = createNovelLease()
    const turn = tx.insert(turns).values({ jobId: job.id, requestId: request_id,
      message, configId, model: modelName, status: 'running', createdAt: now(), ...lease,
    }).returning(novelChatTurnFields).get()
    return { turn, runToken: lease.runToken }
  }, { behavior: 'immediate' })
  if (!result) return notFound(c)
  if (result.error === 'model_unavailable') return badRequest(c, result.error)
  if (result.error) return c.json({ code: 409, message: result.error }, 409)
  if (!result.runToken) return success(c, result.turn)
  launchNovelChatTurn(result.turn!.id, result.runToken)
  return created(c, result.turn)
})

app.post('/:turnId/retry', async c => {
  const raw = await c.req.text()
  let input: unknown = {}
  if (raw.trim()) {
    try { input = JSON.parse(raw) } catch { return badRequest(c, 'invalid_request') }
  }
  const parsed = retryRequest.safeParse(input)
  if (!parsed.success) return badRequest(c, 'invalid_request')
  const result = db.transaction(tx => {
    const job = scopedJob(c)
    if (!job) return null
    recoverExpiredNovelChatTurns(job.id)
    const filter = and(eq(turns.jobId, job.id), eq(turns.id, Number(c.req.param('turnId'))))
    const turn = tx.select(novelChatTurnFields).from(turns).where(filter).get()
    if (!turn) return null
    if (turn.status !== 'failed' && turn.status !== 'interrupted') return { turn }
    const newer = tx.select({ id: turns.id }).from(turns)
      .where(and(eq(turns.jobId, job.id), gt(turns.id, turn.id))).get()
    if (newer) return { error: 'turn_superseded' }
    if (!canEditNovelDraft(job)) return { error: 'novel_locked' }
    if (runningTurn(job.id)) return { error: 'chat_running' }
    const configId = parsed.data.config_id ?? turn.config_id
    const model = parsed.data.model ?? turn.model
    if (!resolveNovelModel(configId, model)) return { error: 'model_unavailable' }
    const lease = createNovelLease()
    const updated = tx.update(turns).set({ status: 'running', errorCode: null, configId, model, ...lease })
      .where(filter).returning(novelChatTurnFields).get()
    return { turn: updated, runToken: lease.runToken }
  }, { behavior: 'immediate' })
  if (!result) return notFound(c)
  if (result.error === 'model_unavailable') return badRequest(c, result.error)
  if (result.error) return c.json({ code: 409, message: result.error }, 409)
  if (result.runToken) launchNovelChatTurn(result.turn!.id, result.runToken)
  return success(c, result.turn)
})

app.post('/:turnId/apply', c => {
  const result = applyNovelChatProposal(Number(c.req.param('id')), Number(c.req.param('jobId')), Number(c.req.param('turnId')))
  if (!result) return notFound(c)
  if (result.error === 'invalid_edit') return badRequest(c, result.error)
  if (result.error) return c.json({ code: 409, message: result.error }, 409)
  return success(c, result)
})

export default app
