import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { InMemoryContextPayloadStore } from '@velaros-ai/agent'
import { AppError } from '@velaros-ai/core/error'

import type { ProjectToolContext } from '../src/agent/Types'
import { executeProjectCode, executeProjectCodeAnalysis, executeProjectCodeIndex } from '../src/code/query'
import { typescriptPlugin } from '../src/plugins/typescript'
import { ProjectCodeAnalysisSchema, ProjectCodeSchema } from '../src/project-code-contracts'
import type { ProjectCodeQuery } from '../src/project-code-query'
import { createProjectKernel } from '../src/runtime/project-kernel'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'project-code-surface-'))
  await writeFile(join(root, 'service.ts'), 'export function Service() {\n  return "值\\n"\n}\n')
})
afterEach(async () => rm(root, { recursive: true, force: true }))

async function fixture(handler: (input: ProjectCodeQuery) => unknown = () => ({})) {
  const kernel = await createProjectKernel({ root, plugins: [typescriptPlugin()] })
  const calls: ProjectCodeQuery[] = []
  const context: ProjectToolContext = {
    sessionId: 'code-test',
    codingSession: {},
    contextPayloadStore: new InMemoryContextPayloadStore(),
    abortSignal: new AbortController().signal,
    project: {
      getRootPath: () => root,
      kernel: async () => kernel,
      runInDirectory: async (_path, action) => action(),
      runWithApproval: async (action) => action(),
      prepareMutation: async () => ({ approved: true, rootPath: root }),
      runCommand: async () => ({}) as never,
      queryCode: async (input) => { calls.push(input); return handler(input) },
    },
    system: { canStartBackgroundCommands: () => false },
    approval: {} as never,
  }
  return { context, calls, run: (input: unknown) => executeProjectCode(ProjectCodeSchema.parse(input), context) }
}

const target = { path: 'service.ts', symbol: 'Service' }

