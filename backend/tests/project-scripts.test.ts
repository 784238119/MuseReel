import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { Hono } from 'hono'
import { eq, sql } from 'drizzle-orm'
import { formattedScript, inspectScriptImport } from '../src/services/script-import.js'

test('recognizes upload headings and validates scene bodies', () => {
  const text = '# 导言\r\n\r\n正文从这里开始。\r\n'
  assert.deepEqual(inspectScriptImport(text), { mode: 'continuous' })
  const numbered = inspectScriptImport('前言\r\n## 第一集｜出发\r\n正文 A\r\n\r\n### Episode 2 - Arrival\r\n正文 B')
  assert.equal(numbered.mode, 'numbered')
  if (numbered.mode === 'numbered') assert.deepEqual(numbered.parts, [
    { number: 1, title: '出发', raw: '正文 A\r\n\r\n' },
    { number: 2, title: 'Arrival', raw: '正文 B' },
  ])
  assert.deepEqual(inspectScriptImport('第1集\n正文\n第1集\n正文'), { mode: 'invalid', line: 3 })
  assert.deepEqual(inspectScriptImport('第1集\n第2集\n正文'), { mode: 'invalid', line: 1 })
  assert.equal(formattedScript.safeParse('前言\n## S01 | 内景 · 车站 | 清晨').success, false)
})

