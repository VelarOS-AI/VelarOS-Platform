import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import { clampedInt } from '../src/tool-contract'
import { ToolArgsSchemaValidator } from '../src/tools/ToolArgsSchemaValidator'

describe('ToolArgsSchemaValidator effective arguments', () => {
  test('keeps prototype-like JSON keys as ordinary own properties when replacing input', () => {
    const validator = new ToolArgsSchemaValidator()
    const target = { removed: true } as Record<string, unknown>
    const source = JSON.parse('{"__proto__":{"unexpected":true},"constructor":"value","limit":5}')

    validator.replaceRecordContents(target, source)

    expect(Object.getPrototypeOf(target)).toBe(Object.prototype)
    expect(Object.hasOwn(target, '__proto__')).toBe(true)
    expect(target.unexpected).toBeUndefined()
    expect(Object.hasOwn(target, 'removed')).toBe(false)
    expect(JSON.stringify(target)).toBe(JSON.stringify(source))
  })

  test('returns the exact transformed input that will be executed', () => {
    const validator = new ToolArgsSchemaValidator()
    const result = validator.validateWithNormalization(
      z.object({
        limit: clampedInt(1, 50),
        mode: z.enum(['brief', 'full']).default('brief'),
        enabled: z.boolean(),
      }),
      { limit: 1_000, enabled: 'true', unsupported: 'drop-me' }
    )

    expect(result).toMatchObject({
      success: true,
      data: { limit: 50, mode: 'brief', enabled: true },
      args: { limit: 50, mode: 'brief', enabled: true },
      requestedArgs: { limit: 1_000, enabled: 'true', unsupported: 'drop-me' },
      normalized: true,
    })
    if (!result.success) return
    expect(result.adjustments).toEqual([
      {
        field: 'enabled',
        action: 'coerced',
        detail: 'schema converted the model value to its declared type',
      },
      {
        field: 'limit',
        action: 'clamped',
        detail: 'schema bounded or rounded the model value before execution',
      },
      {
        field: 'mode',
        action: 'defaulted',
        detail: 'schema supplied the omitted field',
      },
      {
        field: 'unsupported',
        action: 'ignored',
        detail: 'schema removed an unsupported field',
      },
    ])
  })

  test('does not mark an unchanged call as normalized', () => {
    const validator = new ToolArgsSchemaValidator()
    const result = validator.validateWithNormalization(
      z.object({ query: z.string() }),
      { query: 'schema' }
    )

    expect(result).toMatchObject({
      success: true,
      normalized: false,
      adjustments: [],
      args: { query: 'schema' },
    })
  })

  test('bounds adjustment metadata for large or deeply nested external schemas', () => {
    const validator = new ToolArgsSchemaValidator()
    const requested = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`unsupported_${index}`, index])
    )
    const result = validator.validateWithNormalization(z.object({}), requested)

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.adjustments).toHaveLength(50)
    expect(result.adjustments.at(-1)).toEqual({
      field: '<additional>',
      action: 'normalized',
      detail: 'additional schema adjustments were omitted from metadata',
    })

    const deepRequested: Record<string, unknown> = {}
    const deepEffective: Record<string, unknown> = {}
    let requestedCursor = deepRequested
    let effectiveCursor = deepEffective
    for (let depth = 0; depth < 40; depth += 1) {
      const requestedChild: Record<string, unknown> = {}
      const effectiveChild: Record<string, unknown> = {}
      requestedCursor.next = requestedChild
      effectiveCursor.next = effectiveChild
      requestedCursor = requestedChild
      effectiveCursor = effectiveChild
    }
    requestedCursor.value = 'before'
    effectiveCursor.value = 'after'

    expect(validator.describeAdjustments(deepRequested, deepEffective)).toEqual([{
      field: '<additional>',
      action: 'normalized',
      detail: 'additional schema adjustments were omitted from metadata',
    }])
  })
})
