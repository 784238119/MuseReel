import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { streamSSE } from 'hono/streaming'
import { and, asc, desc, eq, gt, inArray, lt } from 'drizzle-orm'
import { z } from 'zod'
import { creativeMaterials, creativeReferenceExists } from '../agents/tools/creative-tools.js'
import { db, schema } from '../db/index.js'
import { getActiveConfig } from '../services/ai.js'
import { getContentLanguage } from '../services/app-settings.js'
import { changeFields, creativeEventFields, creativeTurnFields, launchCreativeTurn, recoverCreativeTurns,
  stopCreativeTurn } from '../services/creative-agent.js'
import { createNovelLease, resolveNovelModel } from '../services/novels.js'
import { activeProject } from '../services/project-scripts.js'
import { badRequest, created, notFound, now, serverError, success } from '../utils/response.js'

const app = new Hono()
const { creativeSessions: sessions, creativeTurns: turns, creativeEvents: events, creativeChanges: changes } = schema
const id = z.number().int().positive()
const offset = z.coerce.number().int().safe().nonnegative()
const pageSize = 20
const title = z.string().trim().min(1).max(120)
const sessionFields = { id: sessions.id, title: sessions.title, updated_at: sessions.updatedAt }
const ref = z.discriminatedUnion('kind', [z.object({ kind: z.literal('episode'), id, scene: z.string().regex(/^S\d+$/i).optional() }),
  z.object({ kind: z.literal('novel'), id }), z.object({ kind: z.literal('source') })])
const turnRequest = z.object({ session_id: id.optional(), resume_from_id: id.optional(), request_id: z.string().regex(/^[a-f\d]{32}$/),
  message: z.string().trim().min(1).max(8000), references: z.array(ref).max(10).default([]),
  config_id: id.optional(), model: z.string().trim().min(1).max(256).optional(),
}).refine(input => (input.config_id === undefined) === (input.model === undefined))
  .refine(input => input.resume_from_id === undefined || input.session_id !== undefined)

app.onError((error, c) => {
  console.error('[creative-agent]', c.req.method, c.req.path, error.name)
  return serverError(c)
})
app.use('*', bodyLimit({ maxSize: 65_000, onError: c => badRequest(c, 'invalid_request') }))
app.use('*', async (c, next) => {
  if (!activeProject(Number(c.req.param('id')))) return notFound(c)
  await next()
})

app.get('/resources', c => {
  const after = offset.safeParse(c.req.query('after_episode') ?? 0)
  if (!after.success) return badRequest(c, 'invalid_request')
  const query = c.req.query('query')?.trim()
  if (query && query.length > 120) return badRequest(c, 'invalid_request')
  return success(c, creativeMaterials(Number(c.req.param('id')), after.data, query || undefined))
})

app.get('/sessions', c => {
  const projectId = Number(c.req.param('id'))
  const start = offset.safeParse(c.req.query('offset') ?? 0)
  if (!start.success) return badRequest(c, 'invalid_request')
  recoverCreativeTurns(projectId)
  const all = db.select(sessionFields).from(sessions).where(eq(sessions.dramaId, projectId))
    .orderBy(desc(sessions.updatedAt), desc(sessions.id)).offset(start.data).limit(pageSize + 1).all()
  const page = all.slice(0, pageSize)
  const sessionIds = page.map(session => session.id)
  const active = sessionIds.length ? db.select({ id: turns.id, sessionId: turns.sessionId }).from(turns)
    .where(and(eq(turns.status, 'running'), inArray(turns.sessionId, sessionIds))).all() : []
  const activeBySession = new Map(active.map(turn => [turn.sessionId, turn.id]))
  const latestBySession = new Map<number, ReturnType<typeof latestTurn> | null>()
  function latestTurn(sessionId: number) {
    return db.select({ status: turns.status, errorCode: turns.errorCode, model: turns.model,
      configId: turns.configId, createdAt: turns.createdAt }).from(turns)
      .where(eq(turns.sessionId, sessionId)).orderBy(desc(turns.id)).limit(1).get()
  }
  for (const sessionId of sessionIds) latestBySession.set(sessionId, latestTurn(sessionId) ?? null)
  return success(c, { sessions: page.map(session => {
    const latest = latestBySession.get(session.id)
    return { ...session, active_turn_id: activeBySession.get(session.id) ?? null,
      last_status: latest?.status ?? null, last_model: latest?.model ?? null,
      last_config_id: latest?.configId ?? null, last_error_code: latest?.errorCode ?? null,
      last_activity_at: latest?.createdAt ?? null }
  }),
    next_offset: all.length > pageSize ? start.data + pageSize : null })
})

app.patch('/sessions/:sessionId', async c => {
  const parsed = z.object({ title }).safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return badRequest(c, 'invalid_request')
  const saved = db.update(sessions).set({ title: parsed.data.title }).where(and(
    eq(sessions.dramaId, Number(c.req.param('id'))), eq(sessions.id, Number(c.req.param('sessionId'))),
  )).returning(sessionFields).get()
  return saved ? success(c, saved) : notFound(c)
})

