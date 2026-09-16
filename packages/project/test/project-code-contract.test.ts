import { describe, expect, test } from 'bun:test'

import { canonicalizeProviderInputSchema, createToolSchemaBundle, schemaToInputSchema } from '@velaros-ai/agent/tool-contract'

import { projectTools } from '../src/impl/ProjectTools'

const projectCode = projectTools['project:code']!

const validDependencies = [
  { direction: 'incoming', path: 'src/cache.ts' },
  { direction: 'incoming', specifier: 'node:fs' },
  { direction: 'incoming', path: 'src/cache.ts', specifier: './cache', within: 'test', includeReExports: true },
  { direction: 'incoming', path: 'src/cache.ts', includeReExports: false },
  { direction: 'outgoing' },
  { direction: 'outgoing', path: 'src', specifier: 'node:fs', kind: 'import', includeExternal: true },
  { direction: 'outgoing', path: 'src/cache.ts', includeExternal: false, language: 'typescript', extensions: ['.ts'], limit: 40, maxDepth: 3 },
]

const invalidDependencies = [
  { direction: 'incoming' },
  { direction: 'incoming', path: '' },
  { direction: 'incoming', specifier: '' },
  { direction: 'incoming', path: 'src/cache.ts', kind: 'import' },
  { direction: 'incoming', path: 'src/cache.ts', includeExternal: false },
  { direction: 'outgoing', within: 'test' },
  { direction: 'outgoing', includeReExports: false },
  { direction: 'both', path: 'src/cache.ts' },
  { path: 'src/cache.ts' },
  { direction: 'incoming', path: 'src/cache.ts', limit: 201 },
  { direction: 'outgoing', path: 'src/cache.ts', unknown: true },
  // 工作台里真实发生过的方向与开关组合。
  { direction: 'outgoing', path: 'packages/project/src/utils/glob.ts', includeExternal: true, includeReExports: true, limit: 100 },
  { direction: 'incoming', path: 'packages/project/src/utils/matcher-cache.ts', within: 'packages/project', includeExternal: true, includeReExports: true, limit: 100 },
]

/** 模型面的每个字段都要有说明：把没有 description 的字段名报出来。 */
function fieldsWithoutDescription(schema: Record<string, any>): string[] {
  return Object.entries(schema.properties ?? {})
    .filter(([, field]) => typeof (field as { description?: unknown }).description !== 'string')
    .map(([name]) => name)
}

describe('dependency direction contract', () => {
  test('preserves valid selectors, scope and flags without rewriting the caller intent', () => {
    for (const fields of validDependencies) {
      const input = { action: 'dependencies', ...fields }
      expect(projectCode.schema.parse(input)).toEqual(input)
    }
  })

  test('rejects wrong-direction flags, missing selectors and unknown fields without discarding them', () => {
    for (const fields of invalidDependencies) {
      const input = { action: 'dependencies', ...fields }
      expect(projectCode.schema.safeParse(input).success).toBe(false)
    }
  })

  test('每种呈现都是同一个平对象：六个动作在一个 action 枚举里，字段都有说明，宿主扁平化时丢不掉分支', () => {
    const publicSchema = schemaToInputSchema(projectCode.schema)
    const bundle = createToolSchemaBundle([projectCode])
    const presentations = [publicSchema, canonicalizeProviderInputSchema(publicSchema), bundle.tools[0]!.inputSchema] as Array<Record<string, any>>
    for (const schema of [publicSchema, canonicalizeProviderInputSchema(publicSchema)] as Array<Record<string, any>>)
      expect(schema.properties.action.enum).toEqual(['symbols', 'references', 'dependencies', 'relations', 'impact', 'diagnostics'])

    for (const schema of presentations) {
      // 根上不放组合：宿主（Desktop）把根级 oneOf 合成一个对象时只合并有 properties 的分支，嵌套的那一支会整支丢掉。
      expect(schema.oneOf).toBeUndefined()
      expect(schema.anyOf).toBeUndefined()
      expect(schema.type).toBe('object')
      expect(schema.additionalProperties).toBe(false)
      expect(schema.required).toEqual(['action'])
      // 打包呈现会把枚举收进 $defs 复用，这里只认「要么就地写枚举、要么指向同一份定义」。
      expect(schema.properties.action.enum ?? schema.properties.action.$ref).toBeDefined()
      expect(Object.keys(schema.properties).sort()).toEqual([
        'action', 'depth', 'direction', 'exact', 'exportedOnly', 'extensions', 'includeExternal', 'includeReExports',
        'kind', 'kinds', 'language', 'limit', 'maxDepth', 'path', 'query', 'specifier', 'target', 'within',
      ])
      expect(fieldsWithoutDescription(schema)).toEqual([])
    }
  })

  test('keeps inspection on its direct schema and write tools on their retry envelope', () => {
    const retry = { reuse: 'attempt:failed', changes: [{ op: 'set', path: ['fileRef'], value: 'file:new' }] }
    expect(projectCode.schema.safeParse(retry).success).toBe(false)
    for (const name of ['project:edit', 'project:file', 'project:change'])
      expect(projectTools[name]!.schema.safeParse(retry).success).toBe(true)
    // 入参复用的信封只给正文长的那三个改动工具；读取、执行这些短入参不套。
    for (const name of ['project:read', 'project:list', 'project:search', 'project:run', 'project:sandbox', 'project:code'])
      expect(projectTools[name]!.schema.safeParse(retry).success).toBe(false)
  })
})
