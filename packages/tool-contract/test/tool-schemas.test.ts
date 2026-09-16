/** schema 转换与打包的实现细节：元字段、元组长度、键序、共享定义的内联与改名。 */

import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import { toolSchemas } from '../src/impl/ToolSchemas'

describe('ToolSchemas', () => {
  test('单条 schema 出输入侧 JSON Schema，剥掉 $schema 与 $id', () => {
    const json = toolSchemas.toInputSchema(z.strictObject({ text: z.string(), limit: z.number().default(10) }))
    expect(json.$schema).toBeUndefined()
    expect(json.$id).toBeUndefined()
    expect(json.required).toEqual(['text'])
  })

  test('定长元组补上 minItems 与 maxItems', () => {
    const json = toolSchemas.toInputSchema(z.strictObject({ range: z.tuple([z.number(), z.number()]) }))
    const range = (json.properties as Record<string, Record<string, unknown>>).range
    expect(range.minItems).toBe(2)
    expect(range.maxItems).toBe(2)
  })

  test('发给 provider 前键序稳定、空 required 整个丢掉', () => {
    const canonical = toolSchemas.canonicalizeProviderInput({
      required: [],
      properties: { b: { type: 'string' }, a: { type: 'string' } },
      type: 'object',
    })
    expect(Object.keys(canonical)).toEqual(['properties', 'type'])
    expect(Object.keys(canonical.properties as Record<string, unknown>)).toEqual(['a', 'b'])
    expect(toolSchemas.canonicalizeProviderInput(null)).toEqual({ type: 'object' })
  })

  test('schema 包里共享定义只放一次，单处引用的小定义内联回去', () => {
    const shared = z.strictObject({ path: z.string() }).describe('一个路径')
    const bundle = toolSchemas.bundle([
      { name: 'probe:read', description: '读', schema: z.strictObject({ target: shared }) },
      { name: 'probe:write', description: '写', schema: z.strictObject({ target: shared }) },
    ])
    expect(bundle.schemaVersion).toBe(1)
    expect(Object.keys(bundle.$defs)).toEqual(['d0'])
    expect(JSON.stringify(bundle.tools)).toContain('#/$defs/d0')
    const single = toolSchemas.bundle([
      { name: 'probe:read', description: '读', schema: z.strictObject({ target: shared }) },
    ])
    expect(single.$defs).toEqual({})
  })

  test('目录 schema 归一：不是普通对象就给一个空对象', () => {
    expect(toolSchemas.normalizeCatalogSchema(undefined)).toEqual({})
    expect(toolSchemas.normalizeCatalogSchema([1])).toEqual({})
    expect(toolSchemas.normalizeCatalogSchema({ type: 'object' })).toEqual({ type: 'object' })
  })
})
