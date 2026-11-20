import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'

const script = (text: string) => `## S01 | 内景 · 灯塔 | 夜\n\n${text}`
const original = '沈青：你到底还瞒了我什么？'
const revised = '沈青：那天晚上，你也在。'
const opening = '给两个结局方向。'
const outlineRequest = '用第二个结局，保存项目大纲。'
const multiRequest = '读前两集，把第 2 集结尾的对白改得更克制并保存，再写第 3 集。'
const outline = { synopsis: '沈青在灯塔找人。', characters: '沈青守灯。', arc: '停电时来访者出现。' }

test('project creative chat streams real reads and writes, resumes context and respects script boundaries', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'musereel-creative-test-'))
  process.env.SQLITE_PATH = join(directory, 'test.sqlite')
  process.env.DATA_ROOT = directory
  process.env.WORKSPACE_PATH = join(directory, 'workspace')
  process.env.MYSQL_AUTO_IMPORT = 'false'
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { db, schema } = await import('../src/db/index.js')
  const { default: dramas } = await import('../src/routes/dramas.js')
  const app = new Hono().route('/api/v1/dramas', dramas)
  const phases = new Map<string, number>()
  const errors: unknown[] = []
  let releaseBlocked!: () => void
  const blocked = new Promise<void>(resolve => { releaseBlocked = resolve })
  let episode2 = 0
  let novelId = 0
  let baseVersion = ''
  const readRevision = () => db.select({ revision: schema.episodes.updatedAt }).from(schema.episodes)
    .where(eq(schema.episodes.id, episode2)).get()!.revision
  const mock = createServer(async (req, res) => {
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const data = JSON.parse(Buffer.concat(chunks).toString())
      const message = data.messages.findLast((item: { role: string }) => item.role === 'user').content as string
      const system = data.messages.find((item: { role: string }) => item.role === 'system')?.content as string
      const completion = { id: 'chatcmpl-test', created: 1, model: data.model }
      if (!data.stream) {
        assert.match(system, /Decide whether the current author's message/)
        const decision = JSON.parse(message)
        res.setHeader('Content-Type', 'application/json')
        return res.end(JSON.stringify({ ...completion, object: 'chat.completion', choices: [{ index: 0,
          finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ allowed: !decision.message.includes('仅预览') }) } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
      }
      const phase = phases.get(message) ?? 0
      phases.set(message, phase + 1)
      let delta: Record<string, unknown> = {}
      let finish = 'stop'
      function tool(name: string, input: object) {
        assert.ok(data.tools.some((item: { function: { name: string } }) => item.function.name === name), name)
        delta = { tool_calls: [{ index: 0, id: `call_${phase}`, type: 'function',
          function: { name, arguments: JSON.stringify(input) } }] }
        finish = 'tool_calls'
      }
      const text = (content: string) => { delta = { content } }
      function edit(version: string, before: string, after: string) {
        tool('edit_episode_scene', { episode_id: episode2, base_revision: version, scene: 'S01', original_text: before, content: after })
      }
      function create(number: number) {
        tool('create_episode_script', { episode_number: number, title: '停电', script: script('门外传来敲门声。') })
      }
      if (message === opening) text('一、黎明来信。二、停电后出现来访者。')
      else if (message === outlineRequest) {
        assert.ok(data.messages.some((item: { content: string }) => item.content?.includes('黎明来信')))
        if (phase === 0) tool('save_project_outline', { base_revision: 0, outline })
        else text('项目大纲已保存。')
      } else if (message === multiRequest) {
        if (phase < 2) tool('read_episode_script', { episode_number: phase + 1 })
        else if (phase === 2) edit(baseVersion, original, revised)
        else if (phase === 3) create(3)
        else text('第 2 集结尾已修改，第 3 集已保存。')
      } else if (message === '仅预览第 2 集改法。') {
        if (!phase) edit(readRevision(), revised, '不应保存。')
        else text('这是预览。')
      } else if (message === '用旧版本保存第 2 集。') {
        if (!phase) edit(baseVersion, revised, '版本冲突。')
        else text('剧本版本发生变化。')
      } else if (message === '修改第 2 集并新建第 4 集。') {
        if (!phase) edit(readRevision(), revised, '沈青：你也听见了。')
        else if (phase === 1) create(3)
        else text('第 2 集已经保存。新增剧集的集号发生冲突。')
      } else if (message === '继续未完成步骤。') {
        if (!phase) edit(readRevision(), '沈青：你也听见了。', '不应重复保存。')
        else if (phase === 1) create(4)
        else text('第 4 集已创建。')
      } else if (message === '保存制作中的第 2 集。') {
        if (!phase) edit(readRevision(), '沈青：你也听见了。', '不应修改已锁定的剧本。')
        else text('第 2 集已进入制作。')
      } else if (message === '新建小说并保存第一章。') {
        if (phase === 0) tool('create_novel', { title: '潮汐档案', premise: '灯塔看守追查失踪货轮。' })
        else if (phase === 1) {
          novelId = db.select({ id: schema.novelJobs.id }).from(schema.novelJobs)
            .where(eq(schema.novelJobs.dramaId, project)).get()!.id
          tool('save_novel_plan', { novel_id: novelId, base_revision: 1, plan: '林舟追查失踪货轮，港口证词互相矛盾。' })
        } else if (phase === 2) {
          tool('append_novel_part', { novel_id: novelId, base_revision: 2, part_number: 1, title: '午夜灯塔',
            content: '林舟在午夜走进灯塔。\n\n值班簿写着：港口所有人把它藏了起来。', summary: '林舟发现港口隐瞒失踪货轮。' })
        } else if (phase === 3) {
          tool('replace_novel_text', { novel_id: novelId, base_revision: 3, part_number: 1,
            original_text: '港口所有人把它藏了起来', content: '港口董事会把它藏了起来',
            summary: '林舟发现港口董事会隐瞒失踪货轮。' })
        } else text('小说第一章已经保存。')
      } else if (message === '测试停止。') {
        await blocked
        text('迟到的回复。')
      } else throw new Error(`Unexpected test message: ${message}`)
      res.setHeader('Content-Type', 'text/event-stream')
      for (const choice of [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null },
        { index: 0, delta: {}, finish_reason: finish }]) {
        res.write(`data: ${JSON.stringify({ ...completion, object: 'chat.completion.chunk', choices: [choice] })}\n\n`)
      }
      res.end('data: [DONE]\n\n')
    } catch (error) { errors.push(error); res.writeHead(500).end() }
  })
  await new Promise<void>(resolve => mock.listen(0, '127.0.0.1', resolve))
  t.after(() => { releaseBlocked(); mock.closeAllConnections(); mock.close(); assert.deepEqual(errors, []) })
  const address = mock.address()
  assert.ok(address && typeof address !== 'string')
  const timestamp = new Date().toISOString()
  db.insert(schema.aiServiceConfigs).values({ name: 'Fixture', serviceType: 'text', provider: 'openai',
    baseUrl: `http://127.0.0.1:${address.port}`, model: 'creative-test', apiKey: 'fixture', createdAt: timestamp, updatedAt: timestamp }).run()
  const request = async (path: string, method = 'GET', body?: object) => {
    const result = await app.request(`/api/v1${path}`, { method, body: body && JSON.stringify(body) })
    return { status: result.status, ...(await result.json() as { data: any; message: string }) }
  }
  const project = (await request('/dramas', 'POST', { title: '灯塔来信' })).data.id
  const other = (await request('/dramas', 'POST', { title: '其他项目' })).data.id
  const root = `/dramas/${project}/creative-agent`
  const searchProject = (await request('/dramas', 'POST', { title: '资料搜索' })).data.id
  db.insert(schema.episodes).values(Array.from({ length: 61 }, (_, index) => ({
    dramaId: searchProject,
    episodeNumber: index + 1,
    title: index === 60 ? '第 61 集的远方线索' : `普通剧集 ${index + 1}`,
    createdAt: timestamp,
    updatedAt: timestamp,
  }))).run()
  const searched = await request(`/dramas/${searchProject}/creative-agent/resources?query=${encodeURIComponent('远方线索')}`)
  assert.deepEqual(searched.data.episodes.map((episode: { number: number }) => episode.number), [61])
  assert.equal(searched.data.next_after_episode, null)
  const putEpisode = (dramaId: number, number: number, content: string) => db.insert(schema.episodes).values({ dramaId,
    episodeNumber: number, title: `剧本 ${number}`, scriptContent: script(content), createdAt: timestamp, updatedAt: timestamp,
  }).returning().get()
  putEpisode(project, 1, '灯塔传来警报。')
  const second = putEpisode(project, 2, original)
  episode2 = second.id
  baseVersion = second.updatedAt
  const foreign = putEpisode(other, 1, '其他项目原文。')
  const requestId = (index: number) => index.toString(16).padStart(32, '0')
  async function readStream(id: number, after = 0) {
    const response = await app.request(`/api/v1${root}/turns/${id}/events?after_seq=${after}`)
    assert.equal(response.status, 200)
    return (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
  }
  assert.equal((await request(`${root}/turns`, 'POST', { request_id: requestId(10), message: '打开原文',
    references: [{ kind: 'episode', id: foreign.id }] })).message, 'reference_not_found')
  const initial = { request_id: requestId(1), message: opening }
  const first = await request(`${root}/turns`, 'POST', initial)
  assert.equal(first.status, 201)
  const same = await request(`${root}/turns`, 'POST', initial)
  assert.equal(same.data.id, first.data.id)
  const sessionId = first.data.session_id
  const firstEvents = await readStream(first.data.id)
  assert.equal(firstEvents.at(-1).payload.status, 'completed')
  assert.match(firstEvents.filter(event => event.kind === 'text').map(event => event.payload.text).join(''), /停电后出现/)
  const run = async (index: number, message: string, resume_from_id?: number) => {
    const submitted = await request(`${root}/turns`, 'POST', { request_id: requestId(index), session_id: sessionId, message, resume_from_id })
    assert.equal(submitted.status, 201, submitted.message)
    return { id: submitted.data.id, events: await readStream(submitted.data.id) }
  }

  const planned = await run(2, outlineRequest)
  assert.equal(planned.events.at(-1).payload.status, 'completed')
  assert.deepEqual((await request(`/dramas/${project}/script`)).data.outline, outline)
  const multi = await run(3, multiRequest)
  assert.ok(multi.events.every(event => typeof event.created_at === 'string'))
  assert.deepEqual(multi.events.filter(event => event.kind === 'tool_started').map(event => event.payload.tool),
    ['read_episode_script', 'read_episode_script', 'edit_episode_scene', 'create_episode_script'])
  const saved = multi.events.filter(event => event.payload.change)
  assert.deepEqual(saved.map(event => event.payload.change.episode_number), [2, 3])
  assert.equal(multi.events.at(-1).payload.status, 'completed')
  const change = await request(`${root}/turns/${multi.id}/changes/${saved[0].payload.change.id}`)
  assert.deepEqual([change.data.before, change.data.after], [original, revised])
  assert.equal((await request(`/dramas/${project}/script/episodes/${episode2}`)).data.script, script(revised))
  assert.equal((await request(`/dramas/${other}/creative-agent/sessions/${sessionId}/turns`)).status, 404)
  assert.deepEqual(await readStream(multi.id, saved[0].seq), multi.events.filter(event => event.seq > saved[0].seq))

  const preview = await run(4, '仅预览第 2 集改法。')
  assert.equal(preview.events.find(event => event.kind === 'tool_finished').payload.error, 'write_not_requested')
  const conflict = await run(5, '用旧版本保存第 2 集。')
  assert.equal(conflict.events.find(event => event.kind === 'tool_finished').payload.error, 'script_conflict')
  const partial = await run(6, '修改第 2 集并新建第 4 集。')
  assert.equal(partial.events.at(-1).payload.status, 'partial')
  assert.equal(partial.events.filter(event => event.payload.change).length, 1)
  const resumed = await run(7, '继续未完成步骤。', partial.id)
  assert.equal(resumed.events.find(event => event.kind === 'tool_finished').payload.error, 'already_saved_in_previous_turn')
  assert.deepEqual(resumed.events.filter(event => event.payload.change).map(event => event.payload.change.episode_number), [4])
  assert.match((await request(`/dramas/${project}/script/episodes/${episode2}`)).data.script, /你也听见了/)

  await request(`/dramas/${project}/script/episodes/${episode2}/production`, 'POST')
  const locked = await run(8, '保存制作中的第 2 集。')
  assert.equal(locked.events.find(event => event.kind === 'tool_finished').payload.error, 'production_locked')
  const stalled = await request(`${root}/turns`, 'POST', { request_id: requestId(9), session_id: sessionId, message: '测试停止。' })
  assert.equal((await request(`${root}/turns/${stalled.data.id}/stop`, 'POST')).data.status, 'stopped')
  assert.equal((await readStream(stalled.data.id)).at(-1).payload.status, 'stopped')
  const history = await request(`${root}/sessions/${sessionId}/turns`)
  assert.equal(history.data.turns.length, 9)
  assert.equal(history.data.events.filter((event: { payload: { change?: object } }) => event.payload.change).length, 5)
  const listedSessions = (await request(`${root}/sessions`)).data.sessions
  assert.equal(listedSessions[0].last_status, 'stopped')
  assert.equal(listedSessions[0].last_model, 'creative-test')
  const novelRun = await run(11, '新建小说并保存第一章。')
  assert.equal(novelRun.events.at(-1).payload.status, 'completed')
  assert.deepEqual(novelRun.events.filter(event => event.kind === 'tool_started').map(event => event.payload.tool),
    ['create_novel', 'save_novel_plan', 'append_novel_part', 'replace_novel_text'])
  assert.equal(novelRun.events.filter(event => event.payload.change?.kind === 'novel').length, 4)
  const firstNovelChange = novelRun.events.find(event => event.payload.change?.kind === 'novel').payload.change
  assert.equal((await request(`${root}/turns/${novelRun.id}/changes/${firstNovelChange.id}`)).data.novel_id, novelId)
  const novel = db.select().from(schema.novelJobs).where(eq(schema.novelJobs.id, novelId)).get()!
  assert.equal(novel.draftRevision, 4)
  assert.match(novel.storyPlan!, /港口证词/)
  assert.match(db.select().from(schema.novelManuscriptParts)
    .where(eq(schema.novelManuscriptParts.jobId, novelId)).get()!.draft, /港口董事会/)
  assert.equal((await request(`${root}/sessions`)).data.sessions[0].last_status, 'completed')
})
