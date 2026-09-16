/**
 * 代码查询的主体：把 project:code 与 project:code-analysis 的动作翻译成宿主的代码查询（语言服务、图后端），把符号换成可复用的 symbolRef，结果装进带来源与覆盖范围的信封。
 */

import { relative, resolve } from 'node:path'

import { isArray, isEmpty, isNumber, isPlainObject, isString, isTrue, numberOrNull, optionalWhen, toOptional } from '@velaros-ai/core'

import { ProjectCodeLimits } from '../../contract/constants.js'
import type { ProjectToolContext } from '../../contract/requires.js'
import type { ProjectSymbol } from '../../types/adapter.js'
import type { CodeSymbolTarget, RecordValue } from '../../types/agent.js'
import type { ProjectCodeQuery, ProjectCodeScope } from '../../types/project.js'
import type { ProjectCodeAnalysisInput, ProjectCodeInput, ProjectCodeTarget } from '../../types/tools.js'
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

/** 从 project:code 的入参里取出交给语言服务的公共范围：语言、条数上限、扩展名与目录深度。 */
function scope(input: ProjectCodeScope): ProjectCodeScope {
  return { language: input.language, limit: input.limit, extensions: input.extensions, maxDepth: input.maxDepth }
}

/** 代码能力目录：关系查询后端没启用时随降级回执一起给出，只列模型自己调得到的 intent。 */
export const ProjectCodeCapabilityCatalogue = Object.freeze({
  intents: ['outline', 'definition', 'references', 'callers', 'callees', 'imports', 'importers', 'impact', 'diagnostics'],
  extensions: [{ tool: 'project:code-analysis', intents: ['trace', 'cycles', 'deadcode', 'routing'], note: '宿主有代码图后端时才有' }],
})

/** 这个错误是不是「后端没启用」：code 为 UNAVAILABLE 或 reason 为 NOT_SUPPORTED；是的话调用方降级说明，不当成查询失败。 */
function unavailable(error: unknown): boolean {
  const value = error as { code?: string; reason?: string }
  return value?.code === 'UNAVAILABLE' || value?.reason === 'NOT_SUPPORTED'
}

