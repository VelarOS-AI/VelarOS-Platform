import { relative, resolve } from 'node:path'

import { isArray, isEmpty, isNumber, isPlainObject, isString, isTrue, numberOrNull, optionalWhen, toOptional } from '@velaros-ai/core'

import { executeProjectRead } from '../agent/tools/read.js'
import type { ProjectToolContext } from '../agent/Types.js'
import { ProjectError } from '../errors.js'
import type { ProjectCodeAnalysisInput, ProjectCodeInput, ProjectCodeTarget } from '../project-code-contracts.js'
import type { ProjectCodeQuery } from '../project-code-query.js'
import type { ProjectSymbol } from '../types/adapter.js'

import { type CodeSymbolTarget, resolveCodeSymbolReference, sameCodePath, saveCodeSymbolReference } from './symbol-references.js'

type RecordValue = Record<string, unknown>

function record(value: unknown): RecordValue {
  return isPlainObject(value) ? value as RecordValue : { result: value }
}

function rows(value: unknown): RecordValue[] {
  return isArray(value) ? value.filter((entry) => isPlainObject(entry)) : []
}

function graphRows(result: RecordValue): RecordValue[] {
  return rows(result.results ?? result.symbols ?? result.nodes).map((item) => {
    const start = record(record(item.range).start)
    return result.source === 'velar-compiler' && isNumber(start.line)
      ? { ...item, line: start.line + 1, column: isNumber(start.character) ? start.character + 1 : undefined }
      : item
  })
}

function boundRelations(result: RecordValue, limit: number): RecordValue {
  const bounded = { ...result }
  let truncated = isTrue(result.truncated)
  for (const key of ['callers', 'callees', 'nodes']) {
    if (!isArray(result[key])) continue
    const values = result[key] as unknown[]
    bounded[key] = values.slice(0, limit)
    truncated ||= values.length > limit
  }
  if (isArray(bounded.nodes) && isArray(bounded.relations)) {
    const ids = new Set(rows(bounded.nodes).map((node) => node.id))
    bounded.relations = rows(bounded.relations).filter((edge) => ids.has(edge.from) && ids.has(edge.to))
  }
  for (const key of ['output', 'relationshipMap']) {
    if (!isString(bounded[key]) || bounded[key].length <= 20_000) continue
    bounded[key] = bounded[key].slice(0, 20_000)
    truncated = true
  }
  return { ...bounded, truncated }
}

function scope(input: { language?: string; cwd?: string; limit?: number; extensions?: string[]; maxDepth?: number }) {
  return { language: input.language, cwd: input.cwd, limit: input.limit, extensions: input.extensions, maxDepth: input.maxDepth }
}

/** The discovery catalogue is small; extension schemas are loaded only by a host that provides them. */
export const ProjectCodeCapabilityCatalogue = Object.freeze({
  tool: 'project:code',
  discovery: 'tooling:map',
  actions: ['symbols', 'references', 'dependencies', 'relations', 'impact', 'diagnostics'],
  extensions: [{ id: 'project:code-analysis', actions: ['trace', 'cycles', 'deadcode', 'routing'], availability: 'host-dependent' }],
  host: { index: ['build_index', 'index_status'], taskContext: 'build_context' },
})

function unavailable(error: unknown): boolean {
  const value = error as { code?: string; reason?: string }
  return value?.code === 'UNAVAILABLE' || value?.reason === 'NOT_SUPPORTED'
}

function envelope(input: { action: string; path?: string; language?: string; limit?: number }, raw: unknown, extra: RecordValue = {}) {
  const result = record(raw)
  const degradation = [result.degraded, result.note].filter((value): value is string => isString(value) && value.length > 0)
  return {
    ...result,
    action: input.action,
    sources: result.sources ?? [{ backend: result.source ?? 'host', services: result.services }],
    coverage: {
      path: input.path ?? '.',
      language: input.language,
      scannedFiles: result.scannedFiles,
      truncated: isTrue(result.truncated),
      limit: input.limit ?? 30,
      version: result.revision ? 'backend-reported' : 'unversioned-locations',
      revisions: result.revision ? [{ revision: result.revision, scope: result.source ?? 'host' }] : [],
      ...record(result.coverage ?? {}),
    },
    degraded: degradation,
    ...extra,
  }
}