app.post('/turns', async c => {
  const projectId = Number(c.req.param('id'))
  const parsed = turnRequest.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return badRequest(c, 'invalid_request')
  const input = parsed.data
  const requestFilter = and(eq(turns.dramaId, projectId), eq(turns.requestId, input.request_id))
  const existing = db.select(creativeTurnFields).from(turns).where(requestFilter).get()
  if (existing) return success(c, existing)
  const config = input.config_id === undefined ? await getActiveConfig('text') : resolveNovelModel(input.config_id, input.model!)
  const model = input.model ?? config?.model
  const configId = config?.id
  if (!configId || !model) return badRequest(c, 'model_unavailable')
  if (!input.references.every(reference => creativeReferenceExists(projectId, reference))) return badRequest(c, 'reference_not_found')
  recoverCreativeTurns(projectId)
  const result = db.transaction(tx => {
    if (!activeProject(projectId)) return null
    const duplicate = tx.select(creativeTurnFields).from(turns).where(requestFilter).get()
    if (duplicate) return { turn: duplicate }
    const timestamp = now()
    const session = input.session_id === undefined ? tx.insert(sessions).values({ dramaId: projectId,
      title: Array.from(input.message.replace(/\s+/g, ' ')).slice(0, 32).join(''), updatedAt: timestamp }).returning(sessionFields).get()
      : tx.select(sessionFields).from(sessions).where(and(eq(sessions.dramaId, projectId), eq(sessions.id, input.session_id))).get()
    if (!session) return null
    const latest = tx.select({ id: turns.id, status: turns.status }).from(turns).where(eq(turns.sessionId, session.id)).orderBy(desc(turns.id)).get()
    if (latest?.status === 'running') {
      return { busy: true } as const
    }
    if (input.resume_from_id !== undefined && (latest?.id !== input.resume_from_id || latest.status === 'completed')) {
      return { stale: true } as const
    }
    const lease = createNovelLease()
    const turn = tx.insert(turns).values({ dramaId: projectId, sessionId: session.id, requestId: input.request_id,
      resumeFromId: input.resume_from_id,
      message: input.message, references: input.references, configId, model, contentLanguage: getContentLanguage(),
      status: 'running', createdAt: timestamp, ...lease }).returning(creativeTurnFields).get()
    tx.update(sessions).set({ updatedAt: timestamp }).where(eq(sessions.id, session.id)).run()
    return { turn, token: lease.runToken }
  }, { behavior: 'immediate' })
  if (!result) return notFound(c)
  if ('busy' in result) return c.json({ code: 409, message: 'chat_running' }, 409)
  if ('stale' in result) return c.json({ code: 409, message: 'turn_superseded' }, 409)
  if (!result.token) return success(c, result.turn)
  launchCreativeTurn(result.turn.id, result.token)
  return created(c, result.turn)
})

app.get('/sessions/:sessionId/turns', c => {
  const projectId = Number(c.req.param('id'))
  const sessionId = Number(c.req.param('sessionId'))
  const before = offset.safeParse(c.req.query('before_id') ?? 0)
  if (!before.success) return badRequest(c, 'invalid_request')
  const session = db.select(sessionFields).from(sessions).where(and(eq(sessions.dramaId, projectId), eq(sessions.id, sessionId))).get()
  if (!session) return notFound(c)
  recoverCreativeTurns(projectId)
  const items = db.select(creativeTurnFields).from(turns).where(and(eq(turns.sessionId, sessionId),
    before.data ? lt(turns.id, before.data) : undefined)).orderBy(desc(turns.id)).limit(pageSize + 1).all()
  const page = items.slice(0, pageSize)
  const history = page.length ? db.select(creativeEventFields).from(events).where(inArray(events.turnId, page.map(turn => turn.id)))
    .orderBy(asc(events.seq)).all() : []
  return success(c, { session, turns: page.reverse(), events: history,
    before_id: items.length > pageSize ? page[0].id : null })
})

app.get('/turns/:turnId/events', c => {
  const projectId = Number(c.req.param('id'))
  const turnId = Number(c.req.param('turnId'))
  const cursor = offset.safeParse(c.req.header('Last-Event-ID') || c.req.query('after_seq') || 0)
  if (!cursor.success) return badRequest(c, 'invalid_request')
  const filter = and(eq(turns.dramaId, projectId), eq(turns.id, turnId))
  if (!db.select({ id: turns.id }).from(turns).where(filter).get()) return notFound(c)
  c.header('Cache-Control', 'no-cache, no-transform')
  c.header('X-Accel-Buffering', 'no')
  return streamSSE(c, async stream => {
    let after = cursor.data
    let heartbeat = 0
    while (!stream.aborted) {
      // Read status before events, so a terminal status cannot race ahead of its own event.
      const turn = db.select({ status: turns.status }).from(turns).where(filter).get()
      const batch = db.select(creativeEventFields).from(events).where(and(eq(events.turnId, turnId), gt(events.seq, after)))
        .orderBy(asc(events.seq)).limit(100).all()
      for (const item of batch) {
        await stream.writeSSE({ id: String(item.seq), data: JSON.stringify(item) })
        after = item.seq
      }
      if (batch.length === 100) continue
      if (turn?.status !== 'running') break
      if (Date.now() - heartbeat > 10_000) {
        await stream.write(': heartbeat\n\n')
        heartbeat = Date.now()
      }
      await stream.sleep(320)
    }
  })
})

app.post('/turns/:turnId/stop', c => {
  const status = stopCreativeTurn(Number(c.req.param('id')), Number(c.req.param('turnId')))
  return status ? success(c, { status }) : notFound(c)
})

app.get('/turns/:turnId/changes/:changeId', c => {
  const turn = db.select({ id: turns.id }).from(turns).where(and(eq(turns.dramaId, Number(c.req.param('id'))),
    eq(turns.id, Number(c.req.param('turnId'))))).get()
  if (!turn) return notFound(c)
  const change = db.select({ ...changeFields, before: changes.before, after: changes.after, base_revision: changes.baseRevision })
    .from(changes).where(and(eq(changes.turnId, turn.id), eq(changes.id, Number(c.req.param('changeId'))))).get()
  return change ? success(c, change) : notFound(c)
})

export default app
