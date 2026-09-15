/**
 * 代码查询的主体：把 project:code 与 project:code-analysis 的动作翻译成宿主的代码查询（语言服务、图后端），把符号换成可复用的 symbolRef，结果装进带来源与覆盖范围的信封。
 */

import { relative, resolve } from 'node:path'

import { isArray, isEmpty, isNumber, isPlainObject, isString, isTrue, numberOrNull, optionalWhen, toOptional } from '@velaros-ai/core'

import type { ProjectToolContext } from '../../contract/requires.js'
import type { ProjectSymbol } from '../../types/adapter.js'
import type { CodeSymbolTarget, RecordValue } from '../../types/agent.js'
import type { ProjectCodeQuery } from '../../types/project.js'
import type { ProjectCodeAnalysisInput, ProjectCodeInput, ProjectCodeScope, ProjectCodeTarget } from '../../types/tools.js'
import { ProjectError } from '../errors.js'
import { ProjectTuning } from '../tuning.js'

import { readProjectSource } from './project-files.js'
import { resolveCodeSymbolReference, sameCodePath, saveCodeSymbolReference } from './symbol-references.js'

/** 把宿主返回的值当成普通对象用：本来就是普通对象原样返回，否则包成 { result }。 */
function record(value: unknown): RecordValue {
  return isPlainObject(value) ? value as RecordValue : { result: value }
}

/** 取数组里的普通对象条目；不是数组时返回空数组。 */
function rows(value: unknown): RecordValue[] {
  return isArray(value) ? value.filter((entry) => isPlainObject(entry)) : []
}

/** 取代码图谱结果里的条目（results、symbols 或 nodes）；编译器后端给的 0 起算位置换成 1 起算的 line、column。 */
function graphRows(result: RecordValue): RecordValue[] {
  return rows(result.results ?? result.symbols ?? result.nodes).map((item) => {
    const start = record(record(item.range).start)
    return result.source === 'velar-compiler' && isNumber(start.line)
      ? { ...item, line: start.line + 1, column: isNumber(start.character) ? start.character + 1 : undefined }
      : item
  })
}

/** 给关系结果封顶：callers、callees、nodes 各留前 limit 条，边只留两端都还在的，output、relationshipMap 这类整段文字截短；截过就标 truncated。 */
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
    if (!isString(bounded[key]) || bounded[key].length <= ProjectTuning.codeQuery.relationTextChars) continue
    bounded[key] = bounded[key].slice(0, ProjectTuning.codeQuery.relationTextChars)
    truncated = true
  }
  return { ...bounded, truncated }
}

/** 从 project:code 的入参里取出交给语言服务的公共范围：语言、工作目录、条数上限、扩展名与目录深度。 */
function scope(input: ProjectCodeScope): ProjectCodeScope {
  return { language: input.language, cwd: input.cwd, limit: input.limit, extensions: input.extensions, maxDepth: input.maxDepth }
}

/** 代码能力目录：关系查询后端没启用时随降级回执一起给出，告诉模型哪些动作在哪个工具、哪些依赖宿主。 */
export const ProjectCodeCapabilityCatalogue = Object.freeze({
  tool: 'project:code',
  discovery: 'tooling:map',
  actions: ['symbols', 'references', 'dependencies', 'relations', 'impact', 'diagnostics'],
  extensions: [{ id: 'project:code-analysis', actions: ['trace', 'cycles', 'deadcode', 'routing'], availability: 'host-dependent' }],
  host: { index: ['build_index', 'index_status'], taskContext: 'build_context' },
})

/** 这个错误是不是「后端没启用」：code 为 UNAVAILABLE 或 reason 为 NOT_SUPPORTED；是的话调用方降级说明，不当成查询失败。 */
function unavailable(error: unknown): boolean {
  const value = error as { code?: string; reason?: string }
  return value?.code === 'UNAVAILABLE' || value?.reason === 'NOT_SUPPORTED'
}