describe('six-action semantic query surface', () => {
  test('symbol discovery creates reusable identity and detail serves current AST ranges and raw lines', async () => {
    const { run } = await fixture(() => ({ source: 'language-service', symbols: [{ path: 'service.ts', name: 'Service', kind: 'function', line: 1 }], scannedFiles: 1 }))
    const found = await run({ action: 'symbols', query: 'Service' })
    const symbolRef = (found.symbols as any[])[0].symbolRef
    expect(symbolRef).toStartWith('symbol:')
    const detail = await run({ action: 'symbols', target: { symbolRef } })
    expect(detail.declaration).toMatchObject({ startLine: 1, endLine: 3 })
    expect(detail.body).toBeDefined()
    const file = (detail.source as any).files[0]
    expect(file.lines).toEqual([[1, 'export function Service() {'], [2, '  return "值\\n"'], [3, '}']])
    expect(file.content).toBeUndefined()
  })

  test('exports retain re-export data and reject meaningless filter combinations', async () => {
    const { run, calls } = await fixture(() => ({ source: 'language-service', exports: [{ path: 'service.ts', name: 'Service', kind: 'function', source: './impl', reExport: true }] }))
    const output = await run({ action: 'symbols', exportedOnly: true, includeReExports: true, query: 'Service' })
    expect(calls[0]).toMatchObject({ action: 'list_exports', includeReExports: true })
    expect(output.symbols).toMatchObject([{ source: './impl', reExport: true }])
    expect(ProjectCodeSchema.safeParse({ action: 'symbols', includeReExports: true }).success).toBe(false)
    expect(ProjectCodeSchema.safeParse({ action: 'symbols', target, query: 'Other' }).success).toBe(false)
  })

  test('references preserve search scope and state name matching limitations', async () => {
    const { run, calls } = await fixture(() => ({ source: 'language-service', references: [{ path: 'other.ts', line: 1, excerpt: 'Service()' }], scannedFiles: 2, truncated: true }))
    const result = await run({ action: 'references', target, path: 'tests', limit: 10 })
    expect(calls).toMatchObject([{ action: 'find_references', path: 'tests', symbol: 'Service', exactWord: true, limit: 10 }])
    expect(result.resolution).toBe('name-candidates')
    expect(result.degraded).not.toEqual([])
    expect(result.coverage).toMatchObject({ path: 'tests', scannedFiles: 2, truncated: true, version: 'unversioned-locations' })
  })

  test('same name in different containers requires explicit disambiguation', async () => {
    await writeFile(join(root, 'service.ts'), 'class A { Service() {} }\nclass B { Service() {} }\n')
    const { run } = await fixture()
    await expect(run({ action: 'symbols', target })).rejects.toMatchObject({ reason: 'AMBIGUOUS_TARGET' })
    const detail = await run({ action: 'symbols', target: { ...target, container: 'B' } })
    expect(detail.declaration).toMatchObject({ startLine: 2 })
  })

  test('dependency directions preserve target, scanning scope, external and re-export filters', async () => {
    const { run, calls } = await fixture(() => ({ source: 'language-service', imports: [], importers: [] }))
    await run({ action: 'dependencies', direction: 'incoming', path: 'service.ts', within: 'tests', includeReExports: true })
    await run({ action: 'dependencies', direction: 'outgoing', path: 'src', specifier: 'node:fs', kind: 'import', includeExternal: true })
    expect(calls[0]).toMatchObject({ action: 'find_importers', targetPath: 'service.ts', path: 'tests', includeReExports: true })
    expect(calls.find((input) => input.action === 'find_imports')).toMatchObject({ action: 'find_imports', path: 'src', specifier: 'node:fs', kind: 'import', includeExternal: true })
    expect(ProjectCodeSchema.safeParse({ action: 'dependencies', direction: 'incoming' }).success).toBe(false)
    expect(ProjectCodeSchema.safeParse({ action: 'dependencies', direction: 'outgoing', within: 'src' }).success).toBe(false)
  })

  test('relations resolve current backend identities and call only requested directions', async () => {
    const { run, calls } = await fixture((input) => input.action === 'search_symbols'
      ? { source: 'codegraph', results: [{ id: 'node:service', path: 'service.ts', name: 'Service', line: 1 }] }
      : { source: 'codegraph', callers: [{ name: 'caller', path: 'other.ts', line: 1 }] })
    await run({ action: 'relations', kind: 'calls', direction: 'incoming', target, depth: 3 })
    expect(calls.map((input) => input.action)).toEqual(['search_symbols', 'callers'])
    expect(calls[1]).toEqual({ action: 'callers', nodeId: 'node:service', depth: 3 })
  })

  test('compiler graph nodes use zero-based locations and directed relations without leaking unrelated neighbors', async () => {
    const nodes = [
      { id: 'a', name: 'Service', path: 'service.ts', range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } } },
      { id: 'b', name: 'Base', path: 'base.ts' },
      { id: 'c', name: 'Child', path: 'child.ts' },
    ]
    const { run } = await fixture((input) => input.action === 'find_symbols' ? { symbols: [] } : {
      source: 'velar-compiler', revision: 'compiler:1', nodes,
      relations: [{ from: 'a', to: 'b', kind: 'extends' }, { from: 'c', to: 'a', kind: 'extends' }],
      coverage: { complete: false },
    })
    const discovered = await run({ action: 'symbols', query: 'Service' })
    expect(discovered.symbols).toHaveLength(1)
    expect((discovered.symbols as any[])[0].line).toBe(1)
    const result = await run({ action: 'relations', kind: 'types', direction: 'outgoing', target })
    expect((result.nodes as any[]).map((node) => node.id)).toEqual(['a', 'b'])
    expect(result.coverage).toMatchObject({ complete: false, version: 'backend-reported' })
  })

  test('unavailable relations report degradation and discovery instead of invented text relationships', async () => {
    const { run } = await fixture(() => { throw new AppError('UNAVAILABLE', 'disabled') })
    const result = await run({ action: 'relations', kind: 'calls', target })
    expect(result.relations).toEqual([])
    expect(result.degraded).not.toEqual([])
    expect(result.capabilities).toMatchObject({ discovery: 'tooling:map' })
  })

  test('diagnostics retain limited coverage and unsupported language notes', async () => {
    const { run, calls } = await fixture(() => ({ source: 'language-service', diagnostics: [], degraded: 'missing standard library', note: 'only syntax', unsupportedServices: ['python'], scannedFiles: 2 }))
    const result = await run({ action: 'diagnostics', path: 'src', language: 'typescript', extensions: ['.ts'], maxDepth: 4 })
    expect(calls[0]).toMatchObject({ action: 'language_diagnostics', path: 'src', language: 'typescript', extensions: ['.ts'], maxDepth: 4 })
    expect(result.degraded).toEqual(['missing standard library', 'only syntax'])
    expect(result.unsupportedServices).toEqual(['python'])
  })

  test('impact combines declaration-scoped language candidates and optional graph radius', async () => {
    const { run, calls } = await fixture((input) => input.action === 'search_symbols'
      ? { source: 'codegraph', results: [{ id: 'service', name: 'Service', path: 'service.ts' }] }
      : input.action === 'impact' ? { source: 'codegraph', nodeCount: 3 }
      : { source: 'language-service', relatedTestPaths: ['service.test.ts'], definitions: [], references: [] })
    const result = await run({ action: 'impact', target, path: 'src', depth: 4 })
    expect(calls[0]).toMatchObject({ action: 'analyze_symbol_impact', declarationPath: 'service.ts', path: 'src' })
    expect(result.graph).toMatchObject({ nodeCount: 3 })
    expect(result.relatedTestPaths).toEqual(['service.test.ts'])
  })

  test('extensions and index lifecycle remain outside the six-action schema', async () => {
    const { context, calls } = await fixture(() => ({ candidates: [{ name: 'possibleUnused' }] }))
    for (const action of ['trace', 'cycles', 'deadcode', 'routing', 'build_index', 'index_status', 'build_context'])
      expect(ProjectCodeSchema.safeParse({ action }).success).toBe(false)
    await executeProjectCodeAnalysis(ProjectCodeAnalysisSchema.parse({ action: 'deadcode', limit: 4 }), context)
    await executeProjectCodeAnalysis(ProjectCodeAnalysisSchema.parse({ action: 'cycles', maxFiles: 40 }), context)
    await executeProjectCodeAnalysis(ProjectCodeAnalysisSchema.parse({ action: 'routing', framework: 'velar' }), context)
    await executeProjectCodeIndex({ action: 'build_index', force: false }, context)
    await executeProjectCodeIndex({ action: 'index_status' }, context)
    expect(calls).toEqual([{ action: 'find_dead_code', limit: 4 }, { action: 'find_cycles', maxFiles: 40 }, { action: 'routing_manifest', framework: 'velar' }, { action: 'build_index', force: false }, { action: 'index_status' }])
  })
})
