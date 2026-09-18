/**
 * 代码查询的主体：把 `velar:code` 的每个 intent 翻译成宿主的代码查询（语言服务、图后端），结果装进带来源与覆盖范围的信封。
 * 查到的符号每个都附一份 `{ path, symbol, container }`：那就是下一次查询能直接传回来的目标，不另发句柄——结果落在程序的变量里，程序自己拿着就行。
 */

import { relative, resolve } from 'node:path'

import { isArray, isEmpty, isNumber, isPlainObject, isString, isTrue, isUndefined, numberOrNull, optionalWhen, toOptional } from '@velaros-ai/core'

import { ProjectCodeLimits } from '../../contract/constants.js'
import type { ProjectOperationContext } from '../../contract/requires.js'
import type { ProjectSymbol } from '../../types/adapter.js'
import type { CodeSymbolTarget, RecordValue } from '../../types/agent.js'
import type { CodeAnalysisInput, CodeQueryInput, CodeResult, CodeResultCoverage, CodeResultSource, CodeTarget } from '../../types/code.js'
import type { ProjectCodeQuery, ProjectCodeScope } from '../../types/project.js'
import { ProjectError } from '../errors.js'
import { ProjectTuning } from '../tuning.js'


/** 把宿主返回的值当成普通对象用：本来就是普通对象原样返回，否则包成 { result }。 */
function record(value: unknown): RecordValue {
  return isPlainObject(value) ? value as RecordValue : { result: value }
}

/** 取数组里的普通对象条目；不是数组时返回空数组。 */
function rows(value: unknown): RecordValue[] {
  return isArray(value) ? value.filter((entry) => isPlainObject(entry)) : []
}