/** 把宿主结果装进回执信封：标出动作、来源后端、覆盖范围（路径、语言、扫描文件数、是否截断、条数上限、版本）和降级说明，extra 覆盖在最后。 */
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
      limit: input.limit ?? ProjectTuning.codeQuery.defaultResults,
      version: result.revision ? 'backend-reported' : 'unversioned-locations',
      revisions: result.revision ? [{ revision: result.revision, scope: result.source ?? 'host' }] : [],
      ...record(result.coverage ?? {}),
    },
    degraded: degradation,
    ...extra,
  }
}

/** 把一条代码查询交给宿主的 queryCode，先核对这次调用没被取消；结果按普通对象返回。 */
async function query(input: ProjectCodeQuery, context: ProjectToolContext) {
  context.abortSignal.throwIfAborted()
  return record(await context.project.queryCode(input, context))
}

/** 给每个带路径和名字的符号签发 symbolRef，并附上 {path, symbol, container} 形式的 target；后端的节点 id 收进引用，不直接交给模型。 */
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

/** 候选里恰好一个就用它；多个报 AMBIGUOUS_TARGET，一个没有报 TARGET_NOT_FOUND。 */
function choose<T>(candidates: T[], target: CodeSymbolTarget): T {
  if (candidates.length === 1) return candidates[0]!
  throw new ProjectError(!isEmpty(candidates) ? 'AMBIGUOUS_TARGET' : 'TARGET_NOT_FOUND',
    !isEmpty(candidates) ? '同名符号仍有多个声明。' : '当前项目中未找到目标符号。',
    { target, candidates }, '查询 symbols 后使用具体 symbolRef；必要时指定 container。')
}

/** 在目标文件的符号表里找到目标符号的声明（按名字、容器，有行号时优先同一行的那个）；找不到或不唯一时抛错。 */
async function locate(target: CodeSymbolTarget, context: ProjectToolContext): Promise<ProjectSymbol> {
  const kernel = await context.project.kernel()
  const symbols = (await kernel.listSymbols(target.path)).filter((item) =>
    item.name === target.symbol && (!target.container || item.container === target.container))
  // 先前展示的位置可用于区分当前重载声明；编辑权限仍由实际源码窗口决定。
  const atLine = target.line ? symbols.filter((item) => item.range.startLine === target.line) : []
  return choose(atLine.length === 1 ? atLine : symbols, target)
}

/** 把目标符号换成代码图谱里的节点：按名字搜候选，再按路径、容器、行号收窄到唯一一个；找不到或不唯一时抛错。 */
async function graphTarget(input: ProjectCodeTarget, context: ProjectToolContext): Promise<CodeSymbolTarget & { nodeId: string }> {
  const target = await resolveCodeSymbolReference(input, context)
  const result = await query({ action: 'search_symbols', query: target.symbol, limit: ProjectTuning.codeQuery.graphCandidates }, context)
  const matches = graphRows(result).filter((item) =>
    item.name === target.symbol && isString(item.path) && sameCodePath(context.project.getRootPath(), item.path, target.path) &&
    (!target.container || item.container === target.container) && isString(((item.id ?? item.nodeId))))
  const atLine = target.line ? matches.filter((item) => item.line === target.line) : []
  const node = choose(atLine.length === 1 ? atLine : matches, target)
  return { ...target, nodeId: String(node.id ?? node.nodeId) }
}

/**
 * symbols 动作：带 target 时给这个符号的声明、body 范围和当前源码（中途文件变了就报版本冲突）；否则按 query、path、种类查符号或导出，
 * 语言服务查不到时回退代码图谱的名字搜索。
 */
