import { describe, expect, test } from 'bun:test'

import { canonicalizeProviderInputSchema, createToolSchemaBundle, schemaToInputSchema } from '@velaros-ai/agent/tool-contract'

import { projectTools } from '../src/agent/Project.tool'
import { projectCode } from '../src/agent/tools/code'
import { ProjectCodeSchema } from '../src/project-code-contracts'

const validDependencies = [
  { direction: 'incoming', path: 'src/cache.ts' },
  { direction: 'incoming', specifier: 'node:fs' },
  { direction: 'incoming', path: 'src/cache.ts', specifier: './cache', within: 'test', includeReExports: true },
  { direction: 'incoming', path: 'src/cache.ts', includeReExports: false },
  { direction: 'outgoing' },
  { direction: 'outgoing', path: 'src', specifier: 'node:fs', kind: 'import', includeExternal: true },
  { direction: 'outgoing', path: 'src/cache.ts', includeExternal: false, cwd: 'packages/project', language: 'typescript', extensions: ['.ts'], limit: 40, maxDepth: 3 },
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
  // Exact direction/flag combinations that failed in the natural Workbench experiment.
  { direction: 'outgoing', path: 'packages/project/src/utils/glob.ts', includeExternal: true, includeReExports: true, limit: 100 },
  { direction: 'incoming', path: 'packages/project/src/utils/matcher-cache.ts', within: 'packages/project', includeExternal: true, includeReExports: true, limit: 100 },
]

describe('dependency direction contract', () => {
  test('preserves valid selectors, scope and flags without rewriting the caller intent', () => {
    for (const fields of validDependencies) {
      const input = { action: 'dependencies', ...fields }
      expect(ProjectCodeSchema.parse(input)).toEqual(input)
      expect(projectCode.schema.parse(input)).toEqual(input)
    }
  })

  test('rejects wrong-direction flags, missing selectors and unknown fields without discarding them', () => {
    for (const fields of invalidDependencies) {
      const input = { action: 'dependencies', ...fields }
      expect(ProjectCodeSchema.safeParse(input).success).toBe(false)
      expect(projectCode.schema.safeParse(input).success).toBe(false)
    }
  })

  test('publishes strict direction branches and the incoming selector requirement through every schema presentation', () => {
    const publicSchema = schemaToInputSchema(projectCode.schema)
    const bundle = createToolSchemaBundle([projectCode])
    const presentations = [publicSchema, canonicalizeProviderInputSchema(publicSchema), bundle.tools[0]!.inputSchema]
    const commonFields = ['action', 'language', 'cwd', 'limit', 'extensions', 'maxDepth', 'direction', 'path', 'specifier']

    for (const schema of presentations) {
      // Inspect the real exported branches, not tool descriptions or schema text counts.
      const actions = schema.oneOf as Array<{ oneOf?: Array<Record<string, any>> }>
      const dependencies = actions.find((entry) => entry.oneOf?.every((branch) => branch.properties.action.const === 'dependencies'))
      expect(dependencies?.oneOf).toHaveLength(2)
      const incoming = dependencies!.oneOf!.find((branch) => branch.properties.direction.const === 'incoming')!
      const outgoing = dependencies!.oneOf!.find((branch) => branch.properties.direction.const === 'outgoing')!

      expect(Object.keys(incoming.properties).sort()).toEqual([...commonFields, 'within', 'includeReExports'].sort())
      expect(Object.keys(outgoing.properties).sort()).toEqual([...commonFields, 'kind', 'includeExternal'].sort())
      for (const branch of [incoming, outgoing]) {
        expect(branch.type).toBe('object')
        expect(branch.additionalProperties).toBe(false)
        expect(branch.required).toEqual(['action', 'direction'])
      }
      expect(incoming.anyOf).toEqual([{ required: ['path'] }, { required: ['specifier'] }])
      expect(outgoing.anyOf).toBeUndefined()
    }
  })

  test('keeps inspection on its direct schema and write tools on their retry envelope', () => {
    expect(projectCode.schema).toBe(ProjectCodeSchema)
    const retry = { reuse: 'attempt:failed', changes: [{ op: 'set', path: ['fileRef'], value: 'file:new' }] }
    expect(projectCode.schema.safeParse(retry).success).toBe(false)
    for (const name of ['project:edit', 'project:file', 'project:change'])
      expect(projectTools[name]!.schema.safeParse(retry).success).toBe(true)
  })
})