async function query(input: ProjectCodeQuery, context: ProjectToolContext) {
  context.abortSignal.throwIfAborted()
  return record(await context.project.queryCode(input, context))
}

async function symbolRows(values: RecordValue[], context: ProjectToolContext) {
  return Promise.all(values.map(async (value) => {
    const { id, nodeId, ...item } = value
    if (!isString(item.path) || !isString(item.name)) return item
    const symbolRef = await saveCodeSymbolReference({
      path: item.path, symbol: item.name,
      container: optionalWhen(isString, item.container),
      line: toOptional(numberOrNull(item.line)),
      nodeId: isString(nodeId) ? nodeId : optionalWhen(isString, id),
    }, context)
    return { ...item, symbolRef: symbolRef || item.symbolRef, target: { path: item.path, symbol: item.name, container: optionalWhen(Boolean(item.container), item.container) } }
  }))
}

function choose<T>(candidates: T[], target: CodeSymbolTarget): T {
  if (candidates.length === 1) return candidates[0]!
  throw new ProjectError(!isEmpty(candidates) ? 'AMBIGUOUS_TARGET' : 'TARGET_NOT_FOUND',
    !isEmpty(candidates) ? '同名符号仍有多个声明。' : '当前项目中未找到目标符号。',
    { target, candidates }, '查询 symbols 后使用具体 symbolRef；必要时指定 container。')
}

async function locate(target: CodeSymbolTarget, context: ProjectToolContext): Promise<ProjectSymbol> {
  const kernel = await context.project.kernel()
  const symbols = (await kernel.listSymbols(target.path)).filter((item) =>
    item.name === target.symbol && (!target.container || item.container === target.container))
  // 先前展示的位置可用于区分当前重载声明；编辑权限仍由实际源码窗口决定。
  const atLine = target.line ? symbols.filter((item) => item.range.startLine === target.line) : []
  return choose(atLine.length === 1 ? atLine : symbols, target)
}

async function graphTarget(input: ProjectCodeTarget, context: ProjectToolContext): Promise<CodeSymbolTarget & { nodeId: string }> {
  const target = await resolveCodeSymbolReference(input, context)
  const result = await query({ action: 'search_symbols', query: target.symbol, limit: 50 }, context)
  const matches = graphRows(result).filter((item) =>
    item.name === target.symbol && isString(item.path) && sameCodePath(context.project.getRootPath(), item.path, target.path) &&
    (!target.container || item.container === target.container) && isString(((item.id ?? item.nodeId))))
  const atLine = target.line ? matches.filter((item) => item.line === target.line) : []
  const node = choose(atLine.length === 1 ? atLine : matches, target)
  return { ...target, nodeId: String(node.id ?? node.nodeId) }
}

async function symbols(input: Extract<ProjectCodeInput, { action: 'symbols' }>, context: ProjectToolContext) {
  if (input.target) {
    const target = await resolveCodeSymbolReference(input.target, context)
    const before = await (await context.project.kernel()).read({ path: target.path, maxChars: 1 })
    const symbol = await locate(target, context)
    const detail = symbol as ProjectSymbol & { bodyRange?: ProjectSymbol['range']; statementRange?: ProjectSymbol['range'] }
    const source = await executeProjectRead({ path: symbol.path, range: [symbol.range.startLine, symbol.range.endLine], maxChars: 20_000 }, context)
    if (source.files.some((file) => file.revision !== before.snapshot.revision))
      throw new ProjectError('BASE_REVISION_MISMATCH', '符号解析期间文件发生变化，声明范围与源码不属于同一版本。', { path: target.path }, '重新查询该符号详情。')
    return envelope(input, { source: symbol.adapterId, symbols: await symbolRows([{ ...symbol, line: symbol.range.startLine }], context) }, {
      declaration: symbol.range,
      body: detail.bodyRange,
      statement: detail.statementRange,
      source,
      coverage: { path: symbol.path, version: 'read-snapshot', range: symbol.range, truncated: source.files.some((file) => file.hasMore) },
    })
  }
  const result = input.exportedOnly
    ? await query({ action: 'list_exports', ...scope(input), path: input.path, query: input.query, includeReExports: input.includeReExports }, context)
    : await query({ action: 'find_symbols', ...scope(input), path: input.path, query: input.query, kinds: input.kinds, exact: input.exact }, context)
  let items = rows(result.symbols ?? result.exports)
  if (input.kinds) items = items.filter((item) => input.kinds!.includes(String(item.kind)))
  if (input.exact && input.query) items = items.filter((item) => item.name === input.query)
  if (isEmpty(items) && input.query && !input.exportedOnly) {
    try {
      const graph = await query({ action: 'search_symbols', query: input.query, kind: input.kinds?.length === 1 ? input.kinds[0] : undefined, limit: Math.min(50, input.limit ?? 30) }, context)
      items = graphRows(graph).filter((item) =>
        isString(item.name) && item.name.toLocaleLowerCase('en-US').includes(input.query!.toLocaleLowerCase('en-US')) &&
        (!input.path || (isString(item.path) && (sameCodePath(context.project.getRootPath(), item.path, input.path) || item.path.startsWith(`${input.path.replace(/\/$/, '')}/`)))) &&
        (!input.exact || item.name === input.query) && (!input.kinds || input.kinds.includes(String(item.kind))))
      if (!isEmpty(items)) {
        const { results: _results, nodes: _nodes, ...metadata } = graph
        return envelope(input, metadata, { symbols: await symbolRows(items, context) })
      }
    } catch (error) { if (!unavailable(error)) throw error }
  }
  const { exports: _exports, ...rest } = result
  return envelope(input, rest, { symbols: await symbolRows(items, context) })
}

