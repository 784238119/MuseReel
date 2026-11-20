import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const code = fs.readFileSync(new URL('../dist/main.js', import.meta.url), 'utf8')

async function boot(mode = 'pending', options = {}) {
  const windows = [], errors = [], logs = [], timers = new Map()
  let requests = 0, forks = 0, now = 0, timerId = 0, forkArgs = null
  const app = new EventEmitter()
  Object.assign(app, { isPackaged: true, getPath: () => '/mock/user', setPath() {}, getVersion: () => 'test', requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(), quit() { app.emit('before-quit') } })
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.visible = options.show !== false; this.options = options; this.destroyed = false
      this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = () => {}; windows.push(this)
    }
    show() { this.visible = true }
    focus() { this.focused = true }
    isMinimized() { return false }
    isDestroyed() { return this.destroyed }
    loadFile(file) { this.loadedFile = file; return Promise.resolve() }
    loadURL(url) { this.loadedURL = url; return mode === 'page-failure' ? Promise.reject(new Error('ERR_CONNECTION_RESET')) : Promise.resolve() }
  }
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {}
  const electron = { app, BrowserWindow: Window, dialog: { showErrorBox: (...args) => errors.push(args) }, ipcMain: { handle() {} }, shell: {}, utilityProcess: { fork(...args) { forks++; forkArgs = args; return child } } }
  const childProcess = { execFile(_file, _args, _options, callback) {
    queueMicrotask(() => options.shortPath
      ? callback(null, options.shortPath, '')
      : callback(new Error('short path unavailable'), '', ''))
  } }
  const copies = [], replacements = [], writes = []
  const filesystem = {
    existsSync(p) {
      if (p.endsWith('.template-version')) return !!options.templateVersion
      if (p.endsWith('novel-writer/SKILL.md')) return options.novelSkill !== undefined
      return !/storage-config|startup.log/.test(p)
    },
    readFileSync(p) {
      if (p.endsWith('.template-version')) return options.templateVersion
      if (p.endsWith('novel-writer/SKILL.md')) return options.novelSkill
      throw new Error(`Unexpected read: ${p}`)
    },
    mkdirSync() {},
    cpSync: (...args) => copies.push(args),
    copyFileSync: (...args) => copies.push(args),
    renameSync: (...args) => replacements.push(args),
    writeFileSync: (...args) => writes.push(args),
    appendFileSync: (_p, s) => logs.push(s),
  }
  const fakeProcess = new EventEmitter()
  Object.assign(fakeProcess, { platform: 'win32', arch: 'x64', env: {}, versions: { electron: '37.10.3' }, pid: 123, resourcesPath: options.resourcesPath || '/mock/resources', stdout: new EventEmitter(), stderr: new EventEmitter() })
  fakeProcess.stdout.write = fakeProcess.stderr.write = () => true
  const net = { createServer() { const s = new EventEmitter(); s.listen = (_p, _h, fn) => fn(); s.address = () => ({port: 43210}); s.close = fn => fn(); return s } }
  const http = { get(_opts, callback) {
    requests++
    const request = new EventEmitter(); request.destroy = err => request.emit('error', err)
    if (mode !== 'pending') queueMicrotask(() => callback({ statusCode: 200, resume() {} }))
    return request
  } }
  const context = vm.createContext({ require: name => name === 'electron' ? electron : name === 'node:child_process' ? childProcess : /^(node:)?fs$/.test(name) ? filesystem : /^(node:)?net$/.test(name) ? net : name === 'node:http' ? http : require(name),
    process: fakeProcess, __dirname: '/mock/resources/app.asar/dist', module: {exports:{}}, exports: {}, console: {log(){},warn(){},error(){}}, Buffer, URL,
    Date: class extends Date { static now() { return now } },
    setTimeout: (fn, ms) => { const t = { id: ++timerId, at: now + ms, fn, unref() {} }; timers.set(t.id,t); return t },
    clearTimeout: t => timers.delete(t?.id),
  })
  vm.runInContext(code, context)
  async function flush() { for(let i=0;i<50;i++) await Promise.resolve() }
  await flush()
  return { windows, errors, logs, copies, replacements, writes, app, child, requests: () => requests, forks: () => forks, forkArgs: () => forkArgs, flush,
    async expireHealth() { now=60_001; for(const t of [...timers.values()]) if(t.at <= now && t.at <= 1000) {timers.delete(t.id);t.fn()} await flush() } }
}

