import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { InMemoryContextPayloadStore } from '@velaros-ai/agent'
import { AppError } from '@velaros-ai/core/error'

import type { ProjectToolContext } from '../src/contract/requires'
import { createProjectKernel } from '../src/impl/kernel/LocalProjectKernel'
import { projectCodeOperations } from '../src/impl/operations/ProjectCodeOperations'
import { typescriptPlugin } from '../src/impl/plugins/TypeScriptProjectPlugin'
import { createProjectCodeAnalysisTools, projectTools } from '../src/impl/ProjectTools'

const ProjectCodeSchema = projectTools['project:code']!.schema
const ProjectCodeAnalysisSchema = createProjectCodeAnalysisTools(() => true)['project:code-analysis']!.schema
import type { ProjectCodeQuery } from '../src/types/project'

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
      prepareMutation: async () => ({ approved: true, message: '已授权' }),
      runCommand: async () => ({}) as never,
      queryCode: async (input) => { calls.push(input); return handler(input) },
    },
    approval: {} as never,
  }
  return { context, calls, run: (input: unknown) => projectCodeOperations.code(ProjectCodeSchema.parse(input), context) }
}

const target = { path: 'service.ts', symbol: 'Service' }

describe('nine-intent semantic query surface', () => {
  test('outline lists a file\'s symbols with reusable identities and definition serves current AST ranges and raw lines', async () => {
    const { run, calls } = await fixture(() => ({ source: 'language-service', symbols: [{ path: 'service.ts', name: 'Service', kind: 'function', line: 1 }], scannedFiles: 1 }))
    const found = await run({ intent: 'outline', path: 'service.ts' })
    expect(calls[0]).toMatchObject({ action: 'find_symbols', path: 'service.ts' })
    const symbolRef = (found.symbols as any[])[0].symbolRef
    expect(symbolRef).toStartWith('symbol:')
    const detail = await run({ intent: 'definition', target: { symbolRef } })
    expect(detail.declaration).toMatchObject({ startLine: 1, endLine: 3 })
    expect(detail.body).toBeDefined()
    const file = (detail.source as any).files[0]
    expect(file.lines).toEqual([[1, 'export function Service() {'], [2, '  return "值\\n"'], [3, '}']])
    expect(file.content).toBeUndefined()
  })

  test('交叉旋钮都不再收：一个 intent 只认它自己的那两个字段', () => {
    for (const input of [
      { intent: 'outline', path: 'src', query: 'Service' },
      { intent: 'outline', path: 'src', exportedOnly: true },
      { intent: 'outline', path: 'src', kinds: ['function'] },
      { intent: 'callers', target, depth: 3 },
      { intent: 'imports', path: 'src', includeExternal: true },
      { intent: 'importers', path: 'src/user.ts', within: 'src', includeReExports: true },
      { intent: 'references', target, direction: 'incoming' },
      { intent: 'definition', target, path: 'src' },
      { intent: 'outline', path: 'src', action: 'symbols' },
    ]) expect(ProjectCodeSchema.safeParse(input).success, JSON.stringify(input)).toBe(false)
    // 必填缺了也说得出缺什么。
    expect(ProjectCodeSchema.safeParse({ intent: 'outline' }).success).toBe(false)
    expect(ProjectCodeSchema.safeParse({ intent: 'references' }).success).toBe(false)
    expect(ProjectCodeSchema.safeParse({ intent: 'outline', path: 'src', language: 'typescript', extensions: ['.ts'], maxDepth: 2, limit: 10 }).success).toBe(true)
  })

  test('definition 在这个文件里找不到声明时给按名字找到的候选，而不是空手回去', async () => {
    const { run } = await fixture((input) => input.action === 'find_symbols'
      ? { source: 'language-service', symbols: [{ path: 'other.ts', name: 'Service', kind: 'function', line: 2 }] } : {})
    const result = await run({ intent: 'definition', target: { path: 'empty.ts', symbol: 'Service' } })
    expect((result.symbols as any[])[0]).toMatchObject({ path: 'other.ts', name: 'Service' })
    expect((result.symbols as any[])[0].symbolRef).toStartWith('symbol:')
    expect(result.degraded.join('')).toContain('候选')
  })

  test('只给符号名：唯一一处就直接给详情，多处回候选，一处都没有报找不到并给下一步', async () => {
    const single = await fixture((input) => input.action === 'find_symbols' && input.query === 'Service'
      ? { source: 'language-service', symbols: [{ path: 'service.ts', name: 'Service', kind: 'function', line: 1 }] } : {})
    const detail = await single.run({ intent: 'definition', target: { symbol: 'Service' } })
    expect(single.calls[0]).toMatchObject({ action: 'find_symbols', query: 'Service', exact: true })
    expect(detail.declaration).toMatchObject({ startLine: 1, endLine: 3 })

    const many = await fixture(() => ({ source: 'language-service', symbols: [
      { path: 'service.ts', name: 'Service', kind: 'function', line: 1 },
      { path: 'other.ts', name: 'Service', kind: 'class', line: 9 },
    ] }))
    const candidates = await many.run({ intent: 'definition', target: { symbol: 'Service' } })
    expect((candidates.symbols as any[]).map((item) => [item.path, item.kind]))
      .toEqual([['service.ts', 'function'], ['other.ts', 'class']])
    expect((candidates.symbols as any[]).every((item) => String(item.symbolRef).startsWith('symbol:'))).toBe(true)
    expect(candidates.declaration).toBeUndefined()
    expect(candidates.degraded.join('')).toContain('按名字')

    const none = await fixture(() => ({ source: 'language-service', symbols: [] }))
    await expect(none.run({ intent: 'definition', target: { symbol: 'Missing' } })).rejects.toMatchObject({
      reason: 'TARGET_NOT_FOUND', suggestedNextAction: expect.stringContaining('project:search'),
    })
  })

  test('只给名字的 target 在 references、callers、impact 上先定位到唯一声明，多处则报歧义', async () => {
    const { run, calls } = await fixture((input) => input.action === 'find_symbols'
      ? { source: 'language-service', symbols: [{ path: 'service.ts', name: 'Service', kind: 'function', line: 1 }] }
      : input.action === 'search_symbols' ? { source: 'codegraph', results: [{ id: 'node:service', path: 'service.ts', name: 'Service', line: 1 }] }
      : { source: 'language-service', references: [] })
    await run({ intent: 'references', target: { symbol: 'Service' } })
    expect(calls.map((input) => input.action)).toEqual(['find_symbols', 'find_references'])
    expect(calls[1]).toMatchObject({ action: 'find_references', symbol: 'Service' })
    await run({ intent: 'callers', target: { symbol: 'Service' } })
    expect(calls.at(-1)).toMatchObject({ action: 'callers', nodeId: 'node:service' })

    const ambiguous = await fixture(() => ({ source: 'language-service', symbols: [
      { path: 'service.ts', name: 'Service', line: 1 }, { path: 'other.ts', name: 'Service', line: 2 },
    ] }))
    await expect(ambiguous.run({ intent: 'references', target: { symbol: 'Service' } }))
      .rejects.toMatchObject({ reason: 'AMBIGUOUS_TARGET', suggestedNextAction: expect.stringContaining('definition') })
  })

  test('references preserve search scope and state name matching limitations', async () => {
    const { run, calls } = await fixture(() => ({ source: 'language-service', references: [{ path: 'other.ts', line: 1, excerpt: 'Service()' }], scannedFiles: 2, truncated: true }))
    const result = await run({ intent: 'references', target, path: 'tests', limit: 10 })
    expect(calls).toMatchObject([{ action: 'find_references', path: 'tests', symbol: 'Service', exactWord: true, limit: 10 }])
    // 「按名字收候选」在 degraded 里用中文说清楚，不再另给一个英文枚举。
    expect(result.resolution).toBeUndefined()
    expect(result.degraded.join('')).toContain('按名字收集引用候选')
    expect(result.coverage).toMatchObject({ path: 'tests', scannedFiles: 2, truncated: true, versioned: false })
  })

  test('same name in different containers requires explicit disambiguation', async () => {
    await writeFile(join(root, 'service.ts'), 'class A { Service() {} }\nclass B { Service() {} }\n')
    const { run } = await fixture()
    await expect(run({ intent: 'definition', target })).rejects.toMatchObject({ reason: 'AMBIGUOUS_TARGET' })
    const detail = await run({ intent: 'definition', target: { ...target, container: 'B' } })
    expect(detail.declaration).toMatchObject({ startLine: 2 })
  })

  test('imports 与 importers 各自只发一个方向的查询，文件还带上编译器的模块邻接', async () => {
    const { run, calls } = await fixture(() => ({ source: 'language-service', imports: [], importers: [] }))
    await run({ intent: 'importers', path: 'service.ts' })
    await run({ intent: 'imports', path: 'src' })
    expect(calls[0]).toMatchObject({ action: 'find_importers', targetPath: 'service.ts' })
    expect(calls.some((input) => input.action === 'file_dependencies')).toBe(true)
    expect(calls.find((input) => input.action === 'find_imports')).toMatchObject({ action: 'find_imports', path: 'src' })
  })

  test('callers 与 callees 各走一个方向，层数由 intent 定死', async () => {
    const { run, calls } = await fixture((input) => input.action === 'search_symbols'
      ? { source: 'codegraph', results: [{ id: 'node:service', path: 'service.ts', name: 'Service', line: 1 }] }
      : { source: 'codegraph', callers: [{ name: 'caller', path: 'other.ts', line: 1 }] })
    await run({ intent: 'callers', target })
    expect(calls.map((input) => input.action)).toEqual(['search_symbols', 'callers'])
    expect(calls[1]).toEqual({ action: 'callers', nodeId: 'node:service', depth: 2 })
    await run({ intent: 'callees', target })
    expect(calls.at(-1)).toEqual({ action: 'callees', nodeId: 'node:service', depth: 2 })
  })

  test('unavailable relations report degradation and discovery instead of invented text relationships', async () => {
    const { run } = await fixture(() => { throw new AppError('UNAVAILABLE', 'disabled') })
    const result = await run({ intent: 'callers', target })
    expect(result.relations).toEqual([])
    expect(result.degraded).not.toEqual([])
    // 能力目录只列模型自己调得到的 intent，不点名发现入口，也不列宿主内部的索引动作。
    expect(result.capabilities).toMatchObject({ intents: ['outline', 'definition', 'references', 'callers', 'callees', 'imports', 'importers', 'impact', 'diagnostics'] })
    expect(JSON.stringify(result.capabilities)).not.toContain('tooling:map')
    expect(JSON.stringify(result.capabilities)).not.toContain('build_index')
  })

  test('diagnostics retain limited coverage and unsupported language notes', async () => {
    const { run, calls } = await fixture(() => ({ source: 'language-service', diagnostics: [], degraded: 'missing standard library', note: 'only syntax', unsupportedServices: ['python'], scannedFiles: 2 }))
    const result = await run({ intent: 'diagnostics', path: 'src', language: 'typescript', extensions: ['.ts'], maxDepth: 4 })
    expect(calls[0]).toMatchObject({ action: 'language_diagnostics', path: 'src', language: 'typescript', extensions: ['.ts'], maxDepth: 4 })
    expect(result.degraded).toEqual(['missing standard library', 'only syntax'])
    expect(result.unsupportedServices).toEqual(['python'])
  })

  test('impact combines declaration-scoped language candidates and optional graph radius', async () => {
    const { run, calls } = await fixture((input) => input.action === 'search_symbols'
      ? { source: 'codegraph', results: [{ id: 'service', name: 'Service', path: 'service.ts' }] }
      : input.action === 'impact' ? { source: 'codegraph', nodeCount: 3 }
      : { source: 'language-service', relatedTestPaths: ['service.test.ts'], definitions: [], references: [] })
    const result = await run({ intent: 'impact', target, path: 'src' })
    expect(calls[0]).toMatchObject({ action: 'analyze_symbol_impact', declarationPath: 'service.ts', path: 'src' })
    expect(result.graph).toMatchObject({ nodeCount: 3 })
    expect(result.relatedTestPaths).toEqual(['service.test.ts'])
  })

  test('extensions stay in project:code-analysis and index lifecycle is not part of this package', async () => {
    const { context, calls } = await fixture(() => ({ candidates: [{ name: 'possibleUnused' }] }))
    for (const intent of ['trace', 'cycles', 'deadcode', 'routing', 'build_index', 'index_status', 'build_context'])
      expect(ProjectCodeSchema.safeParse({ intent }).success).toBe(false)
    await projectCodeOperations.codeAnalysis(ProjectCodeAnalysisSchema.parse({ intent: 'deadcode', limit: 4 }), context)
    await projectCodeOperations.codeAnalysis(ProjectCodeAnalysisSchema.parse({ intent: 'cycles', maxFiles: 40 }), context)
    await projectCodeOperations.codeAnalysis(ProjectCodeAnalysisSchema.parse({ intent: 'routing', framework: 'velar' }), context)
    // 索引的建与查是宿主自己的事：本包不再有走到它的路径，也不发这两条查询。
    expect(Object.keys(projectCodeOperations)).not.toContain('codeIndex')
    expect(calls).toEqual([{ action: 'find_dead_code', limit: 4 }, { action: 'find_cycles', maxFiles: 40 }, { action: 'routing_manifest', framework: 'velar' }])
  })
})