async function relations(input: Extract<ProjectCodeInput, { action: 'relations' }>, context: ProjectToolContext) {
  try {
    const target = await graphTarget(input.target, context)
    if (input.kind === 'calls') {
      const parts: RecordValue = {}
      if (input.direction !== 'outgoing') parts.incoming = boundRelations(await query({ action: 'callers', nodeId: target.nodeId, depth: input.depth }, context), input.limit ?? 30)
      if (input.direction !== 'incoming') parts.outgoing = boundRelations(await query({ action: 'callees', nodeId: target.nodeId, depth: input.depth }, context), input.limit ?? 30)
      return envelope(input, { ...parts, truncated: Object.values(parts).some((part) => record(part).truncated), sources: Object.values(parts).map((part) => ({ backend: record(part).source ?? 'codegraph' })) })
    }
    const result = await query(input.kind === 'types' ? { action: 'type_hierarchy', nodeId: target.nodeId } : { action: 'explore', nodeIds: [target.nodeId] }, context)
    if (isArray(result.relations) && isArray(result.nodes)) {
      const edges = rows(result.relations)
      const selected = new Set<string>([target.nodeId])
      let frontier = new Set(selected)
      for (let depth = 0; depth < input.depth && frontier.size; depth++) {
        const next = new Set<string>()
        for (const edge of edges) {
          if (input.direction !== 'incoming' && frontier.has(String(edge.from))) next.add(String(edge.to))
          if (input.direction !== 'outgoing' && frontier.has(String(edge.to))) next.add(String(edge.from))
        }
        frontier = new Set([...next].filter((id) => !selected.has(id)))
        for (const id of frontier) selected.add(id)
      }
      return envelope(input, boundRelations({ ...result, nodes: rows(result.nodes).filter((item) => selected.has(String(item.id))), relations: edges.filter((edge) => selected.has(String(edge.from)) && selected.has(String(edge.to))) }, input.limit ?? 30), { direction: input.direction })
    }
    return envelope(input, boundRelations(result, input.limit ?? 30), { requestedDirection: input.direction, degraded: [
      ...(isString(result.degraded) ? [result.degraded] : []),
      ...(input.direction === 'both' ? [] : ['当前图后端未提供可验证的边方向，返回双向关系；没有把未分类节点伪装成指定方向。']),
    ] })
  } catch (error) {
    if (!unavailable(error)) throw error
    return envelope(input, { relations: [], source: 'unavailable' }, { degraded: ['当前宿主未启用关系查询后端；没有用文本命中替代调用关系。'], capabilities: ProjectCodeCapabilityCatalogue })
  }
}

