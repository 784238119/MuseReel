import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { Hono } from 'hono'
import { eq, sql } from 'drizzle-orm'
import Database from 'better-sqlite3'
import { requestLogger } from '../src/middleware/logger.js'
import { initSqliteSchema } from '../src/db/sqlite-schema.js'

test('existing automatic novel jobs keep their checkpoints through the preview-first schema upgrade', () => {
  const sqlite = new Database(':memory:')
  try {
    sqlite.exec(`CREATE TABLE novel_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, drama_id INTEGER NOT NULL, request_id TEXT NOT NULL,
      brief TEXT NOT NULL, project_context TEXT NOT NULL, episode_count INTEGER NOT NULL,
      target_length INTEGER NOT NULL, config_id INTEGER NOT NULL, model TEXT NOT NULL,
      content_language TEXT NOT NULL, image_config_id INTEGER NOT NULL, video_config_id INTEGER NOT NULL,
      status TEXT NOT NULL, stage TEXT NOT NULL, source_type TEXT NOT NULL,
      draft_done INTEGER NOT NULL DEFAULT 0, draft_count INTEGER NOT NULL DEFAULT 0,
      completed_chapters INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO novel_jobs VALUES (41, 1, 'previous', '', '{}', 2, 500, 3, 'text', 'zh', 4, 5,
      'completed', 'publishing', 'import', 1, 1, 2, 'before', 'after');`)
    initSqliteSchema(sqlite)
    initSqliteSchema(sqlite)
    assert.deepEqual(sqlite.prepare(`SELECT id, workflow_mode, status, episode_count, draft_done, completed_chapters
      FROM novel_jobs WHERE id = 41`).get(), {
      id: 41, workflow_mode: 'automatic', status: 'completed', episode_count: 2, draft_done: 1, completed_chapters: 2,
    })
    assert.equal(sqlite.prepare(`INSERT INTO novel_jobs (drama_id, request_id, brief, project_context, content_language,
      status, stage, source_type, workflow_mode, created_at, updated_at)
      VALUES (1, 'new', '', '{}', 'zh', 'ready', 'ready', 'import', 'preview_first', 'before', 'after')`)
      .run().lastInsertRowid, 42)
    sqlite.exec('ALTER TABLE novel_jobs DROP COLUMN draft_revision')
    initSqliteSchema(sqlite)
    assert.deepEqual(sqlite.prepare('SELECT status, draft_revision FROM novel_jobs WHERE id = 42').get(), {
      status: 'ready', draft_revision: 0,
    })
  } finally {
    sqlite.close()
  }
})

