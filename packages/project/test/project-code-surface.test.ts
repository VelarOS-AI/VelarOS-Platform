import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'

import { typescriptPlugin } from '../src/impl/plugins/TypeScriptProjectPlugin'
import type { ProjectCodeQuery } from '../src/types/project'

import { failureOf, projectSpaceFixture } from './support/space'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'project-code-surface-'))
  await writeFile(join(root, 'service.ts'), 'export function Service() {\n  return "值\\n"\n}\n')
})
afterEach(async () => rm(root, { recursive: true, force: true }))

/** 代码面的 `code` 命名空间：宿主的代码查询按 handler 回答，每一条查询都记下来。 */
async function fixture(handler: (input: ProjectCodeQuery) => unknown = () => ({})) {
  const space = await projectSpaceFixture({ root, plugins: [typescriptPlugin()], queryCode: handler })
  return {
    calls: space.queries,
    query: (input: unknown) => space.call('code', 'query', input),
    analyze: (input: unknown) => space.call('code', 'analyze', input),
    port: space.port,
  }
}

const target = { path: 'service.ts', symbol: 'Service' }

describe('九个 intent 的代码查询', () => {
  test('outline 列出符号，每个都带现成的 target；definition 拿它回来给声明与 body 的当前范围，正文留给 read', async () => {
    const { query, calls } = await fixture(() => ({ source: 'language-service', symbols: [{ path: 'service.ts', name: 'Service', kind: 'function', line: 1, id: 'backend-node' }], scannedFiles: 1 }))
    const found = await query({ intent: 'outline', path: 'service.ts' })
    expect(calls[0]).toMatchObject({ action: 'find_symbols', path: 'service.ts' })
    expect(found.intent).toBe('outline')
    const [symbol] = found.symbols
    expect(symbol.target).toEqual({ path: 'service.ts', symbol: 'Service' })
    // 后端自己的节点 id 不交出去。
    expect(symbol.id).toBeUndefined()
    const detail = await query({ intent: 'definition', target: symbol.target })
    expect(detail.declaration).toMatchObject({ startLine: 1, endLine: 3 })
    expect(detail.body).toBeDefined()
    expect(detail.coverage).toMatchObject({ path: 'service.ts', versioned: true })
    expect(detail.coverage.revision).toBeTruthy()
    expect(detail.sources).toEqual([{ backend: 'velaros.typescript.ast' }])
    // 正文不在这里给，要看那几行用 velar:project 的 read。
    expect(JSON.stringify(detail)).not.toContain('return')
  })

  test('definition 在这个文件里找不到声明时给按名字找到的候选，而不是空手回去', async () => {
    const { query } = await fixture((input) => input.action === 'find_symbols'
      ? { source: 'language-service', symbols: [{ path: 'other.ts', name: 'Service', kind: 'function', line: 2 }] } : {})
    const result = await query({ intent: 'definition', target: { path: 'empty.ts', symbol: 'Service' } })
    expect(result.symbols[0]).toMatchObject({ path: 'other.ts', name: 'Service', target: { path: 'other.ts', symbol: 'Service' } })
    expect(result.declaration).toBeUndefined()
    expect(result.degraded.join('')).toContain('候选')
  })

  test('只给符号名：唯一一处直接给详情，多处回候选让程序挑', async () => {
    const single = await fixture((input) => input.action === 'find_symbols' && input.query === 'Service'
      ? { source: 'language-service', symbols: [{ path: 'service.ts', name: 'Service', kind: 'function', line: 1 }] } : {})
    const detail = await single.query({ intent: 'definition', target: { symbol: 'Service' } })
    expect(single.calls[0]).toMatchObject({ action: 'find_symbols', query: 'Service', exact: true })
    expect(detail.declaration).toMatchObject({ startLine: 1, endLine: 3 })

    const many = await fixture(() => ({ source: 'language-service', symbols: [
      { path: 'service.ts', name: 'Service', kind: 'function', line: 1 },
      { path: 'other.ts', name: 'Service', kind: 'class', line: 9 },
    ] }))
    const candidates = await many.query({ intent: 'definition', target: { symbol: 'Service' } })
    expect(candidates.symbols.map((item: { path: string; kind: string }) => [item.path, item.kind]))
      .toEqual([['service.ts', 'function'], ['other.ts', 'class']])
    expect(candidates.symbols.map((item: { target: unknown }) => item.target))
      .toEqual([{ path: 'service.ts', symbol: 'Service' }, { path: 'other.ts', symbol: 'Service' }])
    expect(candidates.declaration).toBeUndefined()
    expect(candidates.degraded.join('')).toContain('按名字')
  })

  test('只给名字的 target 在 references、callers 上先定位到唯一声明', async () => {
    const { query, calls } = await fixture((input) => input.action === 'find_symbols'
      ? { source: 'language-service', symbols: [{ path: 'service.ts', name: 'Service', kind: 'function', line: 1 }] }
      : input.action === 'search_symbols' ? { source: 'codegraph', results: [{ id: 'node:service', path: 'service.ts', name: 'Service', line: 1 }] }
        : { source: 'language-service', references: [] })
    await query({ intent: 'references', target: { symbol: 'Service' } })
    expect(calls.map((input) => input.action)).toEqual(['find_symbols', 'find_references'])
    expect(calls[1]).toMatchObject({ action: 'find_references', symbol: 'Service' })
    await query({ intent: 'callers', target: { symbol: 'Service' } })
    expect(calls.at(-1)).toMatchObject({ action: 'callers', nodeId: 'node:service' })
  })

  test('定位不到或定不下唯一声明时，程序拿到原因码和下一步', async () => {
    const none = await fixture(() => ({ source: 'language-service', symbols: [] }))
    const missing = await failureOf(none.query({ intent: 'definition', target: { symbol: 'Missing' } }))
    expect(missing.code).toBe('TARGET_NOT_FOUND')
    expect(missing.message).toContain('velar:project')

    const two = await fixture(() => ({ source: 'language-service', symbols: [
      { path: 'service.ts', name: 'Service', line: 1 }, { path: 'other.ts', name: 'Service', line: 2 },
    ] }))
    const ambiguous = await failureOf(two.query({ intent: 'references', target: { symbol: 'Service' } }))
    expect(ambiguous.code).toBe('AMBIGUOUS_TARGET')
    expect(ambiguous.message).toContain('definition')

    await writeFile(join(root, 'service.ts'), 'class A { Service() {} }\nclass B { Service() {} }\n')
    const containers = await fixture()
    expect((await failureOf(containers.query({ intent: 'definition', target }))).code).toBe('AMBIGUOUS_TARGET')
  })

  test('references 保留搜索范围，并说明按名字收集的局限', async () => {
    const { query, calls } = await fixture(() => ({ source: 'language-service', references: [{ path: 'other.ts', line: 1, excerpt: 'Service()' }], scannedFiles: 2, truncated: true }))
    const result = await query({ intent: 'references', target, path: 'tests', limit: 10 })
    expect(calls).toMatchObject([{ action: 'find_references', path: 'tests', symbol: 'Service', exactWord: true, limit: 10 }])
    expect(result.target).toMatchObject(target)
    // 「按名字收候选」在 degraded 里用中文说清楚，不另给一个英文枚举。
    expect(result.resolution).toBeUndefined()
    expect(result.degraded.join('')).toContain('按名字收集引用候选')
    expect(result.coverage).toMatchObject({ path: 'tests', scannedFiles: 2, truncated: true, versioned: false })
  })

  test('同一文件里不同容器的同名符号：给了 container 就定得下来', async () => {
    await writeFile(join(root, 'service.ts'), 'class A { Service() {} }\nclass B { Service() {} }\n')
    const { query } = await fixture()
    await expect(query({ intent: 'definition', target })).rejects.toThrow('多个声明')
    const detail = await query({ intent: 'definition', target: { ...target, container: 'B' } })
    expect(detail.declaration).toMatchObject({ startLine: 2 })
  })

  test('imports 与 importers 各自只发一个方向的查询，文件还带上编译器的模块邻接', async () => {
    const { query, calls } = await fixture(() => ({ source: 'language-service', imports: [], importers: [] }))
    const importers = await query({ intent: 'importers', path: 'service.ts' })
    await query({ intent: 'imports', path: 'src' })
    expect(calls[0]).toMatchObject({ action: 'find_importers', targetPath: 'service.ts' })
    expect(calls.some((input) => input.action === 'file_dependencies')).toBe(true)
    expect(importers.graph).toMatchObject({ scope: expect.stringContaining('文件邻接') })
    expect(calls.find((input) => input.action === 'find_imports')).toMatchObject({ action: 'find_imports', path: 'src' })
  })

  test('callers 与 callees 各走一个方向，层数由 intent 定死', async () => {
    const { query, calls } = await fixture((input) => input.action === 'search_symbols'
      ? { source: 'codegraph', results: [{ id: 'node:service', path: 'service.ts', name: 'Service', line: 1 }] }
      : { source: 'codegraph', callers: [{ name: 'caller', path: 'other.ts', line: 1 }] })
    const callers = await query({ intent: 'callers', target })
    expect(calls.map((input) => input.action)).toEqual(['search_symbols', 'callers'])
    expect(calls[1]).toEqual({ action: 'callers', nodeId: 'node:service', depth: 2 })
    // 图后端的节点 id 只在查询里用，回执的 target 不带它。
    expect(callers.target).toMatchObject(target)
    await query({ intent: 'callees', target })
    expect(calls.at(-1)).toEqual({ action: 'callees', nodeId: 'node:service', depth: 2 })
  })

  test('关系后端没启用时如实降级，不拿文本命中冒充调用关系', async () => {
    const { query } = await fixture(() => { throw new AppError('UNAVAILABLE', 'disabled') })
    const result = await query({ intent: 'callers', target })
    expect(result.relations).toEqual([])
    expect(result.degraded).not.toEqual([])
    // 能力目录只列模型自己调得到的 intent，不列宿主内部的索引动作。
    expect(result.capabilities).toMatchObject({ intents: ['outline', 'definition', 'references', 'callers', 'callees', 'imports', 'importers', 'impact', 'diagnostics'] })
    expect(JSON.stringify(result.capabilities)).not.toContain('build_index')
  })

  test('diagnostics 保留有限的覆盖与不支持的语言说明', async () => {
    const { query, calls } = await fixture(() => ({ source: 'language-service', diagnostics: [], degraded: 'missing standard library', note: 'only syntax', unsupportedServices: ['python'], scannedFiles: 2 }))
    const result = await query({ intent: 'diagnostics', path: 'src', language: 'typescript', extensions: ['.ts'], maxDepth: 4 })
    expect(calls[0]).toMatchObject({ action: 'language_diagnostics', path: 'src', language: 'typescript', extensions: ['.ts'], maxDepth: 4 })
    expect(result.degraded).toEqual(['missing standard library', 'only syntax'])
    expect(result.unsupportedServices).toEqual(['python'])
  })

  test('impact 合并声明范围的语言服务候选与可选的图半径', async () => {
    const { query, calls } = await fixture((input) => input.action === 'search_symbols'
      ? { source: 'codegraph', results: [{ id: 'service', name: 'Service', path: 'service.ts' }] }
      : input.action === 'impact' ? { source: 'codegraph', nodeCount: 3 }
        : { source: 'language-service', relatedTestPaths: ['service.test.ts'], definitions: [], references: [] })
    const result = await query({ intent: 'impact', target, path: 'src' })
    expect(calls[0]).toMatchObject({ action: 'analyze_symbol_impact', declarationPath: 'service.ts', path: 'src' })
    expect(result.graph).toMatchObject({ nodeCount: 3 })
    expect(result.relatedTestPaths).toEqual(['service.test.ts'])
  })
})

