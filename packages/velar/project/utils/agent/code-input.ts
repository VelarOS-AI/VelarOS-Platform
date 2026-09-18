/**
 * `velar:code` 的入参核对：程序在写的时候过了类型检查，这里拦类型挡不住的——不认识的 intent、缺了必填的 target 或 path、
 * 范围越界（扩展名太多、目录层数不对），以及绕过检查塞进来的错形状。不合法就当场以 INVALID_INPUT 拒绝，不去问宿主。
 */

import { isArray, isNonBlankString, isNumber, isPlainObject, isString, isUndefined } from '@velaros-ai/core'

import { ProjectCodeLimits } from '../../contract/constants.js'
import type { CodeAnalysisInput, CodeQueryInput } from '../../types/code.js'
import { ProjectError } from '../errors.js'

/** query 的 intent：哪些要 target、哪些要 path。 */
const QueryIntents = Object.freeze({
  target: ['definition', 'references', 'callers', 'callees', 'impact'],
  path: ['outline', 'imports', 'importers', 'diagnostics'],
})

/** analyze 的 intent。 */
const AnalysisIntents = Object.freeze(['trace', 'cycles', 'deadcode', 'routing'])

/** 入参不合法：说清是哪个字段、要什么。 */
function invalid(message: string): ProjectError {
  return new ProjectError('INVALID_INPUT', message)
}

/** 一个符号目标：{ symbol }，可带 path 与 container，都是非空字符串。 */
function checkTarget(value: unknown, field: string): void {
  if (!isPlainObject(value) || !isString(value.symbol) || !value.symbol.trim()) throw invalid(`${field} 要 { symbol }（可带 path、container），这里给的是 ${JSON.stringify(value)}`)
  for (const key of ['path', 'container'] as const) {
    if (!isUndefined(value[key]) && (!isString(value[key]) || !value[key].trim())) throw invalid(`${field}.${key} 要非空字符串`)
  }
}

/** 查询范围：language 非空，extensions 最多 ProjectCodeLimits.extensions 个非空字符串，maxDepth 是 0–ProjectCodeLimits.scanDepth 的整数。 */
function checkScope(value: Record<string, unknown>): void {
  if (!isUndefined(value.language) && !isNonBlankString(value.language)) throw invalid('language 要非空字符串，比如 \'typescript\'')
  if (!isUndefined(value.extensions)) {
    const extensions = value.extensions
    if (!isArray(extensions) || extensions.length > ProjectCodeLimits.extensions || !extensions.every(isNonBlankString)) {
      throw invalid(`extensions 要最多 ${ProjectCodeLimits.extensions} 个扩展名的数组（比如 ['.ts', '.tsx']），这里给的是 ${JSON.stringify(extensions)}`)
    }
  }
  const depth = value.maxDepth
  if (!isUndefined(depth) && (!isNumber(depth) || !Number.isInteger(depth) || depth < 0 || depth > ProjectCodeLimits.scanDepth)) {
    throw invalid(`maxDepth 要 0–${ProjectCodeLimits.scanDepth} 之间的整数，这里给的是 ${JSON.stringify(depth)}`)
  }
}

/** query 的入参：intent 认得，要 target 的给了 target，要 path 的给了 path，范围在界内；类型是声明给的，形状照样逐项核（程序可能绕过检查）。 */
export function codeQueryInput(input: CodeQueryInput): CodeQueryInput {
  const value: unknown = input
  if (!isPlainObject(value)) throw invalid(`query 要一个对象作入参，这里给的是 ${JSON.stringify(value)}`)
  const intent = value.intent
  const needsTarget = QueryIntents.target.includes(String(intent))
  const needsPath = QueryIntents.path.includes(String(intent))
  if (!needsTarget && !needsPath) throw invalid(`query 的 intent 只收 ${[...QueryIntents.path, ...QueryIntents.target].join('、')}，这里给的是 ${JSON.stringify(intent)}；trace、cycles、deadcode、routing 用 analyze`)
  if (needsTarget) checkTarget(value.target, 'target')
  if (needsPath && (!isString(value.path) || !value.path.trim())) throw invalid(`${String(intent)} 要 path（要看的那个文件，相对项目根）`)
  checkScope(value)
  return input
}

/** analyze 的入参：intent 认得，trace 给了 from 与 to。 */
export function codeAnalysisInput(input: CodeAnalysisInput): CodeAnalysisInput {
  const value: unknown = input
  if (!isPlainObject(value)) throw invalid(`analyze 要一个对象作入参，这里给的是 ${JSON.stringify(value)}`)
  if (!AnalysisIntents.includes(String(value.intent))) throw invalid(`analyze 的 intent 只收 ${AnalysisIntents.join('、')}，这里给的是 ${JSON.stringify(value.intent)}`)
  if (value.intent === 'trace') {
    checkTarget(value.from, 'from')
    checkTarget(value.to, 'to')
  }
  return input
}
