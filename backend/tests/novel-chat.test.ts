import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { requestLogger } from '../src/middleware/logger.js'

test('novel chat remembers choices, proposes exact edits, and splits the adopted draft', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'musereel-novel-chat-'))
  process.env.SQLITE_PATH = join(directory, 'chat.sqlite')
  process.env.DATA_ROOT = directory
  process.env.MYSQL_AUTO_IMPORT = 'false'
  process.env.WORKSPACE_PATH = join(directory, 'workspace')
  t.after(() => rm(directory, { recursive: true, force: true }))
  const plan = '姐姐沈青在灯塔寻找失踪的妹妹。铜钥匙用来打开暗室。'
  const original = '她走到门口。'
  const remainder = '铜钥匙还在妹妹留下的信封里。'
  const revised = '门没锁。沈青收回正要敲门的手。'
  const searchTerm = '伏笔是这张纸条：\n"潮水退后再回来。"'
  const searchablePlan = `${'她沿着海岸找到了废弃的信标。'.repeat(150)}\n\n${searchTerm}`
  const imported = '原文在窗前。\n\n线索仍在桌上。'
  const finalImport = imported.replace('原文在窗前。', '雨打在落地窗上。')
  const longProse = Array.from({ length: 200 }, (_, index) =>
    `海边的石阶${index}。${'潮声沿着长阶的边缘缓缓传到紧闭的窗前。'.repeat(4)}`).join('\n\n')
  const longPart = `\n\n# 潮声\n\n${longProse}`
  let longPolishCalls = 0
  let candidateId: number
  let searchableCandidateId: number
  let retryCalls = 0
  let staleRetryCalls = 0
  let duplicateProposalCalls = 0
  let discussionCalls = 0
  let releaseDiscussion!: () => void
  let releaseLockedDiscussion!: () => void
  let releaseSplit!: () => void
  const blockedDiscussion = new Promise<void>(resolve => { releaseDiscussion = resolve })
  const blockedLockedDiscussion = new Promise<void>(resolve => { releaseLockedDiscussion = resolve })
  const blockedSplit = new Promise<void>(resolve => { releaseSplit = resolve })
  const modelErrors: unknown[] = []
  const checkedTools = new Set<string>()

  const mock = createServer(async (request, response) => {
    try {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const userIndex = payload.messages.findLastIndex((message: { role: string }) => message.role === 'user')
      const prompt: string = payload.messages[userIndex].content
      const systemPrompt = String(payload.messages.find((message: { role: string }) => message.role === 'system')?.content ?? '')
      const toolReplies = new Map(payload.messages.slice(userIndex + 1).filter((message: { role: string }) => message.role === 'tool')
        .map((message: { tool_call_id: string; content: string }) => [message.tool_call_id, JSON.parse(message.content)]))
      const toolResult = (name: string): any => toolReplies.get(`call_${name}`)
      const tool = (name: string, args: object, callId = `call_${name}`) => {
        assert.ok(payload.tools.find((entry: { function: { name: string } }) => entry.function.name === name))
        checkedTools.add(name)
        return { index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
          tool_calls: [{ id: callId, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }
      }
      const reply = (content: string, finish_reason = 'stop') =>
        ({ index: 0, finish_reason, message: { role: 'assistant', content } })
      const proposal = (args: object) => {
        const result = toolResult('propose_novel_edit')
        if (!result) return tool('propose_novel_edit', args)
        assert.equal(result.proposed, true)
        return reply('候选稿已提交。')
      }
      let choice: ReturnType<typeof reply> | ReturnType<typeof tool>
      if (prompt === '讨论两个方向') {
        discussionCalls++
        await blockedDiscussion
        choice = reply('一、雨夜车站。二、灯塔寻人。')
      } else if (prompt === '用第二个方向定大纲') {
        assert.ok(payload.messages.some((message: { content: string }) => message.content === '一、雨夜车站。二、灯塔寻人。'))
        const context = toolResult('read_novel_context')
        if (!context) choice = tool('read_novel_context', { history_query: '灯塔' })
        else {
          assert.deepEqual(context.history.map((turn: { message: string }) => turn.message), ['讨论两个方向'])
          choice = proposal({ kind: 'plan', content: plan })
        }
      } else if (prompt === '按刚才的大纲写第一章') {
        assert.ok(payload.messages.some((message: { content: string }) => message.content?.includes(plan)))
        choice = proposal({ kind: 'append', title: '未锁的门', content: `${original}\n\n${remainder}`, summary: '钥匙在信封里' })
      } else if (prompt === '只改第一章开头') {
        const manuscript = toolResult('read_novel_manuscript')
        if (!manuscript) choice = tool('read_novel_manuscript', { part_number: 1 })
        else {
          assert.ok(manuscript.content.includes(original))
          choice = proposal({ kind: 'replace', part_number: 1, original_text: original, content: '门虚掩着。', summary: remainder })
        }
      } else if (prompt === '将刚才的候选再改一遍') {
        const manuscript = toolResult('read_novel_manuscript')
        if (!manuscript) choice = tool('read_novel_manuscript', { candidate_turn_id: candidateId })
        else {
          assert.equal(manuscript.content, '门虚掩着。')
          choice = proposal({ kind: 'replace', part_number: 1, original_text: original, content: revised, summary: remainder })
        }
      } else if (prompt === '接着写第二章') {
        const manuscript = toolResult('read_novel_manuscript')
        if (!manuscript) choice = tool('read_novel_manuscript', { tail: true })
        else {
          assert.equal(manuscript.content, `# 未锁的门\n\n${revised}\n\n${remainder}`)
          choice = proposal({ kind: 'append', title: '暗室', content: '沈青从信封取出钥匙，打开暗室。', summary: '沈青用钥匙打开暗室。' })
        }
      } else if (prompt.startsWith('换模型修改导入稿')) {
        const language = prompt.slice(-2)
        const outputLanguage = { en: 'English', ja: '日本語 (Japanese)', ko: '한국어 (Korean)' }[language as 'en' | 'ja' | 'ko']
        assert.equal(payload.model, 'second-model')
        assert.ok(systemPrompt.includes(`MUST be written in ${outputLanguage}.`))
        assert.match(systemPrompt, /new prose \(content and chapter title\) MUST use the existing manuscript language/)
        assert.match(systemPrompt, /Copy original_text verbatim/)
        const manuscript = toolResult('read_novel_manuscript')
        if (!manuscript) choice = tool('read_novel_manuscript', { quote: '原文在窗前。' })
        else {
          assert.equal(manuscript.content, imported)
          choice = proposal({ kind: 'replace', part_number: 1, original_text: '原文在窗前。', content: '雨打在落地窗上。', summary: '线索在桌上。' })
        }
      } else if (prompt === '锁定期间讨论') {
        await blockedLockedDiscussion
        choice = reply('锁定讨论完成。')
      } else if (prompt === '稍后重试') {
        if (++staleRetryCalls === 1) choice = reply('截断', 'length')
        else {
          assert.ok(payload.messages.some((message: { content: string }) => message.content === '以晴天为准。'))
          choice = reply('按晴天继续。')
        }
      } else if (prompt === '后续决定') {
        assert.ok(payload.messages.some((message: { role: string; content: string }) =>
          message.role === 'user' && message.content === '稍后重试'))
        assert.ok(!payload.messages.some((message: { role: string; content: string | null; tool_calls?: unknown[] }) =>
          message.role === 'assistant' && !message.content && !message.tool_calls?.length))
        const context = toolResult('read_novel_context')
        if (!context) choice = tool('read_novel_context', { history_query: '稍后重试' })
        else {
          assert.deepEqual(context.history.map(({ message, status, reply }: { message: string; status: string; reply: string | null }) =>
            ({ message, status, reply })), [{ message: '稍后重试', status: 'failed', reply: null }])
          choice = reply('以晴天为准。')
        }
      } else if (prompt === '查找旧提案') {
        const context = toolResult('read_novel_context')
        const manuscript = toolResult('read_novel_manuscript')
        if (!context) choice = tool('read_novel_context', { history_query: searchTerm })
        else if (!manuscript) {
          const candidate = context.history.find((turn: { id: number }) => turn.id === searchableCandidateId)
          assert.ok(candidate.proposal_excerpt.includes(searchTerm))
          choice = tool('read_novel_manuscript', { candidate_turn_id: candidate.id })
        } else {
          assert.equal(manuscript.content, searchablePlan)
          choice = reply('找到旧提案。')
        }
      } else if (prompt === '另拟故事规划') {
        choice = proposal({ kind: 'plan', content: searchablePlan })
      } else if (prompt === '同轮提交两份候选') {
        const results = Array.from(toolReplies.values()) as { proposed?: boolean; error?: string }[]
        if (!results.length) choice = tool('propose_novel_edit', { kind: 'plan', content: '保留第一份。' })
        else if (results.some(result => result.error === 'proposal_already_submitted')) {
          assert.equal(duplicateProposalCalls, 1)
          choice = reply('第一份候选已提交。')
        } else {
          assert.ok(results.some(result => result.proposed))
          assert.equal(++duplicateProposalCalls, 1)
          choice = tool('propose_novel_edit', { kind: 'plan', content: '尝试覆盖第一份。' }, 'second_proposal')
        }
      } else if (prompt === '补写一个长章节') {
        choice = proposal({ kind: 'append', title: '潮声', content: longProse, summary: '风雨加剧。' })
      } else if (prompt.startsWith('分析小说原稿') || prompt.startsWith('润色指定')) {
        const { excerpt } = JSON.parse(prompt.split('\n').find(line => line.startsWith('{'))!)
        if (excerpt !== finalImport) {
          if (prompt.startsWith('分析小说原稿')) assert.equal(excerpt, longPart)
          else {
            assert.ok(longPart.includes(excerpt))
            assert.ok(excerpt.length <= 3200)
            longPolishCalls++
          }
        }
        await blockedSplit
        choice = reply(JSON.stringify(prompt.startsWith('分析') ? { summary: '窗外下雨。' } : { content: excerpt }))
      } else if (prompt.startsWith('按顺序为以下分集')) {
        choice = reply(JSON.stringify({ titles: ['窗前'] }))
      } else if (prompt === '验证失败后重试') {
        choice = ++retryCalls === 1 ? reply('截断', 'length') : reply('重试完成。')
      } else if (prompt === '恢复同一轮') {
        choice = reply('中断后恢复。')
      } else {
        throw new Error('Unexpected model request')
      }
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ id: 'completion', object: 'chat.completion', created: 1,
        model: payload.model, choices: [choice], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
    } catch (error) {
      modelErrors.push(error)
      t.diagnostic(error instanceof Error ? error.stack ?? error.message : String(error))
      response.writeHead(500).end()
    }
  })
  await new Promise<void>(resolve => mock.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    releaseDiscussion()
    releaseLockedDiscussion()
    releaseSplit()
    mock.closeAllConnections()
    mock.close()
  })
  const address = mock.address()
  assert.ok(address && typeof address !== 'string')
  const { db, schema } = await import('../src/db/index.js')
  const { default: dramas } = await import('../src/routes/dramas.js')
  const app = new Hono().use('*', requestLogger).route('/api/v1/dramas', dramas)
  t.after(() => assert.deepEqual(modelErrors, []))
  const request = async (path: string, method = 'GET', body?: object) => {
    const result = await app.request(`/api/v1${path}`, { method, body: body && JSON.stringify(body) })
    return { status: result.status, ...(await result.json() as { data: any; message: string }) }
  }
  const timestamp = new Date().toISOString()
  const configure = (serviceType: string, model: string, provider = 'openai') => db.insert(schema.aiServiceConfigs).values({
    name: serviceType, serviceType, provider, model, baseUrl: `http://127.0.0.1:${address.port}`,
    apiKey: 'fixture-key', createdAt: timestamp, updatedAt: timestamp,
  }).returning().get().id
  const model = { config_id: configure('text', 'chat-test'), model: 'chat-test' }
  const secondModel = { config_id: configure('text', 'second-model'), model: 'second-model' }
  configure('image', 'fixture')
  configure('video', 'fixture', 'volcengine')
  const dramaId = (await request('/dramas', 'POST', { title: '灯塔' })).data.id
  const otherId = (await request('/dramas', 'POST', { title: '另一本' })).data.id
  const novels = `/dramas/${dramaId}/novel-jobs`
  const requestId = (index: number) => index.toString(16).padStart(32, '0')
  const createJob = { start_mode: 'chat', request_id: requestId(1), ...model }
  assert.equal((await request(novels, 'POST', { ...createJob, message: '  ' })).status, 400)
  assert.deepEqual((await request(novels)).data, [])
  const firstMessage = '讨论两个方向'
  const startChat = { ...createJob, message: firstMessage }
  const [created, recreated] = await Promise.all([request(novels, 'POST', startChat), request(novels, 'POST', startChat)])
  assert.deepEqual([created.status, recreated.status].sort(), [200, 201])
  const jobId = created.data.id
  assert.equal(recreated.data.id, jobId)
  assert.equal(created.data.status, 'ready')
  assert.equal(created.data.draft_count, 0)
  const jobPath = `${novels}/${jobId}`
  const chat = `${jobPath}/chat/turns`
  assert.equal((await request(`/dramas/${otherId}/novel-jobs/${jobId}/chat/turns`)).status, 404)
  const secondJob = (await request(novels, 'POST', { ...createJob, request_id: requestId(2) })).data.id
  db.insert(schema.novelChatTurns).values({ jobId: secondJob, requestId: requestId(99), message: '另一本的对话',
    configId: model.config_id, model: model.model, status: 'completed', assistantText: '灯塔机密', createdAt: timestamp }).run()

  async function waitFor<T>(read: () => Promise<T>, until: (item: T) => boolean) {
    for (let attempt = 0; attempt < 150; attempt++) {
      const result = await read()
      if (until(result)) return result
      await delay(30)
    }
    assert.fail('Task did not reach its expected state')
  }
  const readTurn = (root: string, id: number) => waitFor(async () =>
    (await request(root)).data.turns.find((turn: { id: number }) => turn.id === id), turn => !!turn && turn.status !== 'running')
  const send = async (root: string, index: number, message: string, selected?: object) => {
    const res = await request(root, 'POST', { request_id: requestId(index), message, ...selected })
    assert.equal(res.status, 201, res.message)
    return readTurn(root, res.data.id)
  }
  const apply = (root: string, id: number) => request(`${root}/${id}/apply`, 'POST')
  const draft = async (path: string, part = 1) => (await request(`${path}/manuscripts/draft/${part}`)).data?.content

  const opening = (await request(chat)).data
  const first = opening.active_turn
  assert.equal(opening.turns.length, 1)
  assert.equal(first.message, firstMessage)
  assert.equal((await request(chat, 'POST', { request_id: startChat.request_id, message: firstMessage })).data.id, first.id)
  assert.equal((await request(chat, 'POST', { request_id: requestId(4), message: '另一个窗口' })).message, 'chat_running')
  releaseDiscussion()
  assert.equal((await readTurn(chat, first.id)).assistant_text, '一、雨夜车站。二、灯塔寻人。')
  assert.equal(discussionCalls, 1)

  const outline = await send(chat, 5, '用第二个方向定大纲')
  assert.equal(outline.proposal.kind, 'plan')
  assert.equal((await request(chat)).data.story_plan, null)
  assert.equal((await apply(chat, outline.id)).data.job.draft_revision, 1)
  assert.equal((await request(chat)).data.story_plan, plan)
  const chapter = await send(chat, 6, '按刚才的大纲写第一章')
  assert.equal(chapter.proposal.part_number, 1)
  assert.equal(await draft(jobPath), undefined)
  assert.equal((await apply(chat, chapter.id)).data.job.draft_revision, 2)
  assert.equal(await draft(jobPath), `# 未锁的门\n\n${original}\n\n${remainder}`)
  candidateId = (await send(chat, 7, '只改第一章开头')).id
  const edit = await send(chat, 8, '将刚才的候选再改一遍')
  assert.equal(edit.proposal.original_text, original)
  assert.equal((await apply(chat, edit.id)).data.job.draft_revision, 3)
  assert.equal((await apply(chat, edit.id)).data.job.draft_revision, 3)
  assert.equal((await apply(chat, candidateId)).message, 'draft_changed')
  assert.equal(await draft(jobPath), `# 未锁的门\n\n${revised}\n\n${remainder}`)
  const sequel = await send(chat, 9, '接着写第二章')
  assert.equal((await apply(chat, sequel.id)).data.job.draft_count, 2)
  assert.match(await draft(jobPath, 2), /打开暗室/)
  assert.deepEqual(checkedTools, new Set(['read_novel_context', 'read_novel_manuscript', 'propose_novel_edit']))

  const searchable = await send(chat, 40, '另拟故事规划')
  searchableCandidateId = searchable.id
  const guarded = await send(chat, 51, '同轮提交两份候选')
  assert.equal(guarded.proposal.content, '保留第一份。')
  const revisionBeforeLock = (await request(jobPath)).data.draft_revision
  db.update(schema.novelJobs).set({ status: 'failed', errorCode: 'manuscript_too_short', episodeCount: 2 })
    .where(eq(schema.novelJobs.id, jobId)).run()
  const locked = await request(chat, 'POST', { request_id: requestId(41), message: '锁定期间讨论' })
  assert.equal(locked.status, 201)
  const blockedSplitRequest = await request(`${jobPath}/split`, 'POST', {
    ...model, episode_count: 1, draft_revision: revisionBeforeLock,
  })
  const blockedJobRetry = await request(`${jobPath}/retry`, 'POST')
  const blockedAdoption = await apply(chat, searchable.id)
  for (const result of [blockedSplitRequest, blockedJobRetry, blockedAdoption]) {
    assert.equal(result.status, 409)
    assert.equal(result.message, 'chat_running')
  }
  assert.equal((await request(jobPath)).data.draft_revision, revisionBeforeLock)
  releaseLockedDiscussion()
  assert.equal((await readTurn(chat, locked.data.id)).assistant_text, '锁定讨论完成。')

  const failed = await send(chat, 10, '验证失败后重试')
  assert.equal(failed.error_code, 'truncated')
  assert.equal((await request(`${chat}/${failed.id}/retry`, 'POST')).data.id, failed.id)
  assert.equal((await readTurn(chat, failed.id)).assistant_text, '重试完成。')
  const interrupted = db.insert(schema.novelChatTurns).values({ jobId, requestId: requestId(11), message: '恢复同一轮',
    configId: model.config_id, model: model.model, status: 'running', runToken: 'expired', leaseExpiresAt: Date.now() - 1,
    createdAt: timestamp }).returning().get()
  assert.equal((await readTurn(chat, interrupted.id)).status, 'interrupted')
  await request(`${chat}/${interrupted.id}/retry`, 'POST')
  assert.equal((await readTurn(chat, interrupted.id)).assistant_text, '中断后恢复。')

  const staleRetry = await send(chat, 42, '稍后重试')
  assert.equal((await send(chat, 43, '后续决定')).assistant_text, '以晴天为准。')
  const rejectedRetry = await request(`${chat}/${staleRetry.id}/retry`, 'POST')
  assert.equal(rejectedRetry.status, 409)
  assert.equal(rejectedRetry.message, 'turn_superseded')
  assert.equal((await send(chat, 45, '稍后重试')).assistant_text, '按晴天继续。')

  for (let index = 12; index < 28; index++) {
    db.insert(schema.novelChatTurns).values({ jobId, requestId: requestId(index), message: `历史消息 ${index}`,
      configId: model.config_id, model: model.model, status: 'completed', assistantText: '回复', createdAt: timestamp }).run()
  }
  const page = (await request(chat)).data
  const older = (await request(`${chat}?before_id=${page.before_id}`)).data.turns
  assert.equal(page.turns.length, 16)
  assert.equal(older.at(-1).id, first.id)
  assert.ok(older.every((turn: { id: number }) => turn.id < page.before_id))
  const searched = await send(chat, 44, '查找旧提案')
  assert.equal(searched.assistant_text, '找到旧提案。')
  const oldAdoption = await apply(chat, searchable.id)
  const synced = (await request(`${chat}?after_revision=${revisionBeforeLock}`)).data
  assert.ok(!synced.turns.some((turn: { id: number }) => turn.id === searchable.id))
  assert.equal(synced.draft_revision, revisionBeforeLock + 1)
  assert.deepEqual(synced.applied_turns, [{ id: searchable.id, applied_at: oldAdoption.data.turn.applied_at }])
  assert.deepEqual((await request(`${chat}?after_revision=${synced.draft_revision}`)).data.applied_turns, [])

  const importedJob = (await request(novels, 'POST', { request_id: requestId(28), workflow_mode: 'preview_first',
    source_type: 'import', source_text: imported, content_language: 'en' })).data.id
  const importPath = `${novels}/${importedJob}`
  const importChat = `${importPath}/chat/turns`
  for (const [index, language] of ['ja', 'ko'].entries()) {
    const job = await request(novels, 'POST', { request_id: requestId(46 + index), workflow_mode: 'preview_first',
      source_type: 'import', source_text: imported, content_language: language })
    const turn = await send(`${novels}/${job.data.id}/chat/turns`, 48 + index, `换模型修改导入稿${language}`, secondModel)
    assert.equal(turn.proposal.content, '雨打在落地窗上。')
  }
  const revision = await send(importChat, 29, '换模型修改导入稿en', secondModel)
  assert.equal(revision.model, secondModel.model)
  await apply(importChat, revision.id)
  assert.equal(await draft(importPath), finalImport)
  const longChapter = await send(importChat, 30, '补写一个长章节', secondModel)
  assert.equal((await apply(importChat, longChapter.id)).data.job.draft_revision, 2)
  const pending = await send(importChat, 31, '另拟故事规划', secondModel)
  const split = { ...model, episode_count: 1, draft_revision: 2 }
  assert.equal((await request(`${importPath}/split`, 'POST', { ...split, draft_revision: 1 })).message, 'draft_changed')
  db.insert(schema.novelChatTurns).values({ jobId: importedJob, requestId: requestId(50), message: '租约已过期',
    configId: model.config_id, model: model.model, status: 'running', runToken: 'expired', leaseExpiresAt: Date.now() - 1,
    createdAt: timestamp }).run()
  assert.equal((await request(`${importPath}/split`, 'POST', split)).data.status, 'running')
  assert.equal((await apply(importChat, pending.id)).message, 'novel_locked')
  releaseSplit()
  await waitFor(async () => (await request(importPath)).data, job => job.status === 'completed')
  assert.ok(longPolishCalls > 1)
  assert.equal((await request(`${importPath}/chapters/1`)).data.content, finalImport + longPart)
  assert.equal(db.select().from(schema.novelChatTurns).where(eq(schema.novelChatTurns.id, edit.id)).get()?.appliedRevision, 3)
})
