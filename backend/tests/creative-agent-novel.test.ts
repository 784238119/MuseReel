import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { eq } from 'drizzle-orm'

test('creative tools create, revise, and split a novel into episodes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'musereel-creative-novel-'))
  process.env.SQLITE_PATH = join(directory, 'test.sqlite')
  process.env.DATA_ROOT = directory
  process.env.WORKSPACE_PATH = join(directory, 'workspace')
  process.env.MYSQL_AUTO_IMPORT = 'false'
  t.after(() => rm(directory, { recursive: true, force: true }))

  const calls: string[] = []
  const mock = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const payload = JSON.parse(Buffer.concat(chunks).toString())
    const prompt = payload.messages.at(-1).content as string
    const input = prompt.split('\n').findLast((line: string) => /^[\[{]/.test(line))
    calls.push(prompt.slice(0, 20))
    let result: unknown
    if (prompt.startsWith('分析小说原稿')) result = { summary: '潮汐档案的连续情节与人物状态。' }
    else if (prompt.startsWith('润色指定')) result = { content: JSON.parse(input).excerpt }
    else if (prompt.startsWith('为小说分集')) {
      result = { choices: JSON.parse(input).map(() => 0) }
    } else if (prompt.startsWith('按顺序为以下分集')) {
      result = { titles: JSON.parse(input).map((_: unknown, index: number) => `潮汐第 ${index + 1} 集`) }
    } else {
      result = { summary: '未知测试请求' }
    }
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({
      id: 'creative-novel-test', object: 'chat.completion', created: 0, model: payload.model,
      choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(result) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }))
  })
  await new Promise<void>(resolve => mock.listen(0, '127.0.0.1', resolve))
  t.after(() => { mock.closeAllConnections(); mock.close() })
  const address = mock.address()
  assert.ok(address && typeof address !== 'string')

  const { db, schema } = await import('../src/db/index.js')
  const { creativeTools } = await import('../src/agents/tools/creative-tools.js')
  const timestamp = new Date().toISOString()
  const baseUrl = `http://127.0.0.1:${address.port}`
  const config = (serviceType: string, model: string) => db.insert(schema.aiServiceConfigs).values({
    name: serviceType, serviceType, provider: serviceType === 'video' ? 'volcengine' : 'openai',
    baseUrl, apiKey: 'fixture', model,
    createdAt: timestamp, updatedAt: timestamp,
  }).returning().get()
  const text = config('text', 'creative-novel-test')
  const image = config('image', 'image-test')
  const video = config('video', 'video-test')
  const project = db.insert(schema.dramas).values({ title: '潮汐档案', status: 'draft',
    createdAt: timestamp, updatedAt: timestamp }).returning().get()
  db.insert(schema.characters).values({ dramaId: project.id, name: '林舟', role: '灯塔看守',
    description: '追查失踪货轮的青年', createdAt: timestamp, updatedAt: timestamp }).run()
  const tools = creativeTools({
    projectId: project.id, sessionId: 1, turnId: 1, contentLanguage: 'zh', configId: text.id, model: text.model!,
    authorized: async () => true,
    start: () => {},
    finish: () => {},
    commit: (callId, write) => db.transaction(tx => {
      const result = write(tx)
      if ('error' in result) return result
      const change = tx.insert(schema.creativeChanges).values({ ...result, turnId: 1, callId }).returning().get()
      return { saved: true, ...change, episode_id: change.episodeId, episode_number: change.episodeNumber,
        novel_id: change.novelId, part_number: change.partNumber }
    }, { behavior: 'immediate' }),
  }) as Record<string, { execute: (input: unknown, context?: unknown) => Promise<any> }>
  const execute = (name: string, input: unknown) => tools[name].execute(input, {})

  const assets = await execute('read_project_assets', { kind: 'characters', limit: 5 })
  assert.deepEqual(assets.items.map((item: { name: string }) => item.name), ['林舟'])
  const created = await execute('create_novel', { title: '潮汐档案', premise: '失忆的灯塔看守寻找失踪船只。' })
  assert.equal(created.saved, true)
  assert.equal(created.kind, 'novel')
  const novelId = created.novel_id as number
  const planned = await execute('save_novel_plan', { novel_id: novelId, base_revision: 1,
    plan: '林舟追查失踪货轮，发现港口所有人的证词互相矛盾。' })
  assert.equal(planned.revision, '2')
  const context = await execute('read_novel_context', { novel_id: novelId })
  assert.equal(context.draft_revision, 2)
  assert.equal(context.status, 'ready')

  const partText = '林舟在午夜走进灯塔，潮水已经漫过台阶。\n\n'
    + '值班簿上只有一行新墨迹：船没有沉，是所有人把它藏了起来。\n\n'
    + '他抬头时，旧收音机自己响了，里面传来失踪船长三年前的声音。'
  const appended = await execute('append_novel_part', { novel_id: novelId, base_revision: 2, part_number: 1,
    title: '午夜灯塔', content: partText, summary: '林舟发现货轮失踪与港口众人有关，并听见船长旧录音。' })
  assert.equal(appended.revision, '3')
  const read = await execute('read_novel_manuscript', { novel_id: novelId, part_number: 1, tail: true })
  assert.match(read.content, /失踪船长/)

  const replaced = await execute('replace_novel_text', { novel_id: novelId, base_revision: 3, part_number: 1,
    original_text: '所有人把它藏了起来', content: '港口董事会把它藏了起来',
    summary: '林舟发现港口董事会隐瞒货轮踪迹，并听见船长旧录音。' })
  assert.equal(replaced.revision, '4')
  const current = await execute('read_novel_manuscript', { novel_id: novelId, part_number: 1 })
  assert.match(current.content, /港口董事会/)
  assert.doesNotMatch(current.content, /所有人把它藏了起来/)

  const split = await execute('split_novel_to_episodes', { novel_id: novelId, base_revision: 4, episode_count: 2 })
  assert.equal(split.saved, true, JSON.stringify(split))
  let job = db.select().from(schema.novelJobs).where(eq(schema.novelJobs.id, novelId)).get()!
  for (let attempt = 0; attempt < 250 && !['completed', 'failed'].includes(job.status); attempt++) {
    await delay(20)
    job = db.select().from(schema.novelJobs).where(eq(schema.novelJobs.id, novelId)).get()!
  }
  assert.equal(job.status, 'completed', job.errorCode ?? undefined)
  const episodes = db.select().from(schema.episodes).where(eq(schema.episodes.dramaId, project.id)).all()
  assert.equal(episodes.length, 2)
  assert.ok(episodes.every(episode => episode.imageConfigId === image.id && episode.videoConfigId === video.id))
  assert.equal((await execute('append_novel_part', { novel_id: novelId, base_revision: 4, part_number: 2,
    title: '不应追加', content: '已发布小说不能继续原地写入。', summary: '不应保存。' })).error, 'novel_locked')
  assert.deepEqual(
    db.select({ kind: schema.creativeChanges.kind, novelId: schema.creativeChanges.novelId })
      .from(schema.creativeChanges).where(eq(schema.creativeChanges.turnId, 1)).all()
      .map(change => change.kind),
    ['novel', 'novel', 'novel', 'novel', 'novel'],
  )
  assert.ok(calls[0]?.startsWith('分析小说原稿'))
  assert.ok(calls[1]?.startsWith('润色指定的小说片段'))
  assert.ok(calls[2]?.startsWith('为小说分集'))
  assert.ok(calls[3]?.startsWith('按顺序为以下分集'))
})
