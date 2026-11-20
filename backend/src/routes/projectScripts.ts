import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db, schema } from '../db/index.js'
import { getContentLanguage } from '../services/app-settings.js'
import { createNovelLease, resolveNovelModel } from '../services/novels.js'
import { scriptCount, scriptSource, inspectScriptImport, formattedScript, projectOutline, MAX_SCRIPT_BYTES } from '../services/script-import.js'
import {
  activeEpisode, activeProject, beginEpisodeProduction, enqueueScript, findBlockingScript, getScriptParts,
  isScriptEditable, launchScript, recentEpisodes, saveProjectEpisode, saveProjectOutline, scriptJobFields,
} from '../services/project-scripts.js'
import { badRequest, created, notFound, now, serverError, success } from '../utils/response.js'

const { projectScripts, scriptJobs: jobs, scriptJobEpisodes: parts, episodes, dramas,
  novelJobs, novelManuscriptParts, novelChapters } = schema
const requestId = z.string().regex(/^[a-f\d]{32}$/)
const modelInput = z.object({ config_id: z.number().int().positive(), model: z.string().trim().min(1).max(256) })
const duration = z.enum(['30–60s', '1–2m', '2–3m'])
const scriptOptions = modelInput.extend({ request_id: requestId, episode_count: scriptCount, duration })
const idea = z.string().trim().min(1).max(8000)
export const scriptCreation = z.discriminatedUnion('source_type', [
  scriptOptions.extend({ source_type: z.literal('ai'), idea }),
  scriptOptions.extend({ source_type: z.literal('upload'), source_text: scriptSource, continuous: z.boolean().optional() }),
])
export const scriptBodyLimit = bodyLimit({
  maxSize: MAX_SCRIPT_BYTES * 6 + 16384,
  onError: c => badRequest(c, 'source_too_large'),
})

export const importPreview = new Hono().post('/', scriptBodyLimit, async c => {
  const parsed = z.object({ source_text: scriptSource }).safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return badRequest(c, 'invalid_request')
  const detected = inspectScriptImport(parsed.data.source_text)
  return success(c, detected.mode === 'numbered'
    ? { mode: detected.mode, episodes: detected.parts.map(({ number, title }) => ({ number, title })) } : detected)
})

export const projectScript = new Hono()
projectScript.onError((error, c) => {
  console.error('[project-script]', c.req.method, c.req.path, error.name)
  return serverError(c)
})
projectScript.use('*', async (c, next) => {
  if (!activeProject(Number(c.req.param('id')))) return notFound(c)
  await next()
})

projectScript.get('/', c => {
  const dramaId = Number(c.req.param('id'))
  const script = db.select().from(projectScripts).where(eq(projectScripts.dramaId, dramaId)).get()
  const initial = db.select({ hasSource: sql<boolean>`json_type(${jobs.payload}, '$.source') = 'text'`.mapWith(Boolean) }).from(jobs)
    .where(and(eq(jobs.dramaId, dramaId), eq(jobs.kind, 'initial'))).get()
  const latest = db.select(scriptJobFields).from(jobs).where(eq(jobs.dramaId, dramaId)).orderBy(desc(jobs.id)).get()
  const job = latest && {
    ...latest,
    parts: db.select({ ordinal: parts.ordinal, title: parts.title, episode_id: parts.episodeId })
      .from(parts).where(and(eq(parts.jobId, latest.id), isNotNull(parts.script))).orderBy(parts.ordinal).all(),
  }
  return success(c, { outline: script ? JSON.parse(script.outline) : null, revision: script?.revision ?? 0,
    has_source: !!initial?.hasSource, job })
})

projectScript.get('/jobs/:jobId/preview/:ordinal', c => {
  const dramaId = Number(c.req.param('id'))
  const id = Number(c.req.param('jobId'))
  const job = db.select({
    kind: jobs.kind,
    original: sql<string | null>`json_extract(${jobs.payload}, '$.original')`,
    targetId: sql<number | null>`json_extract(${jobs.payload}, '$.targetId')`,
  }).from(jobs).where(and(eq(jobs.dramaId, dramaId), eq(jobs.id, id))).get()
  if (!job) return notFound(c)
  const part = db.select({ title: parts.title, script: parts.script }).from(parts).where(and(
    eq(parts.jobId, id), eq(parts.ordinal, Number(c.req.param('ordinal'))), isNotNull(parts.script),
  )).get()
  if (!part) return notFound(c)
  return success(c, {
    ...part, original: job.kind === 'rewrite' ? job.original : undefined, target_id: job.targetId,
  })
})

projectScript.get('/source', c => {
  const dramaId = Number(c.req.param('id'))
  const initial = db.select({ payload: jobs.payload }).from(jobs)
    .where(and(eq(jobs.dramaId, dramaId), eq(jobs.kind, 'initial'))).get()
  const source = initial && JSON.parse(initial.payload).source
  return source ? success(c, { source }) : notFound(c)
})

