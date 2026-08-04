import { describe, expect, test } from 'bun:test'

import { CodingToolCallDeduper } from '../src/coding/tool-dedupe'

describe('tooling:replace exact-call dedupe', () => {
  test('does not infer residency from an enabled capability', () => {
    const deduper = new CodingToolCallDeduper()
    const args = {
      op: 'replace',
      pageIn: ['capability:browser'],
      pageOut: [],
      reason: 'load browser tools',
    }

    expect(deduper.getRepeatedIdempotentToolCallMessage('tooling:replace', args)).toBeNull()
    deduper.recordIdempotentToolCall('tooling:replace', args)
    expect(deduper.getRepeatedIdempotentToolCallMessage('tooling:replace', args)).toContain(
      '相同的工具页请求刚才已经处理过'
    )
  })
})
