import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const settings = readFileSync(new URL('../app/pages/settings.vue', import.meta.url), 'utf8')

test('agent prompt and skill load after the content language is resolved', () => {
  assert.doesNotMatch(settings, /onMounted\(loadContentLanguage\)/)
  const mount = settings.match(/onMounted\(async \(\) => \{\s*await loadContentLanguage\(\)([\s\S]*?)\n\}\)/)
  assert.ok(mount)
  assert.match(mount[1], /loadAllSkills\(\)/)
  assert.match(mount[1], /loadAgentPrompt\(selectedAgent\.value\)/)
  assert.doesNotMatch(settings, /editLang\.value\s*=(?!=)/)
})