/** 宿主报的「这次结果出自哪个后端」：每条要有 backend，服务说明原样带着；认不出的条目丢掉。 */
function resultSources(value: unknown): CodeResultSource[] {
  return rows(value).filter((item) => isString(item.backend)).map((item) => {
    const source: CodeResultSource = { backend: String(item.backend) }
    if (!isUndefined(item.services)) source.services = item.services
    return source
  })
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

/** 从 query 的入参里取出交给语言服务的公共范围（语言、扩展名、目录深度），加上条数上限：本包总是要全部，只为守住内存封顶。 */
function scope(input: ProjectCodeScope): ProjectCodeScope & { limit: number } {
  return { language: input.language, extensions: input.extensions, maxDepth: input.maxDepth, limit: ProjectCodeLimits.results }
}

/** 代码能力目录：关系查询后端没启用时随降级回执一起给出，只列模型自己调得到的 intent。 */
export const ProjectCodeCapabilityCatalogue = Object.freeze({
  intents: ['outline', 'definition', 'references', 'callers', 'callees', 'imports', 'importers', 'impact', 'diagnostics'],
  extensions: [{ operation: 'analyze', intents: ['trace', 'cycles', 'deadcode', 'routing'], note: '宿主有代码图后端时才有' }],
})

/** 这个错误是不是「后端没启用」：code 为 UNAVAILABLE 或 reason 为 NOT_SUPPORTED；是的话调用方降级说明，不当成查询失败。 */
function unavailable(error: unknown): boolean {
  const value = error as { code?: string; reason?: string }
  return value?.code === 'UNAVAILABLE' || value?.reason === 'NOT_SUPPORTED'
}

/** 把宿主结果装进回执信封：标出 intent、来源后端、覆盖范围（路径、语言、扫描文件数、后端有没有给全、版本）和降级说明，extra 覆盖在最后。 */
function envelope(input: { intent: string; path?: string; language?: string }, raw: unknown, extra: RecordValue = {}): CodeResult {
  const result = record(raw)
  const degradation = [result.degraded, result.note].filter((value): value is string => isString(value) && value.length > 0)
  const backend = isString(result.source) ? result.source : 'host'
  const coverage: CodeResultCoverage = {
    path: input.path ?? '.',
    language: input.language,
    scannedFiles: result.scannedFiles,
    truncated: isTrue(result.truncated),
    // 结果是不是绑在一个确定版本上：绑了才敢当依据，没绑就只是当前这一眼看到的位置。
    versioned: isString(result.revision),
    revisions: isString(result.revision) ? [{ revision: result.revision, scope: backend }] : [],
    ...(record(result.coverage ?? {}) as Partial<CodeResultCoverage>),
  }
  return {
    ...result,
    intent: input.intent,
    sources: isArray(result.sources) ? resultSources(result.sources) : [{ backend, services: result.services }],
    coverage,
    degraded: degradation,
    ...extra,
  }
}

/** 把一条代码查询交给宿主的 queryCode，先核对这次调用没被取消；结果按普通对象返回。 */
async function query(input: ProjectCodeQuery, context: ProjectOperationContext) {
  context.abortSignal.throwIfAborted()
  return record(await context.project.queryCode(input, context))
}

/** 给每个带路径和名字的符号附上 `{ path, symbol, container }`：下一次查询把它原样当 target 传回来就行。后端自己的节点 id 不交出去。 */
function symbolRows(values: RecordValue[]): RecordValue[] {
  return values.map((value) => {
    const { id: _id, nodeId: _nodeId, ...item } = value
    if (!isString(item.path) || !isString(item.name)) return item
    return { ...item, target: { path: item.path, symbol: item.name, container: optionalWhen(Boolean(item.container), item.container) } }
  })
}

/** 两个路径（相对 root 或绝对）是不是同一个文件。 */
function sameCodePath(root: string, left: string, right: string): boolean {
  return resolve(root, left) === resolve(root, right)
}

/** 候选里恰好一个就用它；多个报 AMBIGUOUS_TARGET，一个没有报 TARGET_NOT_FOUND。 */
function choose<T>(candidates: T[], target: CodeSymbolTarget): T {
  if (candidates.length === 1) return candidates[0]!
  throw new ProjectError(!isEmpty(candidates) ? 'AMBIGUOUS_TARGET' : 'TARGET_NOT_FOUND',
    !isEmpty(candidates) ? '同名符号仍有多个声明。' : '当前项目中未找到目标符号。',
    { target, candidates }, '先用 intent=definition 只给 {symbol} 看候选，挑一个的 target 再查；必要时指定 container。')
}

/** 目标只给了名字（没有 path）时返回这个名字，否则返回 undefined。 */
function nameOnlyTarget(target: CodeTarget): Optional<{ symbol: string; container?: string }> {
  return isString(target.path) ? undefined : target
}

/** 按名字在整个项目里找这个符号的声明：名字精确匹配，给了 container 再按 container 收窄。 */
async function declarationsByName(
  scopeInput: ProjectCodeScope,
  target: { symbol: string; container?: string },
  context: ProjectOperationContext,
) {
  const result = await query({ action: 'find_symbols', ...scope(scopeInput), query: target.symbol, exact: true }, context)
  const items = rows(result.symbols).filter((item) =>
    item.name === target.symbol && isString(item.path) && (!target.container || item.container === target.container))
  return { result, items }
}

/** 按名字找到的结果只是候选，回执里照实说。 */
function nameMatchNote(symbol: string): string {
  return `这些是按名字在整个项目里找到的 ${symbol} 声明候选，不是绑定证明；挑一个的 target 再查一次。`
}

/**
 * 把 target 定到一个符号：带 path 的原样用；只给名字时按名字找声明，
 * 恰好一处才定得下来，多处报 AMBIGUOUS_TARGET 并带上候选，一处没有报 TARGET_NOT_FOUND。
 */
async function resolveCodeTarget(
  target: CodeTarget,
  scopeInput: ProjectCodeScope,
  context: ProjectOperationContext,
): Promise<CodeSymbolTarget> {
  if (isString(target.path)) return { ...target, path: target.path }
  const named = target
  const { items } = await declarationsByName(scopeInput, named, context)
  const found = choose(items.map((item) => ({
    path: String(item.path), symbol: named.symbol,
    container: optionalWhen(isString, item.container),
    line: toOptional(numberOrNull(item.line)),
  })), { path: '', symbol: named.symbol, container: named.container })
  return found
}

/** 在目标文件的符号表里找到目标符号的声明（按名字、容器，有行号时优先同一行的那个）；找不到或不唯一时抛错。 */
async function locate(target: CodeSymbolTarget, context: ProjectOperationContext): Promise<ProjectSymbol> {
  const kernel = await context.project.kernel()
  const symbols = (await kernel.listSymbols(target.path)).filter((item) =>
    item.name === target.symbol && (!target.container || item.container === target.container))
  // 先前展示的位置可用于区分当前重载声明；编辑权限仍由实际源码窗口决定。
  const atLine = target.line ? symbols.filter((item) => item.range.startLine === target.line) : []
  return choose(atLine.length === 1 ? atLine : symbols, target)
}

/** 把已经定好的目标符号换成代码图谱里的节点：按名字搜候选，再按路径、容器、行号收窄到唯一一个；找不到或不唯一时抛错。 */
async function graphTarget(target: CodeSymbolTarget, context: ProjectOperationContext): Promise<CodeSymbolTarget & { nodeId: string }> {
  const result = await query({ action: 'search_symbols', query: target.symbol, limit: ProjectTuning.codeQuery.graphCandidates }, context)
  const matches = graphRows(result).filter((item) =>
    item.name === target.symbol && isString(item.path) && sameCodePath(context.project.getRootPath(), item.path, target.path) &&
    (!target.container || item.container === target.container) && isString(((item.id ?? item.nodeId))))
  const atLine = target.line ? matches.filter((item) => item.line === target.line) : []
  const node = choose(atLine.length === 1 ? atLine : matches, target)
  return { ...target, nodeId: String(node.id ?? node.nodeId) }
}

/** outline：列出这个文件（或目录）里的符号，每个带可以直接当 target 传回来的 `{ path, symbol }`。 */
async function outline(input: Extract<CodeQueryInput, { intent: 'outline' }>, context: ProjectOperationContext) {
  const result = await query({ action: 'find_symbols', ...scope(input), path: input.path }, context)
  return envelope(input, result, { symbols: symbolRows(rows(result.symbols)) })
}

/**
 * definition：给出这个符号的声明位置与 body 范围。正文不在这里给——模型手上有 `velar:project` 的 read，
 * 要看那几行自己去读，省得同一段源码在两条路上各截一次。
 * 只给名字时按名字在整个项目里找：恰好一处就直接给详情，多处回候选列表；
 * 给了 path 但那个文件里没有这个声明时，同样退一步按名字找候选，回执说明这是候选不是定论。
 */
async function definition(input: Extract<CodeQueryInput, { intent: 'definition' }>, context: ProjectOperationContext) {
  const named = nameOnlyTarget(input.target)
  if (named) {
    const { result, items } = await declarationsByName(input, named, context)
    if (isEmpty(items))
      throw new ProjectError('TARGET_NOT_FOUND', `整个项目里没有名叫 ${named.symbol} 的符号声明。`, { target: named },
        '用 `velar:project` 的 search 按文本找到它出现的地方，再对那个文件用 intent=outline。')
    // 多处同名：把候选连同各自的路径、种类一起给出去，让模型挑，而不是替它猜一个。
    if (items.length > 1)
      return envelope(input, result, { symbols: symbolRows(items), degraded: [nameMatchNote(named.symbol)] })
  }
  const target = await resolveCodeTarget(input.target, input, context)
  const before = await (await context.project.kernel()).read({ path: target.path, maxChars: 1 })
  let symbol: ProjectSymbol
  try {
    symbol = await locate(target, context)
  } catch (error) {
    if (!(error instanceof ProjectError) || error.reason !== 'TARGET_NOT_FOUND') throw error
    // 模型常把「看到它的文件」当成「声明它的文件」：按名字在整个项目里找一遍，给候选而不是空手回去。
    const { result, items } = await declarationsByName(input, target, context)
    if (isEmpty(items)) throw error
    return envelope(input, result, { symbols: symbolRows(items),
      degraded: [`${target.path} 里没有 ${target.symbol} 的声明。${nameMatchNote(target.symbol)}`] })
  }
  const detail = symbol as ProjectSymbol & { bodyRange?: ProjectSymbol['range']; statementRange?: ProjectSymbol['range'] }
  return envelope(input, { source: symbol.adapterId, symbols: symbolRows([{ ...symbol, line: symbol.range.startLine }]) }, {
    declaration: symbol.range,
    body: detail.bodyRange,
    statement: detail.statementRange,
    // 声明位置绑在解析时看到的那个版本上：文件在这之后被改过，行号就只是候选了。
    coverage: { path: symbol.path, versioned: true, range: symbol.range, revision: before.snapshot.revision },
  })
}

/**
 * callers / callees：从目标符号所在的图节点往一个方向展开调用关系，后端给多少交多少；
 * 关系后端没启用时返回空关系加降级说明与能力目录，不拿文本命中冒充调用关系。
 */
async function calls(input: Extract<CodeQueryInput, { intent: 'callers' | 'callees' }>, context: ProjectOperationContext) {
  // 层数在这里补：schema 的根是一个平对象，字段级 default 会落到所有 intent 上，那样反倒说不清哪个 intent 收哪些字段。
  const depth = ProjectCodeLimits.relationDepthDefault
  try {
    const target = await graphTarget(await resolveCodeTarget(input.target, input, context), context)
    const result = await query({ action: input.intent === 'callers' ? 'callers' : 'callees', nodeId: target.nodeId, depth }, context)
    return envelope(input, result, { target, sources: [{ backend: result.source ?? 'codegraph' }] })
  } catch (error) {
    if (!unavailable(error)) throw error
    return envelope(input, { relations: [], source: 'unavailable' }, { degraded: ['当前宿主未启用关系查询后端；没有用文本命中替代调用关系。'], capabilities: ProjectCodeCapabilityCatalogue })
  }
}

/** imports / importers：一个文件引了谁、谁引了它；是文件时再补一份编译器给的模块邻接。 */
async function dependencies(input: Extract<CodeQueryInput, { intent: 'imports' | 'importers' }>, context: ProjectOperationContext) {
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
export async function queryProjectCode(input: CodeQueryInput, context: ProjectOperationContext): Promise<CodeResult> {
  context.abortSignal.throwIfAborted()
  switch (input.intent) {
    case 'outline': return outline(input, context)
    case 'definition': return definition(input, context)
    case 'callers': case 'callees': return calls(input, context)
    case 'imports': case 'importers': return dependencies(input, context)
    case 'diagnostics': return envelope(input, await query({ action: 'language_diagnostics', ...scope(input), path: input.path }, context))
    case 'references': {
      const target = await resolveCodeTarget(input.target, input, context)
      await locate(target, context)
      const result = await query({ action: 'find_references', ...scope(input), symbol: target.symbol, path: input.path, exactWord: true }, context)
      return envelope(input, result, { target, degraded: [String(result.degraded ?? ''), '这一类语言查询按名字收集引用候选，同名声明之间的绑定关系后端没有证明。'].filter(Boolean) })
    }
    case 'impact': {
      const target = await resolveCodeTarget(input.target, input, context)
      await locate(target, context)
      const result = await query({ action: 'analyze_symbol_impact', ...scope(input), symbol: target.symbol, path: input.path, declarationPath: target.path }, context)
      let graph: unknown
      try {
        const resolved = await graphTarget(target, context)
        graph = await query({ action: 'impact', nodeId: resolved.nodeId, depth: ProjectCodeLimits.relationDepthDefault }, context)
      } catch (error) { if (!unavailable(error) && !(error instanceof ProjectError && error.reason === 'TARGET_NOT_FOUND')) throw error }
      return envelope(input, result, { target, graph, degraded: ['影响面是语言服务给的候选：按名字找到的引用不等于精确绑定。', ...(isString(result.degraded) ? [result.degraded] : [])] })
    }
  }
}

/** 代码图分析：trace、cycles、deadcode、routing，交给宿主的图后端，结果装进同样的信封。 */
export async function analyzeProjectCode(input: CodeAnalysisInput, context: ProjectOperationContext): Promise<CodeResult> {
  let request: ProjectCodeQuery
  // 四个 intent 的分支穷尽了联合类型，switch 之后 request 一定有值。
  switch (input.intent) {
    case 'trace': {
      const from = await graphTarget(await resolveCodeTarget(input.from, {}, context), context)
      const to = await graphTarget(await resolveCodeTarget(input.to, {}, context), context)
      request = { action: 'trace', fromSymbol: from.nodeId, toSymbol: to.nodeId }
      break
    }
    case 'cycles': request = { action: 'find_cycles' }; break
    case 'deadcode': request = { action: 'find_dead_code', limit: ProjectCodeLimits.results }; break
    case 'routing': request = { action: 'routing_manifest', framework: input.framework }; break
  }
  return envelope(input, await query(request, context))
}
