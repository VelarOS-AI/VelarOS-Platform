import assert from 'node:assert/strict'

import type { ModelMessage } from 'ai'
import { describe, test } from 'bun:test'

import { sanitizeModelHistoryForProvider } from '../src/agent/history/sanitize'

describe('historical binary replay markers', () => {
  test('the marker distinguishes original image visibility from later replay omission', () => {
    const history = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe this' },
          { type: 'image', image: 'data:image/png;base64,AAAA' },
        ],
      },
      { role: 'assistant', content: 'I saw the image.' },
      { role: 'user', content: 'continue' },
    ] as ModelMessage[]

    const sanitized = sanitizeModelHistoryForProvider(history)
    const firstMessage = sanitized.history[0]!
    const serialized = JSON.stringify(firstMessage.content)

    assert.match(serialized, /omitted only from this later provider replay/u)
    assert.match(serialized, /may have been visible in its original turn/u)
    assert.doesNotMatch(serialized, /data:image/u)
  })
})