projectScript.get('/novels/:jobId', c => {
  const dramaId = Number(c.req.param('id'))
  const id = Number(c.req.param('jobId'))
  const job = db.select().from(novelJobs).where(and(eq(novelJobs.dramaId, dramaId), eq(novelJobs.id, id))).get()
  if (!job) return notFound(c)
  let source: string
  if (job.draftCount > 0 && job.draftCount === job.draftDone) {
    const rows = db.select({ draft: novelManuscriptParts.draft }).from(novelManuscriptParts)
      .where(eq(novelManuscriptParts.jobId, id)).orderBy(novelManuscriptParts.partNumber).all()
    source = rows.map(row => row.draft).join('')
  } else if (job.sourceType === 'legacy' && job.episodeCount && job.completedChapters === job.episodeCount) {
    const rows = db.select({ title: novelChapters.title, content: novelChapters.content }).from(novelChapters)
      .where(eq(novelChapters.jobId, id)).orderBy(novelChapters.chapterNumber).all()
    source = rows.map(row => `# ${row.title}\n\n${row.content}`).join('\n\n')
  } else return notFound(c)
  if (!scriptSource.safeParse(source).success) return badRequest(c, 'source_too_large')
  return success(c, { source })
})

projectScript.put('/outline', async c => {
  const dramaId = Number(c.req.param('id'))
  const parsed = z.object({ revision: z.number().int().nonnegative(), outline: projectOutline })
    .safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return badRequest(c, 'invalid_request')
  const { revision, outline } = parsed.data
  const saved = db.transaction(tx => saveProjectOutline(tx, dramaId, revision, outline), { behavior: 'immediate' })
  return saved.error ? c.json({ code: 409, message: saved.error }, 409) : success(c, { outline, revision: saved.revision })
})

projectScript.get('/episodes/:episodeId', c => {
  const dramaId = Number(c.req.param('id'))
  const episodeId = Number(c.req.param('episodeId'))
  const result = db.transaction(tx => {
    const episode = activeEpisode(tx, dramaId, episodeId)
    return episode && {
      id: episode.id, script: episode.scriptContent, original: episode.content,
      title: episode.title, revision: episode.updatedAt, editable: isScriptEditable(tx, episode),
    }
  })
  return result ? success(c, result) : notFound(c)
})

projectScript.put('/episodes/:episodeId', async c => {
  const dramaId = Number(c.req.param('id'))
  const id = Number(c.req.param('episodeId'))
  const parsed = z.object({ revision: z.string(), title: z.string().trim().min(1).max(160), script: formattedScript })
    .safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return badRequest(c, 'invalid_script')
  const result = db.transaction(tx => saveProjectEpisode(tx, dramaId, id, parsed.data), { behavior: 'immediate' })
  if (result.error === 'not_found') return notFound(c)
  return result.error ? c.json({ code: 409, message: result.error }, 409) : success(c)
})

projectScript.post('/episodes/:episodeId/production', c => {
  const dramaId = Number(c.req.param('id'))
  const id = Number(c.req.param('episodeId'))
  const exists = db.transaction(tx => {
    const episode = activeEpisode(tx, dramaId, id)
    if (!episode) return false
    beginEpisodeProduction(dramaId, id)
    return true
  }, { behavior: 'immediate' })
  return exists ? success(c) : notFound(c)
})