async function symbols(input: Extract<ProjectCodeInput, { action: 'symbols' }>, context: ProjectToolContext) {
  if (input.target) {
    const target = await resolveCodeSymbolReference(input.target, context)
    const before = await (await context.project.kernel()).read({ path: target.path, maxChars: 1 })
    const symbol = await locate(target, context)
    const detail = symbol as ProjectSymbol & { bodyRange?: ProjectSymbol['range']; statementRange?: ProjectSymbol['range'] }
    const source = await readProjectSource({ path: symbol.path, range: [symbol.range.startLine, symbol.range.endLine], maxChars: ProjectTuning.codeQuery.symbolSourceChars }, context)
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
      const graph = await query({ action: 'search_symbols', query: input.query, kind: input.kinds?.length === 1 ? input.kinds[0] : undefined, limit: Math.min(ProjectTuning.codeQuery.graphCandidates, input.limit ?? ProjectTuning.codeQuery.defaultResults) }, context)
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

/**
 * relations 动作：calls 查调用方与被调方，types 查类型层级，related 查相关节点，按 direction 与 depth 从目标节点展开并封顶；
 * 后端给不出边的方向时如实说明，关系后端没启用时返回空关系加降级说明与能力目录。
 */
async function relations(input: Extract<ProjectCodeInput, { action: 'relations' }>, context: ProjectToolContext) {
  try {
    const target = await graphTarget(input.target, context)
    if (input.kind === 'calls') {
      const parts: RecordValue = {}
      if (input.direction !== 'outgoing') parts.incoming = boundRelations(await query({ action: 'callers', nodeId: target.nodeId, depth: input.depth }, context), input.limit ?? ProjectTuning.codeQuery.defaultResults)
      if (input.direction !== 'incoming') parts.outgoing = boundRelations(await query({ action: 'callees', nodeId: target.nodeId, depth: input.depth }, context), input.limit ?? ProjectTuning.codeQuery.defaultResults)
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
      return envelope(input, boundRelations({ ...result, nodes: rows(result.nodes).filter((item) => selected.has(String(item.id))), relations: edges.filter((edge) => selected.has(String(edge.from)) && selected.has(String(edge.to))) }, input.limit ?? ProjectTuning.codeQuery.defaultResults), { direction: input.direction })
    }
    return envelope(input, boundRelations(result, input.limit ?? ProjectTuning.codeQuery.defaultResults), { requestedDirection: input.direction, degraded: [
      ...(isString(result.degraded) ? [result.degraded] : []),
      ...(input.direction === 'both' ? [] : ['当前图后端未提供可验证的边方向，返回双向关系；没有把未分类节点伪装成指定方向。']),
    ] })
  } catch (error) {
    if (!unavailable(error)) throw error
    return envelope(input, { relations: [], source: 'unavailable' }, { degraded: ['当前宿主未启用关系查询后端；没有用文本命中替代调用关系。'], capabilities: ProjectCodeCapabilityCatalogue })
  }
}

/** 代码查询：symbols、references、dependencies、relations、impact、diagnostics；cwd 先换算成项目内的绝对路径再查。结果统一装进带来源与覆盖范围的信封。 */
export async function queryProjectCode(input: ProjectCodeInput, context: ProjectToolContext): Promise<RecordValue> {
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
    return queryProjectCode(scoped, context)
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

/** 代码图分析：trace、cycles、deadcode、routing，交给宿主的图后端，结果装进同样的信封。 */
export async function analyzeProjectCode(input: ProjectCodeAnalysisInput, context: ProjectToolContext) {
  let request: ProjectCodeQuery
  switch (input.action) {
    case 'trace': {
      const from = await graphTarget(input.from, context)
      const to = await graphTarget(input.to, context)
      request = { action: 'trace', fromSymbol: from.nodeId, toSymbol: to.nodeId }
      break
    }
    case 'cycles': request = { action: 'find_cycles', maxFiles: input.maxFiles }; break
    case 'deadcode': request = { action: 'find_dead_code', limit: input.limit ?? ProjectTuning.codeQuery.defaultResults }; break
    case 'routing': request = { action: 'routing_manifest', framework: input.framework }; break
  }
  return envelope(input, await query(request, context))
}

/** 代码索引的生命周期（重建、查状态）：宿主接口，模型的只读工具碰不到它。 */
export async function indexProjectCode(
  input: { action: 'build_index'; force?: boolean } | { action: 'index_status' }, context: ProjectToolContext,
) {
  return query(input.action === 'build_index' ? { ...input, force: input.force ?? true } : input, context)
}
