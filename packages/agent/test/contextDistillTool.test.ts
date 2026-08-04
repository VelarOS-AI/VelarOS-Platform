import { describe, expect, test } from 'bun:test'

import { distillContextSchema } from '../src/tool-library/builtin/ContextDistill.tool'

describe('context:distill input budget', () => {
  test('accepts a long phase represented by twenty concise facts', () => {
    const result = distillContextSchema.safeParse({
      facts: Array.from({ length: 20 }, (_, index) => `completed work item ${index + 1}`),
      note: 'phase complete',
    })

    expect(result.success).toBe(true)
  })

  test('keeps the total payload envelope bounded', () => {
    const tooManyFacts = distillContextSchema.safeParse({
      facts: Array.from({ length: 21 }, (_, index) => `fact ${index + 1}`),
    })
    const oversizedFact = distillContextSchema.safeParse({
      facts: ['x'.repeat(241)],
    })

    expect(tooManyFacts.success).toBe(false)
    expect(oversizedFact.success).toBe(false)
  })
})