const followup = z.discriminatedUnion('kind', [
  scriptOptions.extend({ kind: z.literal('continue'), idea: idea.optional(), source_text: scriptSource.optional(),
    continuous: z.boolean().optional() }),
  scriptOptions.extend({ kind: z.literal('rewrite'), idea, target_id: z.number().int().positive(), revision: z.string() }),
])
projectScript.post('/jobs', scriptBodyLimit, async c => {
  const dramaId = Number(c.req.param('id'))
  const parsed = followup.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return badRequest(c, 'invalid_request')
  const input = parsed.data
  const source = input.kind === 'continue' ? input.source_text : undefined
  const continuous = input.kind === 'continue' && input.continuous
  const detected = source && !continuous ? inspectScriptImport(source) : null
  if (detected?.mode === 'invalid') return badRequest(c, 'invalid_episode_headings')
  const result = db.transaction(tx => {
    const existing = tx.select().from(jobs).where(eq(jobs.requestId, input.request_id)).get()
    if (existing) return existing.dramaId === dramaId ? { id: existing.id } : { error: 'script_conflict' }
    if (findBlockingScript(tx, dramaId)) return { error: 'job_running' }
    const review = tx.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.dramaId, dramaId), eq(jobs.status, 'review'))).get()
    if (review) return { error: 'pending_review' }
    if (!resolveNovelModel(input.config_id, input.model)) return { error: 'model_unavailable' }
    const outline = tx.select().from(projectScripts).where(eq(projectScripts.dramaId, dramaId)).get()
    if (!outline && !input.idea && !source) return { error: 'outline_required' }
    const target = input.kind === 'rewrite' ? activeEpisode(tx, dramaId, input.target_id) : undefined
    if (input.kind === 'rewrite') {
      if (!target) return { error: 'not_found' }
      if (!isScriptEditable(tx, target)) return { error: 'production_locked' }
      if (input.revision !== target.updatedAt) return { error: 'script_conflict' }
    }
    const job = enqueueScript(tx, {
      dramaId, kind: input.kind, requestId: input.request_id,
      configId: input.config_id, model: input.model,
      count: input.kind === 'rewrite' ? 1 : detected?.mode === 'numbered' ? detected.parts.length : input.episode_count,
      payload: {
        language: getContentLanguage(), seconds: input.duration, idea: input.idea, source, continuous,
        targetId: target?.id, targetRevision: target?.updatedAt, targetTitle: target?.title,
        original: target?.scriptContent || target?.content || undefined,
        outlineSnapshot: outline?.outline, priorEpisodes: recentEpisodes(dramaId),
      },
    })
    return { id: job.id, token: job.runToken }
  }, { behavior: 'immediate' })
  if (result.error === 'not_found') return notFound(c)
  if (result.error) return c.json({ code: 409, message: result.error }, 409)
  launchScript(result.id!, result.token ?? null)
  return created(c, { id: result.id })
})

projectScript.post('/jobs/:jobId/retry', async c => {
  const dramaId = Number(c.req.param('id'))
  const id = Number(c.req.param('jobId'))
  const parsed = modelInput.partial().refine(input => (input.model === undefined) === (input.config_id === undefined))
    .safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return badRequest(c, 'invalid_request')
  const result = db.transaction(tx => {
    const job = tx.select().from(jobs).where(and(eq(jobs.id, id), eq(jobs.dramaId, dramaId))).get()
    if (!job) return { error: 'not_found' }
    if (!['failed', 'interrupted'].includes(job.status)) return {}
    const latest = tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.dramaId, dramaId)).orderBy(desc(jobs.id)).get()
    if (latest?.id !== id || findBlockingScript(tx, dramaId, id)) return { error: 'script_conflict' }
    const configId = parsed.data.config_id ?? job.configId
    const model = parsed.data.model ?? job.model
    if (job.stage !== 'publishing' && !resolveNovelModel(configId, model)) return { error: 'model_unavailable' }
    const lease = createNovelLease()
    tx.update(jobs).set({ status: 'running', errorCode: null, configId, model, ...lease }).where(eq(jobs.id, id)).run()
    return { token: lease.runToken }
  }, { behavior: 'immediate' })
  if (result.error === 'not_found') return notFound(c)
  if (result.error) return c.json({ code: 409, message: result.error }, 409)
  launchScript(id, result.token ?? null)
  return success(c, { id })
})

projectScript.post('/jobs/:jobId/resolve', async c => {
  const dramaId = Number(c.req.param('id'))
  const id = Number(c.req.param('jobId'))
  const parsed = z.object({ apply: z.boolean() }).safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return badRequest(c, 'invalid_request')
  const result = db.transaction(tx => {
    const job = tx.select().from(jobs).where(and(eq(jobs.id, id), eq(jobs.dramaId, dramaId), eq(jobs.kind, 'rewrite'))).get()
    if (!job) return 'not_found'
    if (job.status === 'completed' && parsed.data.apply) return null
    if (job.status !== 'review') return 'script_conflict'
    if (parsed.data.apply) {
      const input = JSON.parse(job.payload)
      const episode = activeEpisode(tx, dramaId, input.targetId)
      if (!episode) return 'not_found'
      if (!isScriptEditable(tx, episode)) return 'production_locked'
      if (episode.updatedAt !== input.targetRevision || episode.title !== input.targetTitle
        || (episode.scriptContent || episode.content || undefined) !== input.original) return 'script_conflict'
      const part = getScriptParts(id)[0]
      if (!part?.script) return 'script_conflict'
      tx.update(episodes).set({ title: part.title || episode.title, scriptContent: part.script, updatedAt: now() })
        .where(eq(episodes.id, episode.id)).run()
      tx.update(dramas).set({ updatedAt: now() }).where(eq(dramas.id, dramaId)).run()
    }
    const status = parsed.data.apply ? 'completed' : 'discarded'
    tx.update(jobs).set({ status, stage: status }).where(eq(jobs.id, id)).run()
    return null
  }, { behavior: 'immediate' })
  if (result === 'not_found') return notFound(c)
  return result ? c.json({ code: 409, message: result }, 409) : success(c, { id })
})