test('startup window is visible while health check hangs; deadline yields one actionable error', async () => {
  const p=await boot(); assert.equal(p.forks(),1); assert.equal(p.requests(),1)
  assert.equal(p.windows.length,1); assert.equal(p.windows[0].visible,true)
  assert.match(p.windows[0].loadedFile,/starting.html$/)
  await p.expireHealth()
  assert.equal(p.errors.length,1); assert.match(p.errors[0][1],/startup.log/)
})
test('successful page load shows window without ready-to-show and a second launch unhides it', async () => {
  const p=await boot('healthy'); assert.match(p.windows[0].loadedURL,/127.0.0.1:43210/)
  assert.equal(p.windows[0].visible,true)
  p.windows[0].visible=false; p.app.emit('second-instance')
  assert.equal(p.windows[0].visible,true); assert.equal(p.windows[0].focused,true); assert.equal(p.errors.length,0)
})
test('backend early exit reports once and includes startup stderr and log location', async () => {
  const p=await boot(); p.child.stderr.emit('data',Buffer.from('Cannot load native module'))
  p.child.emit('exit',1); await p.expireHealth()
  assert.equal(p.errors.length,1); assert.match(p.errors[0][1],/Cannot load native module/)
  assert.ok(p.logs.some(s=>s.includes('backend exited')))
})
test('page load failure reports a visible error instead of leaving a hidden window', async () => {
  const p=await boot('page-failure'); assert.equal(p.errors.length,1)
  assert.match(p.errors[0][1],/ERR_CONNECTION_RESET/)
})
test('non-ASCII Windows install resources use one short path for backend and media tools', async () => {
  const shortPath = 'C:\\MUSERE~1\\resources'
  const p = await boot('healthy', {
    resourcesPath: 'C:\\用户\\MuseReel\\resources',
    shortPath,
  })
  assert.ok(p.forkArgs()[0].startsWith(shortPath))
  assert.ok(p.forkArgs()[2].env.FFMPEG_BIN.startsWith(shortPath))
  assert.ok(p.forkArgs()[2].env.FFPROBE_BIN.startsWith(shortPath))
  assert.ok(p.forkArgs()[2].env.FRONTEND_DIST.startsWith(shortPath))
  assert.equal(p.errors.length, 0)
})
test('closing while backend starts cancels silently', async () => {
  const p=await boot(); p.app.quit(); await p.expireHealth(); assert.equal(p.errors.length,0)
})

test('workspace upgrade replaces the untouched v5 novelist skill and preserves customized skills', async () => {
  const original = `---
name: novel-writer
description: 小说故事规划、章节衔接和原稿润色
---

# 小说创作与润色

## 规划与成稿

- 从创作设定中提取主角的目标、阻力、关键选择和结局。安排章节时检查每章推动了哪一条情节，以及上一章的结果如何引出本章。
- 编写和更新故事笔记时记录角色别名、关系、已知信息、时间地点、关键物件和未回收伏笔。区分正文已交代的事实与仍待确认的推断。
- 写作时让每个主要场景产生可追踪的变化，例如角色作出决定、关系转变或掌握新信息。检查前一章留下的动作和对话在本章开头有自然衔接。

## 通读与润色

- 通读时优先定位会影响后续理解的问题，记下矛盾出现在哪里，以及哪一处有明确的上下文依据。
- 润色指定片段时优先处理重复、指代不清、不自然的过渡和明显的前后矛盾。证据不足时保留原有描述。
- 保留角色、主线、结局、原有叙述视角及段落结构。相邻片段用于检查衔接。按当前请求指定的范围和格式返回内容。
`
  const updated = await boot('healthy', { templateVersion: '5', novelSkill: original.replaceAll('\n', '\r\n') })
  assert.equal(updated.forks(), 1)
  assert.equal(updated.copies.length, 1)
  const [source, temporary] = updated.copies[0]
  assert.match(source, /workspace-template\/skills\/novel-writer\/SKILL\.md$/)
  assert.deepEqual(updated.replacements, [[temporary, temporary.replace(/\.template-tmp$/, '')]])
  assert.equal(updated.writes.find(([file]) => file.endsWith('.template-version'))?.[1], '6')

  const customized = await boot('healthy', { templateVersion: '5', novelSkill: original + '\n自定义规则。' })
  assert.equal(customized.forks(), 1)
  assert.deepEqual(customized.copies, [])
  assert.deepEqual(customized.replacements, [])
  assert.equal(customized.writes.find(([file]) => file.endsWith('.template-version'))?.[1], '6')
})