describe('要图后端的分析', () => {
  test('cycles、deadcode、routing 各发一条图查询；索引的建与查不在这个包里', async () => {
    const { analyze, calls, port } = await fixture(() => ({ candidates: [{ name: 'possibleUnused' }] }))
    const deadcode = await analyze({ intent: 'deadcode', limit: 4 })
    await analyze({ intent: 'cycles', maxFiles: 40 })
    await analyze({ intent: 'routing', framework: 'velar' })
    expect(deadcode).toMatchObject({ intent: 'deadcode', candidates: [{ name: 'possibleUnused' }] })
    expect(calls).toEqual([{ action: 'find_dead_code', limit: 4 }, { action: 'find_cycles', maxFiles: 40 }, { action: 'routing_manifest', framework: 'velar' }])
    // code 命名空间只有这两个操作：没有走到索引生命周期的路。
    expect(port.listOperations().code).toEqual(['query', 'analyze'])
  })

  test('trace 把两端的符号都换成图节点再查路径', async () => {
    const { analyze, calls } = await fixture((input) => input.action === 'search_symbols'
      ? { source: 'codegraph', results: [{ id: `node:${input.query}`, path: 'service.ts', name: input.query, line: 1 }] }
      : { source: 'codegraph', path: ['node:Service'] })
    await writeFile(join(root, 'service.ts'), 'export function Service() {\n  return Helper()\n}\nexport function Helper() {\n  return 1\n}\n')
    await analyze({ intent: 'trace', from: target, to: { path: 'service.ts', symbol: 'Helper' } })
    expect(calls.at(-1)).toEqual({ action: 'trace', fromSymbol: 'node:Service', toSymbol: 'node:Helper' })
  })

  test('宿主没接图后端时整个调用失败，不降级', async () => {
    const { analyze } = await fixture(() => { throw new AppError('UNAVAILABLE', '没有代码图谱后端') })
    const failure = await failureOf(analyze({ intent: 'cycles' }))
    expect(failure.code).toBe('UNAVAILABLE')
    expect(failure.message).toContain('没有代码图谱后端')
  })
})
