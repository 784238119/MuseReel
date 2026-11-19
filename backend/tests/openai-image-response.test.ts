import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAIImageAdapter } from '../src/services/adapters/openai-image.ts'
import { isRetryablePollStatus } from '../src/services/poll-policy.ts'

test('OpenAI-compatible image result completes when data URL and task ID coexist', () => {
  const adapter = new OpenAIImageAdapter()
  const imageUrl = 'https://images.example/result.png'

  assert.deepEqual(adapter.parseGenerateResponse({
    id: 'task-1',
    task_id: 'task-1',
    status: 'completed',
    data: [{ url: imageUrl }],
  }), { isAsync: false, imageUrl })
})

test('OpenAI-compatible image result stays async only without finished image data', () => {
  const adapter = new OpenAIImageAdapter()

  assert.deepEqual(adapter.parseGenerateResponse({
    id: 'task-1',
    task_id: 'task-1',
    status: 'processing',
  }), { isAsync: true, taskId: 'task-1' })
})

test('polling policy does not retry permanent HTTP errors', () => {
  assert.equal(isRetryablePollStatus(404), false)
  assert.equal(isRetryablePollStatus(401), false)
  assert.equal(isRetryablePollStatus(429), true)
  assert.equal(isRetryablePollStatus(503), true)
})
