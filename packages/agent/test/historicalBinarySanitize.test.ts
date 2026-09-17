import assert from 'node:assert/strict'

import type { ModelMessage } from 'ai'
import { describe, test } from 'bun:test'

import {
  sanitizeModelHistory,
  sanitizeModelHistoryForProvider,
} from '../src/utils/history/sanitize'

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

    assert.match(serialized, /只是在这次较晚的重放里被省略了/u)
    assert.match(serialized, /它在原来那一轮里可能是可见的/u)
    assert.doesNotMatch(serialized, /data:image/u)
  })

  const mediaResult = (id: string, data: string, mediaType = 'image/png') => ({
    type: 'tool-result',
    toolCallId: id,
    toolName: 'mcp.media:image',
    output: {
      type: 'content',
      value: [
        { type: 'text', text: `图片：${id}.png` },
        { type: 'image-data', data, mediaType },
      ],
    },
  })

  test('media the model has not responded to yet stays whole, every part of it', () => {
    const history = [
      { role: 'assistant', content: 'let me look' },
      {
        role: 'tool',
        content: [
          mediaResult('new-image', 'new-image', 'image/webp'),
          {
            type: 'tool-result',
            toolCallId: 'new-audio',
            toolName: 'mcp.media:audio',
            output: { type: 'content', value: [{ type: 'file-data', data: 'new-audio', mediaType: 'audio/mpeg' }] },
          },
        ],
      },
    ] as ModelMessage[]

    const serialized = JSON.stringify(sanitizeModelHistory(history).history[1]?.content)
    assert.match(serialized, /new-image/u)
    assert.match(serialized, /new-audio/u)
  })

  test('media leaves the context as soon as the model has responded, even when it is the newest tool result', () => {
    const history = [
      { role: 'tool', content: [mediaResult('shot', 'image-bytes')] },
      { role: 'assistant', content: 'I read the screenshot.' },
      { role: 'user', content: 'thanks' },
    ] as ModelMessage[]

    const serialized = JSON.stringify(sanitizeModelHistory(history).history[0]?.content)
    // 字节撤掉，说明里告诉模型要看就重新读；「图片：shot.png」那行文字还在，它知道自己看过什么
    assert.doesNotMatch(serialized, /image-bytes/u)
    assert.match(serialized, /你已经看过，看完就撤出上下文/u)
    assert.match(serialized, /要再看就重新读取一次/u)
    assert.match(serialized, /图片：shot\.png/u)
  })

  test('older media is retired while the unseen one after the last reply stays', () => {
    const history = [
      { role: 'tool', content: [mediaResult('old', 'old-image')] },
      { role: 'assistant', content: 'next one' },
      { role: 'tool', content: [mediaResult('new', 'new-image')] },
    ] as ModelMessage[]

    const sanitized = sanitizeModelHistory(history)
    assert.doesNotMatch(JSON.stringify(sanitized.history[0]?.content), /old-image/u)
    assert.match(JSON.stringify(sanitized.history[2]?.content), /new-image/u)
  })
})