test('project setup, uploads, continuation, and protected rewrite use the normal endpoints', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'musereel-project-script-'))
  process.env.SQLITE_PATH = join(directory, 'test.sqlite')
  process.env.DATA_ROOT = directory
  process.env.WORKSPACE_PATH = join(directory, 'workspace')
  process.env.MYSQL_AUTO_IMPORT = 'false'
  t.after(() => rm(directory, { recursive: true, force: true }))

  const scene = '## S01 | 内景 · 车站 | 清晨\n\n柳青在车站等待最后一班列车。'
  const requests: string[] = []
  let failSecond = true
  const mock = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const prompt = JSON.parse(Buffer.concat(chunks).toString()).messages.at(-1).content
    requests.push(prompt)
    let finish = 'stop'
    let result: unknown = { title: '最后一班列车', script: scene }
    if (prompt.startsWith('为整个短剧')) result = { synopsis: '车站之谜', characters: '柳青', arc: '找到失踪的旅客' }
    else if (prompt.startsWith('通读上传')) result = { summary: '柳青追查列车' }
    else if (prompt.startsWith('在每组候选')) result = { choices: [0] }
    else if (failSecond && prompt.includes('"ordinal":2')) {
      failSecond = false
      finish = 'length'
    }
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({
      id: 'mock', object: 'chat.completion', created: 0, model: 'script-test',
      choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(result) }, finish_reason: finish }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }))
  })
  await new Promise<void>(resolve => mock.listen(0, '127.0.0.1', resolve))
  t.after(() => { mock.closeAllConnections(); mock.close() })
  const address = mock.address()
  assert.ok(address && typeof address !== 'string')
  const { db, schema } = await import('../src/db/index.js')
  const { default: dramas } = await import('../src/routes/dramas.js')
  const app = new Hono().route('/api/v1/dramas', dramas)
  const timestamp = new Date().toISOString()
  const config = db.insert(schema.aiServiceConfigs).values({
    name: 'Text', serviceType: 'text', provider: 'openai', baseUrl: `http://127.0.0.1:${address.port}`,
    apiKey: 'fixture', model: 'script-test', createdAt: timestamp, updatedAt: timestamp,
  }).returning().get()
  const options = { model: 'script-test', config_id: config.id, duration: '1–2m', episode_count: 2 }
  let seq = 0
  const nextId = () => (++seq).toString(16).padStart(32, '0')
  async function request(path: string, method = 'GET', body?: object) {
    const res = await app.request('/api/v1/dramas' + path, { method, body: body && JSON.stringify(body) })
    return { status: res.status, ...(await res.json() as { data: any; message: string }) }
  }
  async function waitFor(project: number, status: string) {
    for (let i = 0; i < 500; i++) {
      const result = await request(`/${project}/script`)
      if (result.data?.job?.status === status) return result.data
      if (result.data?.job?.status === 'failed' && status !== 'failed') assert.fail(JSON.stringify(result.data.job))
      await delay(10)
    }
    assert.fail(`Project ${project} did not reach ${status}`)
  }
  const initial = { title: '车站', script_creation: { ...options, request_id: nextId(), source_type: 'ai', idea: '悬疑短剧' } }
  const [created, duplicate] = await Promise.all([request('', 'POST', initial), request('', 'POST', initial)])
  assert.equal(created.status, 201)
  assert.equal(duplicate.data.id, created.data.id)
  const project = created.data.id
  const root = `/${project}/script`
  const stopped = await waitFor(project, 'failed')
  assert.equal(stopped.job.error_code, 'truncated')
  assert.equal(stopped.outline.synopsis, '车站之谜')
  assert.equal(stopped.job.parts.length, 1)
  assert.equal((await request(`/${project}`)).data.episodes.length, 0)
  assert.equal((await request(root + `/jobs/${stopped.job.id}/preview/1`)).data.script, scene)
  assert.equal((await request(root + `/jobs/${stopped.job.id}/retry`, 'POST', {})).status, 200)
  await waitFor(project, 'completed')
  assert.equal(requests.filter(prompt => prompt.includes('"ordinal":1')).length, 1)
  const current = (await request(`/${project}`)).data.episodes
  assert.equal(current.length, 2)
  assert.equal(current[0].script_content, scene)
  assert.equal(current[0].image_config_id, null)

  const newOutline = { synopsis: '新版简介', characters: '柳青', arc: '车站继续运转' }
  assert.equal((await request(root + '/outline', 'PUT', { revision: stopped.revision, outline: newOutline })).status, 200)
  db.run(sql.raw(`CREATE TEMP TRIGGER reject_continuation BEFORE INSERT ON episodes
    WHEN new.episode_number = 3 BEGIN SELECT RAISE(ABORT, 'test insertion failure'); END`))
  const follow = await request(root + '/jobs', 'POST', { ...options, request_id: nextId(), kind: 'continue', episode_count: 1 })
  assert.equal(follow.status, 201)
  const failedPublish = await waitFor(project, 'failed')
  assert.equal(failedPublish.job.error_code, 'publish_failed')
  assert.equal((await request(`/${project}`)).data.episodes.length, 2)
  assert.ok(requests.at(-1)?.includes('新版简介'))
  const callsBeforePublishRetry = requests.length
  db.run(sql.raw('DROP TRIGGER reject_continuation'))
  db.update(schema.aiServiceConfigs).set({ isActive: false }).where(eq(schema.aiServiceConfigs.id, config.id)).run()
  assert.equal((await request(root + `/jobs/${follow.data.id}/retry`, 'POST', {})).status, 200)
  await waitFor(project, 'completed')
  assert.equal(requests.length, callsBeforePublishRetry)
  db.update(schema.aiServiceConfigs).set({ isActive: true }).where(eq(schema.aiServiceConfigs.id, config.id)).run()
  assert.deepEqual((await request(`/${project}`)).data.episodes.map((episode: any) => episode.episode_number), [1, 2, 3])

  const episodeId = current[0].id
  const episodeRoute = root + '/episodes/' + episodeId
  const original = (await request(episodeRoute)).data
  const edit = await request(episodeRoute, 'PUT', { revision: original.revision, title: '改名', script: scene })
  assert.equal(edit.status, 200)
  const edited = (await request(episodeRoute)).data
  const rewrite = await request(root + '/jobs', 'POST', {
    ...options, request_id: nextId(), kind: 'rewrite', target_id: episodeId, revision: edited.revision, idea: '加快节奏',
  })
  assert.equal(rewrite.status, 201)
  const review = await waitFor(project, 'review')
  const preview = await request(root + `/jobs/${review.job.id}/preview/1`)
  assert.equal(preview.data.original, scene)
  assert.equal((await request(episodeRoute)).data.title, '改名')
  await request(episodeRoute + '/production', 'POST')
  const blocked = await request(root + `/jobs/${review.job.id}/resolve`, 'POST', { apply: true })
  assert.equal(blocked.message, 'production_locked')
  assert.equal((await request(episodeRoute)).data.editable, false)
  await request(root + `/jobs/${review.job.id}/resolve`, 'POST', { apply: false })
  const otherRoute = root + '/episodes/' + current[1].id
  const other = (await request(otherRoute)).data
  const another = await request(root + '/jobs', 'POST', {
    ...options, request_id: nextId(), kind: 'rewrite', target_id: current[1].id, revision: other.revision, idea: '强调对白',
  })
  assert.equal(another.status, 201)
  const approved = await waitFor(project, 'review')
  const action = root + `/jobs/${approved.job.id}/resolve`
  assert.equal((await request(action, 'POST', { apply: true })).status, 200)
  assert.equal((await request(action, 'POST', { apply: true })).status, 200)
  assert.equal((await request(otherRoute)).data.script, scene)

  const upload = async (source: string, count: number) => {
    const response = await request('', 'POST', {
      title: '上传剧本', script_creation: {
        ...options, request_id: nextId(), episode_count: count, source_type: 'upload', source_text: source,
      },
    })
    assert.equal(response.status, 201)
    await waitFor(response.data.id, 'completed')
    assert.equal((await request(`/${response.data.id}/script/source`)).data.source, source)
    return (await request(`/${response.data.id}`)).data.episodes
  }
  const numbered = await upload(`第一集 出发\n${scene}\n\n第二集 等待\n${scene}`, 5)
  assert.equal(numbered.length, 2)
  assert.equal(numbered[0].title, '出发')
  assert.equal(numbered[0].script_content, scene + '\n\n')
  const continuous = '柳青到达车站。\n\n她发现已经错过最后一班车，就沿轨道寻找另一条路。'
  const converted = await upload(continuous, 2)
  assert.equal(converted.length, 2)
  assert.equal(converted.map((episode: any) => episode.content).join(''), continuous)
  assert.ok(converted.every((episode: any) => formattedScript.safeParse(episode.script_content).success))
})