/** 把宿主结果装进回执信封：标出 intent、来源后端、覆盖范围（路径、语言、扫描文件数、是否截断、条数上限、版本）和降级说明，extra 覆盖在最后。 */
function envelope(input: { intent: string; path?: string; language?: string; limit?: number }, raw: unknown, extra: RecordValue = {}) {
  const result = record(raw)
  const degradation = [result.degraded, result.note].filter((value): value is string => isString(value) && value.length > 0)
  return {
    ...result,
    intent: input.intent,
    sources: result.sources ?? [{ backend: result.source ?? 'host', services: result.services }],
    coverage: {
      path: input.path ?? '.',
      language: input.language,
      scannedFiles: result.scannedFiles,
      truncated: isTrue(result.truncated),
      limit: input.limit ?? ProjectCodeLimits.resultsDefault,
      // 结果是不是绑在一个确定版本上：绑了才敢当依据，没绑就只是当前这一眼看到的位置。
      versioned: !!result.revision,
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

/** outline：列出这个文件（或目录）里的符号，每个带可复用的 symbolRef。 */
async function outline(input: Extract<ProjectCodeInput, { intent: 'outline' }>, context: ProjectToolContext) {
  const result = await query({ action: 'find_symbols', ...scope(input), path: input.path }, context)
  return envelope(input, result, { symbols: await symbolRows(rows(result.symbols), context) })
}

/**
 * definition：给出这个符号的声明、body 范围和当前源码（中途文件变了就报版本冲突）；
 * target 指的文件里没有这个声明时，退一步按名字在整个项目里找候选，回执说明这是候选不是定论。
 */
async function definition(input: Extract<ProjectCodeInput, { intent: 'definition' }>, context: ProjectToolContext) {
  const target = await resolveCodeSymbolReference(input.target, context)
  const before = await (await context.project.kernel()).read({ path: target.path, maxChars: 1 })
  let symbol: ProjectSymbol
  try {
    symbol = await locate(target, context)
  } catch (error) {
    if (!(error instanceof ProjectError) || error.reason !== 'TARGET_NOT_FOUND') throw error
    // 模型常把「看到它的文件」当成「声明它的文件」：按名字在整个项目里找一遍，给候选而不是空手回去。
    const found = await query({ action: 'find_symbols', ...scope(input), query: target.symbol, exact: true }, context)
    const candidates = rows(found.symbols).filter((item) => item.name === target.symbol)
    if (isEmpty(candidates)) throw error
    return envelope(input, found, { symbols: await symbolRows(candidates, context),
      degraded: [`${target.path} 里没有 ${target.symbol} 的声明，这些是按名字在整个项目里找到的候选；挑一个的 symbolRef 再查一次。`] })
  }
  const detail = symbol as ProjectSymbol & { bodyRange?: ProjectSymbol['range']; statementRange?: ProjectSymbol['range'] }
  const source = await readProjectSource({ files: [{ path: symbol.path, range: [symbol.range.startLine, symbol.range.endLine] }], maxChars: ProjectTuning.codeQuery.symbolSourceChars }, context)
  if (source.files.some((file) => file.revision !== before.snapshot.revision))
    throw new ProjectError('BASE_REVISION_MISMATCH', '符号解析期间文件发生变化，声明范围与源码不属于同一版本。', { path: target.path }, '重新查询该符号的 definition。')
  return envelope(input, { source: symbol.adapterId, symbols: await symbolRows([{ ...symbol, line: symbol.range.startLine }], context) }, {
    declaration: symbol.range,
    body: detail.bodyRange,
    statement: detail.statementRange,
    source,
    coverage: { path: symbol.path, versioned: true, range: symbol.range, truncated: source.files.some((file) => file.hasMore) },
  })
}

/**
 * callers / callees：从目标符号所在的图节点往一个方向展开调用关系并封顶；
 * 关系后端没启用时返回空关系加降级说明与能力目录，不拿文本命中冒充调用关系。
 */
async function calls(input: Extract<ProjectCodeInput, { intent: 'callers' | 'callees' }>, context: ProjectToolContext) {
  // 层数在这里补：schema 的根是一个平对象，字段级 default 会落到所有 intent 上，那样反倒说不清哪个 intent 收哪些字段。
  const depth = ProjectCodeLimits.relationDepthDefault
  try {
    const target = await graphTarget(input.target, context)
    const result = boundRelations(await query({ action: input.intent === 'callers' ? 'callers' : 'callees', nodeId: target.nodeId, depth }, context), input.limit ?? ProjectCodeLimits.resultsDefault)
    return envelope(input, result, { target, sources: [{ backend: result.source ?? 'codegraph' }] })
  } catch (error) {
    if (!unavailable(error)) throw error
    return envelope(input, { relations: [], source: 'unavailable' }, { degraded: ['当前宿主未启用关系查询后端；没有用文本命中替代调用关系。'], capabilities: ProjectCodeCapabilityCatalogue })
  }
}

/** imports / importers：一个文件引了谁、谁引了它；是文件时再补一份编译器给的模块邻接。 */
async function dependencies(input: Extract<ProjectCodeInput, { intent: 'imports' | 'importers' }>, context: ProjectToolContext) {
  const result = await query(input.intent === 'imports'
    ? { action: 'find_imports', ...scope(input), path: input.path }
    : { action: 'find_importers', ...scope(input), targetPath: input.path }, context)
  let graph: unknown
  // 保留 file_dependencies 补充的编译器模块依赖边。旧后端会返回两个方向的邻接信息，
  // 因此将其与按方向筛选的导入记录分开。
  if ((await (await context.project.kernel()).stat({ path: input.path })).kind === 'file') {
    try { graph = { scope: '文件邻接（两个方向都有）', ...await query({ action: 'file_dependencies', path: relative(context.project.getRootPath(), resolve(context.project.getRootPath(), input.path)) }, context) } }
    catch (error) { if (!unavailable(error)) throw error }
  }
  return envelope(input, result, { graph })
}

/** 代码查询：九个 intent，路径一律相对项目根。结果统一装进带来源与覆盖范围的信封。 */
export async function queryProjectCode(input: ProjectCodeInput, context: ProjectToolContext): Promise<RecordValue> {
  context.abortSignal.throwIfAborted()
  switch (input.intent) {
    case 'outline': return outline(input, context)
    case 'definition': return definition(input, context)
    case 'callers': case 'callees': return calls(input, context)
    case 'imports': case 'importers': return dependencies(input, context)
    case 'diagnostics': return envelope(input, await query({ action: 'language_diagnostics', ...scope(input), path: input.path }, context))
    case 'references': {
      const target = await resolveCodeSymbolReference(input.target, context)
      await locate(target, context)
      const result = await query({ action: 'find_references', ...scope(input), symbol: target.symbol, path: input.path, exactWord: true }, context)
      return envelope(input, result, { target, degraded: [String(result.degraded ?? ''), '这一类语言查询按名字收集引用候选，同名声明之间的绑定关系后端没有证明。'].filter(Boolean) })
    }
    case 'impact': {
      const target = await resolveCodeSymbolReference(input.target, context)
      await locate(target, context)
      const result = await query({ action: 'analyze_symbol_impact', ...scope(input), symbol: target.symbol, path: input.path, declarationPath: target.path }, context)
      let graph: unknown
      try {
        const resolved = await graphTarget(input.target, context)
        graph = await query({ action: 'impact', nodeId: resolved.nodeId, depth: ProjectCodeLimits.relationDepthDefault }, context)
      } catch (error) { if (!unavailable(error) && !(error instanceof ProjectError && error.reason === 'TARGET_NOT_FOUND')) throw error }
      return envelope(input, result, { target, graph, degraded: ['影响面是语言服务给的候选：按名字找到的引用不等于精确绑定。', ...(isString(result.degraded) ? [result.degraded] : [])] })
    }
  }
}

/** 代码图分析：trace、cycles、deadcode、routing，交给宿主的图后端，结果装进同样的信封。 */
export async function analyzeProjectCode(input: ProjectCodeAnalysisInput, context: ProjectToolContext) {
  let request: ProjectCodeQuery
  switch (input.intent) {
    case 'trace': {
      const from = await graphTarget(input.from, context)
      const to = await graphTarget(input.to, context)
      request = { action: 'trace', fromSymbol: from.nodeId, toSymbol: to.nodeId }
      break
    }
    case 'cycles': request = { action: 'find_cycles', maxFiles: input.maxFiles }; break
    case 'deadcode': request = { action: 'find_dead_code', limit: input.limit ?? ProjectCodeLimits.resultsDefault }; break
    case 'routing': request = { action: 'routing_manifest', framework: input.framework }; break
  }
  return envelope(input, await query(request, context))
}
