import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
const prompt = read('../src/agents/creative-prompt.ts')
const skill = read('../workspace/skills/creative-agent/SKILL.md')
const tools = read('../src/agents/tools/creative-tools.ts')

test('creative agent exposes and documents the complete writing workflow', () => {
  for (const name of [
    'list_project_materials',
    'read_project_outline',
    'read_project_assets',
    'read_episode_script',
    'read_uploaded_source',
    'read_novel_context',
    'read_novel_manuscript',
    'search_conversation',
    'save_project_outline',
    'create_novel',
    'save_novel_plan',
    'append_novel_part',
    'replace_novel_text',
    'split_novel_to_episodes',
    'edit_episode_scene',
    'save_episode_script',
    'create_episode_script',
  ]) {
    assert.match(tools, new RegExp(`id: '${name}'`), name)
    assert.match(prompt, new RegExp(name), name)
  }
})

test('creative prompt and skill contain detailed continuity, novel, split, and script rules', () => {
  assert.equal(prompt.length > 2000, true, 'creative prompt should contain detailed rules')
  assert.equal(skill.length > 2000, true, 'creative skill should contain detailed rules')
  for (const source of [prompt, skill]) {
    assert.match(source, /小说/)
    assert.match(source, /分集/)
    assert.match(source, /剧本/)
    assert.match(source, /滚动摘要/)
    assert.match(source, /revision|版本/)
    assert.match(source, /production_locked|制作中的/)
  }
})
