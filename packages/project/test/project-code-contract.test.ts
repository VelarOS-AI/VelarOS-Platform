import { describe, expect, test } from 'bun:test'

import { canonicalizeProviderInputSchema, createToolSchemaBundle, schemaToInputSchema } from '@velaros-ai/agent/tool-contract'

import { projectTools } from '../src/impl/ProjectTools'

const projectCode = projectTools['project:code']!

const validQueries = [
  { intent: 'outline', path: 'src/cache.ts' },
  { intent: 'outline', path: 'src', language: 'typescript', extensions: ['.ts'], limit: 40, maxDepth: 3 },
  { intent: 'definition', target: { path: 'src/cache.ts', symbol: 'Cache' } },
  { intent: 'definition', target: { symbolRef: 'symbol:abc' } },
  { intent: 'references', target: { path: 'src/cache.ts', symbol: 'Cache' } },
  { intent: 'references', target: { path: 'src/cache.ts', symbol: 'Cache', container: 'Store' }, path: 'test', limit: 40 },
  { intent: 'callers', target: { symbolRef: 'symbol:abc' } },
  { intent: 'callees', target: { symbolRef: 'symbol:abc' } },
  { intent: 'imports', path: 'src' },
  { intent: 'importers', path: 'src/cache.ts' },
  { intent: 'impact', target: { symbolRef: 'symbol:abc' }, path: 'src' },
  { intent: 'diagnostics', path: 'src/cache.ts' },
]

const invalidQueries = [
  // 必填缺席
  { intent: 'outline' },
  { intent: 'imports' },
  { intent: 'importers' },
  { intent: 'diagnostics' },
  { intent: 'references' },
  { intent: 'callers' },
  // 字段放错 intent：target 与 path 各归各的
  { intent: 'outline', path: 'src', target: { symbolRef: 'symbol:abc' } },
  { intent: 'diagnostics', path: 'src', target: { symbolRef: 'symbol:abc' } },
  { intent: 'callers', target: { symbolRef: 'symbol:abc' }, path: 'src' },
  { intent: 'definition', target: { symbolRef: 'symbol:abc' }, path: 'src' },
  // 收掉的交叉旋钮一个都不认
  { intent: 'imports', path: 'src', direction: 'outgoing' },
  { intent: 'imports', path: 'src', includeExternal: true },
  { intent: 'importers', path: 'src/cache.ts', within: 'test', includeReExports: true },
  { intent: 'importers', path: 'src/cache.ts', specifier: 'node:fs' },
  { intent: 'outline', path: 'src', query: 'Cache' },
  { intent: 'outline', path: 'src', kinds: ['function'], exact: true },
  { intent: 'outline', path: 'src', exportedOnly: true },
  { intent: 'callers', target: { symbolRef: 'symbol:abc' }, kind: 'calls', depth: 3 },
  // 旧词表与越界值
  { action: 'dependencies', direction: 'incoming', path: 'src/cache.ts' },
  { intent: 'relations', target: { symbolRef: 'symbol:abc' }, kind: 'calls' },
  { intent: 'symbols', query: 'Cache' },
  { intent: 'outline', path: '' },
  { intent: 'outline', path: 'src', limit: 201 },
  { intent: 'outline', path: 'src', unknown: true },
]

/** 模型面的每个字段都要有说明：把没有 description 的字段名报出来。 */
function fieldsWithoutDescription(schema: Record<string, any>): string[] {
  return Object.entries(schema.properties ?? {})
    .filter(([, field]) => typeof (field as { description?: unknown }).description !== 'string')
    .map(([name]) => name)
}

describe('code query intent contract', () => {
  test('preserves the caller intent, target and scope without rewriting them', () => {
    for (const input of validQueries) expect(projectCode.schema.parse(input)).toEqual(input)
  })

  test('rejects missing requirements, misplaced fields, retired knobs and unknown fields without discarding them', () => {
    for (const input of invalidQueries)
      expect(projectCode.schema.safeParse(input).success, JSON.stringify(input)).toBe(false)
  })

  test('每种呈现都是同一个平对象：九个 intent 在一个 intent 枚举里，字段都有说明，宿主扁平化时丢不掉分支', () => {
    const publicSchema = schemaToInputSchema(projectCode.schema)
    const bundle = createToolSchemaBundle([projectCode])
    const presentations = [publicSchema, canonicalizeProviderInputSchema(publicSchema), bundle.tools[0]!.inputSchema] as Array<Record<string, any>>
    for (const schema of [publicSchema, canonicalizeProviderInputSchema(publicSchema)] as Array<Record<string, any>>)
      expect(schema.properties.intent.enum).toEqual(['outline', 'definition', 'references', 'callers', 'callees', 'imports', 'importers', 'impact', 'diagnostics'])

    for (const schema of presentations) {
      // 根上不放组合：宿主（Desktop）把根级 oneOf 合成一个对象时只合并有 properties 的分支，嵌套的那一支会整支丢掉。
      expect(schema.oneOf).toBeUndefined()
      expect(schema.anyOf).toBeUndefined()
      expect(schema.type).toBe('object')
      expect(schema.additionalProperties).toBe(false)
      expect(schema.required).toEqual(['intent'])
      // 打包呈现会把枚举收进 $defs 复用，这里只认「要么就地写枚举、要么指向同一份定义」。
      expect(schema.properties.intent.enum ?? schema.properties.intent.$ref).toBeDefined()
      expect(Object.keys(schema.properties).sort()).toEqual([
        'extensions', 'intent', 'language', 'limit', 'maxDepth', 'path', 'target',
      ])
      expect(fieldsWithoutDescription(schema)).toEqual([])
    }
  })

  test('keeps inspection on its direct schema and write tools on their retry envelope', () => {
    const retry = { reuse: 'attempt:failed', changes: [{ op: 'set', path: ['fileRef'], value: 'file:new' }] }
    expect(projectCode.schema.safeParse(retry).success).toBe(false)
    expect(projectTools['project:edit']!.schema.safeParse(retry).success).toBe(true)
    // 入参复用的信封只给正文长的改动工具；读取、执行这些短入参不套。
    for (const name of ['project:read', 'project:list', 'project:search', 'project:run', 'project:sandbox', 'project:code'])
      expect(projectTools[name]!.schema.safeParse(retry).success).toBe(false)
  })
})
