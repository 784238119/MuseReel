import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = readFileSync(new URL('../app/components/CreativeAgentWorkspace.vue', import.meta.url), 'utf8')

test('only the latest run exposes retry actions', () => {
  assert.match(source, /v-if="canRetry\(activeAttempt\(group\)\)"/)
  assert.match(source, /if \(!canRetry\(turn\) \|\| sending\.value \|\| running\.value\) return/)
  assert.match(source, /retryLatestOnly/)
})

test('explicit model choices outrank inferred successful models', () => {
  assert.match(source, /const next = \[remembered, fromTurn, modelKey\.value, models\.value\[0\]\?\.key\]/)
  assert.match(source, /@update:model-value="chooseModel"/)
  assert.match(source, /function chooseModel\(value: string\)/)
})

test('historical failures do not use alert semantics', () => {
  assert.match(source, /class="run-failure" role="group"/)
  assert.doesNotMatch(source, /class="run-failure" role="alert"/)
})
