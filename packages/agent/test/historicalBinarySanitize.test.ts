import assert from 'node:assert/strict'

import type { ModelMessage } from 'ai'
import { describe, test } from 'bun:test'

import {
  sanitizeModelHistory,
  sanitizeModelHistoryForProvider,
} from '../src/agent/history/sanitize'

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

  test('keeps every media result in the newest tool message while pruning older media', () => {
    const history = [
      {
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: 'old',
          toolName: 'mcp.media:old',
          output: {
            type: 'content',
            value: [{ type: 'image-data', data: 'old-image', mediaType: 'image/png' }],
          },
        }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'new-image',
            toolName: 'mcp.media:image',
            output: {
              type: 'content',
              value: [{ type: 'image-data', data: 'new-image', mediaType: 'image/webp' }],
            },
          },
          {
            type: 'tool-result',
            toolCallId: 'new-audio',
            toolName: 'mcp.media:audio',
            output: {
              type: 'content',
              value: [{ type: 'file-data', data: 'new-audio', mediaType: 'audio/mpeg' }],
            },
          },
        ],
      },
    ] as ModelMessage[]

    const sanitized = sanitizeModelHistory(history)
    const serializedOld = JSON.stringify(sanitized.history[0]?.content)
    const serializedNewest = JSON.stringify(sanitized.history[1]?.content)

    assert.match(serializedOld, /historical tool media bytes omitted/u)
    assert.doesNotMatch(serializedOld, /old-image/u)
    assert.match(serializedNewest, /new-image/u)
    assert.match(serializedNewest, /new-audio/u)
  })
})