export async function executeProjectCode(input: ProjectCodeInput, context: ProjectToolContext): Promise<RecordValue> {
  context.abortSignal.throwIfAborted()
  if (input.cwd) return context.project.runInDirectory(input.cwd, () => {
    const directory = resolve(context.project.getRootPath(), input.cwd!)
    const scoped = { ...input, cwd: undefined }
    if (input.action === 'dependencies' && input.direction === 'incoming') {
      if (input.path) Object.assign(scoped, { path: resolve(directory, input.path) })
      Object.assign(scoped, { within: resolve(directory, input.within ?? '.') })
    } else if (input.action !== 'relations' && !(input.action === 'symbols' && input.target)) {
      Object.assign(scoped, { path: resolve(directory, input.path ?? '.') })
    }
    if ('target' in input && input.target && 'path' in input.target)
      Object.assign(scoped, { target: { ...input.target, path: resolve(directory, input.target.path) } })
    return executeProjectCode(scoped, context)
  })
  switch (input.action) {
    case 'symbols': return symbols(input, context)
    case 'relations': return relations(input, context)
    case 'diagnostics': return envelope(input, await query({ action: 'language_diagnostics', ...scope(input), path: input.path }, context))
    case 'dependencies': {
      const result = await query(input.direction === 'outgoing'
        ? { action: 'find_imports', ...scope(input), path: input.path, specifier: input.specifier, kind: input.kind, includeExternal: input.includeExternal }
        : { action: 'find_importers', ...scope(input), targetPath: input.path, path: input.within, specifier: input.specifier, includeReExports: input.includeReExports }, context)
      let graph: unknown
      // 保留 file_dependencies 补充的编译器模块依赖边。旧后端会返回两个方向的邻接信息，
      // 因此将其与按方向筛选的导入记录分开。
      if (input.path && (await (await context.project.kernel()).stat({ path: input.path })).kind === 'file') {
        try { graph = { scope: 'file-neighborhood', filtersApplied: false, ...await query({ action: 'file_dependencies', path: relative(context.project.getRootPath(), resolve(context.project.getRootPath(), input.path)) }, context) } }
        catch (error) { if (!unavailable(error)) throw error }
      }
      return envelope(input, result, { direction: input.direction, graph })
    }
    case 'references': {
      const target = await resolveCodeSymbolReference(input.target, context)
      await locate(target, context)
      const result = await query({ action: 'find_references', ...scope(input), symbol: target.symbol, path: input.path, exactWord: true }, context)
      return envelope(input, result, { target, resolution: 'name-candidates', degraded: [String(result.degraded ?? ''), '此语言查询按名称收集引用候选；同名声明之间的绑定关系未得到后端证明。'].filter(Boolean) })
    }
    case 'impact': {
      const target = await resolveCodeSymbolReference(input.target, context)
      await locate(target, context)
      const result = await query({ action: 'analyze_symbol_impact', ...scope(input), symbol: target.symbol, path: input.path, declarationPath: target.path, kinds: input.kinds }, context)
      let graph: unknown
      try {
        const resolved = await graphTarget(input.target, context)
        graph = await query({ action: 'impact', nodeId: resolved.nodeId, depth: input.depth }, context)
      } catch (error) { if (!unavailable(error) && !(error instanceof ProjectError && error.reason === 'TARGET_NOT_FOUND')) throw error }
      return envelope(input, result, { target, graph, resolution: 'impact-candidates', degraded: ['影响候选保留语言服务来源；名称引用不等于精确绑定证明。', ...(isString(result.degraded) ? [result.degraded] : [])] })
    }
  }
}

/** Hosts may expose this with a situational capability, independently of the six-action tool. */
export async function executeProjectCodeAnalysis(input: ProjectCodeAnalysisInput, context: ProjectToolContext) {
  let request: ProjectCodeQuery
  switch (input.action) {
    case 'trace': {
      const from = await graphTarget(input.from, context)
      const to = await graphTarget(input.to, context)
      request = { action: 'trace', fromSymbol: from.nodeId, toSymbol: to.nodeId }
      break
    }
    case 'cycles': request = { action: 'find_cycles', maxFiles: input.maxFiles }; break
    case 'deadcode': request = { action: 'find_dead_code', limit: input.limit ?? 30 }; break
    case 'routing': request = { action: 'routing_manifest', framework: input.framework }; break
  }
  return envelope(input, await query(request, context))
}

/** Index lifecycle is a host API; it is never reachable through a read-only model schema. */
export async function executeProjectCodeIndex(
  input: { action: 'build_index'; force?: boolean } | { action: 'index_status' }, context: ProjectToolContext,
) {
  return query(input.action === 'build_index' ? { ...input, force: input.force ?? true } : input, context)
}
