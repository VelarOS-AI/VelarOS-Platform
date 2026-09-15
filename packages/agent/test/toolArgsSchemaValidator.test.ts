import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import { clampedInt } from '../src/utils/toolkit/forgiving-schema'
import { ToolArgsSchemaValidator } from '../src/utils/tools/tool-args-schema-validator'

describe('ToolArgsSchemaValidator effective arguments', () => {
  test('union failures report only the branch selected by the supplied discriminator', () => {
    const validator = new ToolArgsSchemaValidator()
    const schema = z.union([
      z.object({ action: z.literal('read'), path: z.string() }),
      z.object({ action: z.literal('write'), path: z.string(), text: z.string() }),
    ])
    const result = validator.validateWithNormalization(schema, { action: 'read', path: 3 })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.issues).toEqual([{ path: 'path', message: expect.stringContaining('expected string') }])
    expect(result.error.issues[0]?.code).toBe('invalid_union')
  })

  test('nested union alternatives keep outer field paths and do not coerce across branches', () => {
    const validator = new ToolArgsSchemaValidator()
    const schema = z.object({
      request: z.union([
        z.object({ action: z.literal('read'), limit: z.number() }),
        z.object({ action: z.literal('write'), text: z.string() }),
      ]),
    })
    const args = { request: { action: 'read', limit: '5' } }
    const result = validator.validateWithNormalization(schema, args)

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.issues).toEqual([{ path: 'request.limit', message: expect.stringContaining('expected number') }])
    expect(args.request.limit).toBe('5')
  })

  test('a missing variant field is not mistaken for a discriminator', () => {
    const validator = new ToolArgsSchemaValidator()
    const Line = z.number().int().positive()
    const Range = z.union([Line, z.tuple([Line, Line])])
    const edit = z.union([
      z.strictObject({ op: z.literal('replace'), range: Range.optional(), text: z.string() }),
      z.strictObject({ op: z.literal('insert'), range: Range.optional(), side: z.enum(['before', 'after']), text: z.string() }),
      z.strictObject({ op: z.literal('insert'), at: z.enum(['start', 'end']), text: z.string() }),
    ])
    const schema = z.object({ edits: z.array(edit) })

    const missingSide = validator.validateWithNormalization(schema, { edits: [{ op: 'insert', range: 2, text: 'x' }] })
    expect(missingSide.success).toBe(false)
    if (!missingSide.success) expect(missingSide.issues).toEqual([{ path: 'edits.0.side', message: expect.stringContaining('"before"|"after"') }])

    const wrongRange = validator.validateWithNormalization(schema, { edits: [{ op: 'replace', range: [1, 2, 3], text: 'x' }] })
    expect(wrongRange.success).toBe(false)
    if (!wrongRange.success) {
      expect(wrongRange.issues.every((issue) => issue.path.startsWith('edits.0.range'))).toBe(true)
      expect(wrongRange.issues.some((issue) => /\bop\b/u.test(issue.message))).toBe(false)
    }

    const unknownOp = validator.validateWithNormalization(schema, { edits: [{ op: 'delete', range: 2, text: '' }] })
    expect(unknownOp.success).toBe(false)
    if (!unknownOp.success) expect(unknownOp.issues).toEqual([{ path: 'edits.0.op', message: 'Invalid option: expected one of "replace"|"insert"' }])

    const scalarRange = validator.validateWithNormalization(schema, { edits: [{ op: 'replace', range: '2', text: 'x' }] })
    expect(scalarRange.success).toBe(false)
    if (!scalarRange.success) expect(scalarRange.issues).toEqual([{ path: 'edits.0.range', message: 'Invalid input: expected number | tuple, received string' }])
  })

  test('bounds feedback for deeply nested external union schemas', () => {
    const validator = new ToolArgsSchemaValidator()
    let schema: z.ZodType = z.string()
    for (let depth = 0; depth < 12; depth++) schema = z.union([schema, z.literal('alternative')])
    const result = validator.validateWithNormalization(z.object({ value: schema }), { value: 3 })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.issues.length).toBeGreaterThan(0)
    expect(result.issues.length).toBeLessThanOrEqual(3)
    expect(result.issues.every((issue) => issue.path === 'value')).toBe(true)
  })

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
