import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { test } from 'node:test'

const entrypoint = new URL('../../docker/entrypoint.sh', import.meta.url).pathname
const oldNovelWriter = `---
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

async function runEntrypoint(appRoot) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.env.SH || '/bin/sh', [entrypoint], {
      env: { ...process.env, APP_ROOT: appRoot },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolve(undefined) : reject(new Error(stderr || `exit ${code}`)))
  })
}

async function fixture(novelWriter) {
  const root = await mkdtemp(join(tmpdir(), 'musereel-entrypoint-'))
  const template = join(root, 'workspace-template')
  const workspace = join(root, 'data', 'workspace')
  const skills = join(template, 'skills')
  await mkdir(join(skills, 'novel-writer'), { recursive: true })
  await mkdir(join(skills, 'novel-splitter'), { recursive: true })
  await mkdir(join(skills, 'creative-agent'), { recursive: true })
  await mkdir(join(workspace, 'skills', 'novel-writer'), { recursive: true })
  await mkdir(join(root, 'backend', 'node_modules', '.bin'), { recursive: true })
  await writeFile(join(skills, 'novel-writer', 'SKILL.md'), 'new novel writer\n')
  await writeFile(join(skills, 'novel-splitter', 'SKILL.md'), 'new novel splitter\n')
  await writeFile(join(skills, 'creative-agent', 'SKILL.md'), 'new creative agent\n')
  await writeFile(join(workspace, 'skills', 'novel-writer', 'SKILL.md'), novelWriter)
  await writeFile(join(workspace, '.template-version'), '')
  await writeFile(join(workspace, '.novel-skills-v1'), '')
  const executable = join(root, 'backend', 'node_modules', '.bin', 'tsx')
  await writeFile(executable, '#!/bin/sh\nexit 0\n')
  await chmod(executable, 0o755)
  return { root, workspace, creative: join(workspace, 'skills', 'creative-agent', 'SKILL.md') }
}

test('docker migration adds creative-agent and only replaces the known old novelist skill', async () => {
  const migrated = await fixture(oldNovelWriter)
  const customized = await fixture('user customized skill\n')
  try {
    await runEntrypoint(migrated.root)
    await runEntrypoint(customized.root)
    assert.equal(await readFile(join(migrated.workspace, 'skills', 'novel-writer', 'SKILL.md'), 'utf8'), 'new novel writer\n')
    assert.equal(await readFile(migrated.creative, 'utf8'), 'new creative agent\n')
    assert.equal(await readFile(join(migrated.workspace, 'skills', 'novel-splitter', 'SKILL.md'), 'utf8'), 'new novel splitter\n')
    assert.equal(await readFile(join(migrated.workspace, '.novel-skills-v2'), 'utf8'), '')
    assert.equal(await readFile(join(customized.workspace, 'skills', 'novel-writer', 'SKILL.md'), 'utf8'), 'user customized skill\n')
  } finally {
    await rm(migrated.root, { recursive: true, force: true })
    await rm(customized.root, { recursive: true, force: true })
  }
})