test('project novel keeps checkpoints and publishes a 100-chapter novel exactly once', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'musereel-novels-test-'))
  process.env.SQLITE_PATH = join(directory, 'test.sqlite')
  process.env.DATA_ROOT = directory
  process.env.MYSQL_AUTO_IMPORT = 'false'
  process.env.WORKSPACE_PATH = join(directory, 'workspace')
  t.after(() => rm(directory, { recursive: true, force: true }))
  for (const skill of ['novel-writer', 'novel-splitter']) {
    await cp(new URL(`../workspace/skills/${skill}`, import.meta.url),
      join(directory, 'workspace', 'skills', skill), { recursive: true })
  }

  let cutOffSecond = true
  let resumedWithNewSettings = false
  let unblock!: () => void
  const blocked = new Promise<void>(resolve => { unblock = resolve })
  let oldWorkerStarted!: () => void
  let releaseOldWorker!: () => void
  const oldWorkerEntered = new Promise<void>(resolve => { oldWorkerStarted = resolve })
  const oldWorkerBlocked = new Promise<void>(resolve => { releaseOldWorker = resolve })
  const calls = { plan: 0, outlines: 0, chapters: [] as number[] }
  const manuscriptCalls = { analyze: 0, optimize: 0, split: 0 }
  let rejectSecondPart = true
  let invalidCut = true
  const promptMarkers = new Set<string>()
  const writerInstructions: string[] = []
  const splitterInstructions: string[] = []
  const mock = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const prompt = payload.messages.at(-1).content
    let result: unknown
    let finishReason = 'stop'
    const batch = prompt.match(/仅规划第 (\d+) 至 (\d+) 章/)
    const chapter = prompt.match(/只写第 (\d+) 章/)
    for (const marker of ['WRITER_FIXTURE', 'SPLITTER_FIXTURE']) {
      if (payload.messages[0].content.includes(marker)) promptMarkers.add(marker)
    }
    if (/^(分析小说原稿|润色指定)/.test(prompt)) writerInstructions.push(payload.messages[0].content)
    if (/^(为小说分集|按顺序为以下分集)/.test(prompt)) splitterInstructions.push(payload.messages[0].content)
    const input = prompt.split('\n').findLast((line: string) => /^[\[{]/.test(line))
    if (prompt.startsWith('分析小说原稿')) {
      manuscriptCalls.analyze++
      result = { summary: '人物、主线与结局' }
    } else if (prompt.startsWith('润色指定')) {
      manuscriptCalls.optimize++
      result = rejectSecondPart && manuscriptCalls.optimize === 2 ? {} : {
        content: JSON.parse(input).excerpt.replaceAll('原文', '润色稿'),
      }
    } else if (prompt.startsWith('为小说分集')) {
      manuscriptCalls.split++
      result = { choices: JSON.parse(input).map(() => invalidCut ? 1000 : 0) }
    } else if (prompt.startsWith('按顺序为以下分集')) {
      result = { titles: JSON.parse(input).map((_: unknown, i: number) => '分集 ' + (i + 1)) }
    } else if (prompt.includes('根据故事结构决定章节数')) {
      result = { plan: '故事含起因和结局', chapter_count: 1 }
    } else if (batch) {
      calls.outlines++
      const first = Number(batch[1])
      const last = Number(batch[2])
      result = { chapters: Array.from({ length: last - first + 1 }, (_, i) => ({
        chapter_number: first + i, beats: `Story beat ${first + i}`,
      })) }
    } else if (chapter) {
      const number = Number(chapter[1])
      calls.chapters.push(number)
      if (prompt.includes('lease takeover fixture') && payload.model === 'lease-original') {
        oldWorkerStarted()
        await oldWorkerBlocked
      }
      if (number === 2 && cutOffSecond) {
        await blocked
        finishReason = 'length'
      } else if (number === 2) {
        resumedWithNewSettings = payload.model === 'replacement-model' && prompt.includes('500 字')
      }
      result = { title: `第 ${number} 章`, content: `第一段 ${number}\n\n第二段`, summary: `写到 ${number}` }
    } else {
      calls.plan++
      result = { plan: '起因、人物、发展和结局' }
    }
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({
      id: 'chatcmpl-fixture',
      object: 'chat.completion',
      created: 0,
      model: 'novel-test',
      choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(result) }, finish_reason: finishReason }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }))
  })
  await new Promise<void>(resolve => mock.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    unblock()
    releaseOldWorker()
    mock.closeAllConnections()
    mock.close()
  })
  const address = mock.address()
  assert.ok(address && typeof address !== 'string')
  const { db, schema } = await import('../src/db/index.js')
  const { createNovelLease, recoverExpiredNovelJobs, runNovelJob } = await import('../src/services/novels.js')
  const { default: dramas } = await import('../src/routes/dramas.js')
  const { default: episodes } = await import('../src/routes/episodes.js')
  const { default: prompts } = await import('../src/routes/prompts.js')
  const { default: skills } = await import('../src/routes/skills.js')
  const app = new Hono()
    .use('/api/v1/dramas/:id/novel-jobs', requestLogger)
    .route('/api/v1/dramas', dramas)
    .route('/api/v1/episodes', episodes)
    .route('/api/v1/prompts', prompts)
    .route('/api/v1/skills', skills)
  const timestamp = new Date().toISOString()
  const config = (serviceType: string, provider: string, model = '["novel-test"]') => db.insert(schema.aiServiceConfigs).values({
    name: serviceType,
    serviceType,
    provider,
    model,
    baseUrl: `http://127.0.0.1:${address.port}`,
    apiKey: 'fixture',
    createdAt: timestamp,
    updatedAt: timestamp,
  }).returning().get()
  const text = config('text', 'openai', '"novel-test"')
  const replacement = config('text', 'openai', '"replacement-model"')
  const image = config('image', 'openai')
  const video = config('video', 'volcengine')
  const request = async (path: string, method = 'GET', body?: object) => {
    const res = await app.request(`/api/v1${path}`, { method, body: body && JSON.stringify(body) })
    return { status: res.status, ...(await res.json() as { data: any, message: string }) }
  }
  const drama = (await request('/dramas', 'POST', { title: '测试小说' })).data
  const root = `/dramas/${drama.id}/novel-jobs`
  await request('/episodes', 'POST', { drama_id: drama.id, title: '已有分集' })
  const payload = {
    request_id: 'a'.repeat(32), brief: '写一部小说', episode_count: 100,
    target_length: 1000, config_id: text.id, model: 'novel-test',
  }
  const brief = '用于验证日志脱敏的创作设定'
  const log = t.mock.method(console, 'log', () => {})
  const errorLog = t.mock.method(console, 'error', () => {})
  db.run(sql.raw(`CREATE TEMP TRIGGER fail_novel_start BEFORE INSERT ON novel_jobs
    BEGIN SELECT RAISE(ABORT, 'fixture start failure'); END;`))
  const rejected = await request(root, 'POST', { ...payload, brief })
  db.run(sql.raw('DROP TRIGGER fail_novel_start'))
  const first = await request(root, 'POST', { ...payload, brief })
  const entries = [...log.mock.calls, ...errorLog.mock.calls].flatMap(call => call.arguments).join('\n')
  log.mock.restore()
  errorLog.mock.restore()
  assert.equal(rejected.status, 500)
  assert.doesNotMatch(rejected.message, new RegExp(brief))
  assert.doesNotMatch(entries, new RegExp(brief))
  assert.match(entries, /POST.*novel-jobs/)
  assert.equal(first.status, 201)
  const id = first.data.id
  const jobUrl = `${root}/${id}`
  assert.equal((await request(root, 'POST', payload)).data.id, id)
  assert.equal((await request(root, 'POST', { ...payload, request_id: 'b'.repeat(32) })).status, 409)

  async function waitUntil(predicate: (job: any) => boolean, url = jobUrl) {
    for (let tries = 0; tries < 1000; tries++) {
      const { data } = await request(url)
      if (predicate(data)) return data
      await delay(10)
    }
    assert.fail('Novel job did not reach the expected state')
  }

  await waitUntil(job => job.completed_chapters === 1)
  const recoveryModule = new URL('../src/services/novels.ts', import.meta.url).href
  await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `const { recoverExpiredNovelJobs } = await import(${JSON.stringify(recoveryModule)}); recoverExpiredNovelJobs()`,
  ])
  assert.equal((await request(jobUrl)).data.status, 'running')
  const manual = await request('/episodes', 'POST', { drama_id: drama.id, title: '生成期间添加' })
  assert.equal(manual.data.episode_number, 2)

  db.run(sql.raw(`CREATE TEMP TRIGGER fail_novel_status BEFORE UPDATE ON novel_jobs
    WHEN NEW.status = 'failed' BEGIN SELECT RAISE(ABORT, 'fixture status failure'); END;`))
  let statusWriteFailed = false
  const originalError = console.error
  const failureLog = t.mock.method(console, 'error', (...args: unknown[]) => {
    if (args[0] === '[novels] Failed to persist task status') statusWriteFailed = true
    else originalError(...args)
  })
  unblock()
  const stopped = await waitUntil(() => statusWriteFailed)
  failureLog.mock.restore()
  assert.equal(stopped.status, 'running')
  assert.equal(stopped.completed_chapters, 1)
  assert.equal((await request(`${jobUrl}/chapters/1`)).status, 404)

  db.run(sql.raw('DROP TRIGGER fail_novel_status'))
  db.update(schema.novelJobs).set({ leaseExpiresAt: Date.now() - 1 }).where(eq(schema.novelJobs.id, id)).run()
  recoverExpiredNovelJobs()
  assert.equal((await request(jobUrl)).data.status, 'interrupted')
  db.delete(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, text.id)).run()
  assert.equal((await request(`${jobUrl}/retry`, 'POST')).message, 'model_unavailable')
  assert.equal((await request(`${jobUrl}/retry`, 'POST', { model: 'replacement-model' })).status, 400)

  db.run(sql.raw(`CREATE TEMP TRIGGER fail_novel_publish BEFORE INSERT ON episodes
    WHEN NEW.episode_number = 4 BEGIN SELECT RAISE(ABORT, 'fixture publish failure'); END;`))
  cutOffSecond = false
  const retry = { config_id: replacement.id, model: 'replacement-model', target_length: 500 }
  assert.equal((await request(`${jobUrl}/retry`, 'POST', { ...retry, target_length: 1200 })).status, 400)
  const retryResponses = await Promise.all([
    request(`${jobUrl}/retry`, 'POST', retry),
    request(`${jobUrl}/retry`, 'POST', retry),
  ])
  assert.ok(retryResponses.every(result => result.status === 200))
  const publishFailed = await waitUntil(job => job.status === 'failed')
  assert.equal(publishFailed.error_code, 'publish_failed')
  assert.equal(publishFailed.completed_chapters, 100)
  assert.equal(publishFailed.chapters.length, 100)
  assert.ok(publishFailed.chapters.every((item: any) => item.episode_id === null))
  const savedNovel = await request(`${jobUrl}/chapters/1`)
  assert.equal(savedNovel.status, 200)
  assert.equal(savedNovel.data.content, '第一段 1\n\n第二段')
  assert.equal((await request(`/dramas/${drama.id}`)).data.episodes.length, 2)
  assert.equal(publishFailed.model, 'replacement-model')
  assert.equal(publishFailed.target_length, 500)
  assert.ok(resumedWithNewSettings)

  db.run(sql.raw('DROP TRIGGER fail_novel_publish'))
  db.delete(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, replacement.id)).run()
  await request(`${jobUrl}/retry`, 'POST')
  const completed = await waitUntil(job => job.status === 'completed')
  await request(`${jobUrl}/retry`, 'POST')
  assert.equal(completed.chapters.length, 100)
  assert.equal(completed.chapters[0].episode_number, 3)
  assert.equal(completed.chapters.at(-1).episode_number, 102)
  const chapter = (await request(`${jobUrl}/chapters/1`)).data
  const finalEpisodes = (await request(`/dramas/${drama.id}`)).data.episodes
  assert.equal(finalEpisodes.length, 102)
  assert.equal(finalEpisodes.find((ep: any) => ep.episode_number === 1).title, '已有分集')
  const generated = finalEpisodes.find((ep: any) => ep.episode_number === 3)
  assert.equal(generated.title, chapter.title)
  assert.equal(generated.content, '第一段 1\n\n第二段')
  assert.equal(generated.content, chapter.content)
  assert.equal(generated.script_content, null)
  assert.equal(generated.image_config_id, image.id)
  assert.equal(generated.video_config_id, video.id)
  await request(`/episodes/${generated.id}`, 'PUT', { script_content: '测试改写后的剧本' })
  const projectUrl = `/dramas/${drama.id}`
  const projectSummary = await request(`${projectUrl}?episode_summary=1`)
  const summaryList = await request('/dramas?episode_summary=1')
  for (const summaries of [projectSummary.data.episodes, summaryList.data.items[0].episodes]) {
    assert.ok(summaries.every((ep: object) => !('content' in ep) && !('script_content' in ep)))
    assert.equal(summaries.find((ep: any) => ep.id === generated.id).has_script, true)
  }
  const single = await request(`${projectUrl}/episodes/3?episode_id=${generated.id}`)
  assert.equal(single.data.content, chapter.content)
  assert.equal(single.data.script_content, '测试改写后的剧本')

  const last = completed.chapters.at(-1)
  await request(`/episodes/${last.episode_id}`, 'DELETE')
  const newEpisode = await request('/episodes', 'POST', { drama_id: drama.id, title: '复用集号' })
  assert.equal(newEpisode.data.episode_number, 102)
  assert.notEqual(newEpisode.data.id, last.episode_id)
  assert.equal((await request(`${projectUrl}/episodes/102?episode_id=${last.episode_id}`)).status, 404)
  assert.equal((await request(`${projectUrl}/episodes/102`)).data.id, newEpisode.data.id)
  assert.equal((await request(jobUrl)).data.chapters.at(-1).episode_id, null)
  assert.equal(calls.plan, 1)
  assert.equal(calls.outlines, 10)
  assert.deepEqual(calls.chapters, [1, 2, ...Array.from({ length: 99 }, (_, i) => i + 2)])

  const originalModel = config('text', 'openai', '"lease-original"')
  const takeoverModel = config('text', 'openai', '"lease-replacement"')
  const lease = createNovelLease()
  const takeover = db.insert(schema.novelJobs).values({
    dramaId: drama.id,
    requestId: 'c'.repeat(32),
    brief: 'lease takeover fixture',
    projectContext: '{}',
    episodeCount: 1,
    targetLength: 500,
    configId: originalModel.id,
    model: 'lease-original',
    contentLanguage: 'zh',
    imageConfigId: image.id,
    videoConfigId: video.id,
    stage: 'planning',
    status: 'running',
    createdAt: timestamp,
    updatedAt: timestamp,
    ...lease,
  }).returning().get()
  const oldWorker = runNovelJob(takeover.id, lease.runToken)
  await Promise.race([
    oldWorkerEntered,
    delay(5000, undefined, { ref: false }).then(() => assert.fail('Old worker never reached the chapter')),
  ])
  db.update(schema.novelJobs).set({ leaseExpiresAt: Date.now() - 1 }).where(eq(schema.novelJobs.id, takeover.id)).run()
  recoverExpiredNovelJobs()
  const newLease = createNovelLease()
  db.update(schema.novelJobs).set({
    status: 'running', errorCode: null, configId: takeoverModel.id, model: 'lease-replacement', ...newLease,
  }).where(eq(schema.novelJobs.id, takeover.id)).run()
  await runNovelJob(takeover.id, newLease.runToken)
  releaseOldWorker()
  await oldWorker
  const recovered = (await request(`${root}/${takeover.id}`)).data
  assert.equal(recovered.status, 'completed')
  assert.equal(recovered.completed_chapters, 1)
  assert.equal(recovered.chapters[0].episode_number, 103)
  assert.equal((await request(projectUrl)).data.episodes.length, 103)

  await t.test('import preserves the draft and resumes optimization and splitting independently', async () => {
    for (const [type, marker] of [['novel_writer', 'WRITER_FIXTURE'], ['novel_splitter', 'SPLITTER_FIXTURE']]) {
      const defaults = await request('/prompts/' + type)
      assert.equal(defaults.status, 200)
      assert.ok(defaults.data.is_default && defaults.data.system_prompt)
      assert.equal((await request('/prompts/' + type, 'PUT', { system_prompt: marker })).status, 200)
      assert.equal((await request('/prompts/' + type + '?lang=en')).data.system_prompt, marker)
    }
    const skillList = (await request('/skills')).data
    assert.ok(skillList.some((skill: { id: string }) => skill.id === 'novel-writer'))
    assert.ok(skillList.some((skill: { id: string }) => skill.id === 'novel-splitter'))
    const writerSkill = (await request('/skills/novel-writer')).data.content
    const splitterSkill = (await request('/skills/novel-splitter')).data.content
    assert.equal((await request('/skills/novel-writer?lang=en', 'PUT', {
      content: writerSkill + '\nWRITER_SKILL_EDIT\n',
    })).status, 200)
    assert.equal((await request('/skills/novel-splitter', 'PUT', {
      content: splitterSkill + '\nSPLITTER_SKILL_FIRST\n',
    })).status, 200)
    const imported = '\n# 小说\r\n\r\n' + '原文，陆遥在码头拾到一封信。\r\n\r\n'.repeat(500) + '黎明，她回到了海港。 🌊\n'
    const body = {
      workflow_mode: 'preview_first', source_type: 'import', source_text: imported,
      content_language: 'en', request_id: 'd'.repeat(32),
    }
    const splitBody = { episode_count: 7, config_id: takeoverModel.id, model: 'lease-replacement' }
    const setVideo = (isActive: boolean) => db.update(schema.aiServiceConfigs).set({ isActive })
      .where(eq(schema.aiServiceConfigs.id, video.id)).run()
    setVideo(false)
    const creation = await request(root, 'POST', body)
    assert.equal(creation.status, 201)
    assert.equal(creation.data.status, 'ready')
    assert.equal(creation.data.episode_count, null)
    assert.equal(creation.data.config_id, null)
    const url = root + '/' + creation.data.id
    const readVersion = async (version: string) => (await Promise.all(
      Array.from({ length: creation.data.draft_count }, async (_, i) =>
        (await request(url + '/manuscripts/' + version + '/' + (i + 1))).data.content),
    )).join('')
    assert.equal(await readVersion('draft'), imported)
    assert.equal((await request(url)).data.status, 'ready')
    assert.equal((await request(url + '/retry', 'POST')).data.status, 'ready')
    assert.equal((await request(url + '/split', 'POST', splitBody)).message, 'video_unavailable')
    assert.equal((await request(projectUrl)).data.episodes.length, 103)
    assert.deepEqual(manuscriptCalls, { analyze: 0, optimize: 0, split: 0 })
    setVideo(true)
    const splitResponses = await Promise.all([
      request(url + '/split', 'POST', splitBody), request(url + '/split', 'POST', splitBody),
    ])
    assert.ok(splitResponses.every(response => response.status === 200 && response.data.id === creation.data.id))
    const failedEdit = await waitUntil(job => job.status === 'failed', url)
    assert.equal(failedEdit.stage, 'optimizing')
    assert.equal(failedEdit.optimized_done, 1)
    assert.equal((await request(url + '/manuscripts/optimized/1')).status, 404)
    const analyses = manuscriptCalls.analyze
    rejectSecondPart = false
    await request(url + '/retry', 'POST')
    const failedSplit = await waitUntil(job => job.status === 'failed', url)
    assert.equal(failedSplit.stage, 'splitting')
    const optimized = await readVersion('optimized')
    assert.equal(optimized, imported.replaceAll('原文', '润色稿'))
    assert.equal(manuscriptCalls.analyze, analyses)
    assert.equal(manuscriptCalls.optimize, creation.data.draft_count + 1)
    assert.ok(writerInstructions.length > 0)
    assert.ok(writerInstructions.every(instructions =>
      instructions.includes('WRITER_SKILL_EDIT') && !instructions.includes('SPLITTER_SKILL_FIRST')))
    assert.match(splitterInstructions.at(-1) ?? '', /SPLITTER_SKILL_FIRST/)
    assert.equal((await request('/skills/novel-splitter', 'PUT', {
      content: splitterSkill + '\nSPLITTER_SKILL_EDIT\n',
    })).status, 200)
    const completedSplitCalls = splitterInstructions.length
    invalidCut = false
    await request(url + '/retry', 'POST')
    const done = await waitUntil(job => job.status === 'completed', url)
    assert.equal(done.chapters.length, 7)
    assert.equal(done.chapters[0].episode_number, 104)
    const newSplitInstructions = splitterInstructions.slice(completedSplitCalls)
    assert.ok(newSplitInstructions.length > 0)
    assert.ok(newSplitInstructions.every(instructions => instructions.includes('SPLITTER_SKILL_EDIT')
      && !instructions.includes('SPLITTER_SKILL_FIRST') && !instructions.includes('WRITER_SKILL_EDIT')))
    const segments = await Promise.all(done.chapters.map(async (chapter: any) => {
      const episode = await request(projectUrl + '/episodes/' + chapter.episode_number + '?episode_id=' + chapter.episode_id)
      return episode.data.content
    }))
    assert.equal(segments.join(''), optimized)
    assert.equal((await request(root, 'POST', body)).data.id, done.id)
    assert.equal((await request(url + '/split', 'POST', splitBody)).data.status, 'completed')
    assert.equal((await request(projectUrl)).data.episodes.length, 110)
    assert.deepEqual(promptMarkers, new Set(['WRITER_FIXTURE', 'SPLITTER_FIXTURE']))
    assert.equal((await request('/prompts/novel_splitter/reset', 'POST')).status, 200)
    assert.equal((await request('/prompts/novel_splitter')).data.is_default, true)
  })

  await t.test('AI manuscript waits at preview before creating any episodes', async () => {
    db.update(schema.aiServiceConfigs).set({ isActive: false }).where(eq(schema.aiServiceConfigs.id, image.id)).run()
    const creation = await request(root, 'POST', {
      workflow_mode: 'preview_first', source_type: 'ai', brief: '按完整故事写', target_length: 800, request_id: 'e'.repeat(32),
      config_id: takeoverModel.id, model: 'lease-replacement',
    })
    assert.equal(creation.status, 201)
    const url = root + '/' + creation.data.id
    const ready = await waitUntil(job => job.status === 'ready' || job.status === 'failed', url)
    assert.equal(ready.status, 'ready', JSON.stringify(ready))
    assert.equal(ready.episode_count, null)
    assert.equal(ready.optimized_done, 0)
    assert.equal(ready.draft_count, 1)
    assert.match((await request(url + '/manuscripts/draft/1')).data.content, /第一段/)
    assert.equal((await request(projectUrl)).data.episodes.length, 110)
    db.update(schema.aiServiceConfigs).set({ isActive: true }).where(eq(schema.aiServiceConfigs.id, image.id)).run()
    await request(url + '/split', 'POST', { episode_count: 2, config_id: takeoverModel.id, model: 'lease-replacement' })
    const done = await waitUntil(job => job.status === 'completed' || job.status === 'failed', url)
    assert.equal(done.status, 'completed', JSON.stringify(done))
    assert.equal(done.draft_count, 1)
    assert.equal(done.optimized_done, 1)
    assert.equal(done.chapters.length, 2)
  })
})
