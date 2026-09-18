/**
 * `velar:knowledge` 的入参核对：入参来自模型的程序，类型检查挡不住的在这里拦——query 是不是非空文字、来源类型认不认、
 * 提示与文档 id 的条数、limit 的范围，以及绕过检查塞进来的错形状。不合法当场拒绝（`VALIDATION`），一步都不做。
 */

import { isArray, isBoolean, isNonBlankString, isNumber, isPlainObject, isUndefined } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { KnowledgeSearchLimits, KnowledgeSourceKinds } from '../contract/constants.js'
import type { KnowledgeSourceKind, KnowledgeSyncInput } from '../types/knowledge.js'
import type { KnowledgeCheckedSearch } from '../types/search.js'

/** 入参不合法：说清是哪个字段、要什么。 */
function invalid(message: string): AppError {
  return new AppError('VALIDATION', message)
}

/** 入参本身得是个对象。 */
function objectOf(input: unknown, operation: string): Record<string, unknown> {
  if (!isPlainObject(input)) throw invalid(`${operation} 要一个对象作入参，这里给的是 ${JSON.stringify(input)}`)
  return input
}

/** 可选的工作区：给了就得是非空文字。 */
function workspaceOf(value: unknown): Optional<string> {
  if (isUndefined(value)) return undefined
  if (!isNonBlankString(value)) throw invalid(`workspaceRoot 要一个目录路径，这里给的是 ${JSON.stringify(value)}`)
  return value
}

/** 可选的文字列表：每项非空，最多 max 条。 */
function textListOf(value: unknown, field: string, max: number): Optional<string[]> {
  if (isUndefined(value)) return undefined
  if (!isArray(value) || !value.every(isNonBlankString)) throw invalid(`${field} 要一组非空文字，这里给的是 ${JSON.stringify(value)}`)
  if (value.length > max) throw invalid(`${field} 最多 ${max} 条，这里给了 ${value.length} 条`)
  return [...value]
}

/** 可选的来源类型：只认常量表里那几种。 */
function sourceKindsOf(value: unknown): Optional<KnowledgeSourceKind[]> {
  if (isUndefined(value)) return undefined
  const known: readonly string[] = KnowledgeSourceKinds
  if (!isArray(value) || !value.every((kind) => isNonBlankString(kind) && known.includes(kind))) {
    throw invalid(`sourceKinds 只收 ${KnowledgeSourceKinds.join('、')}，这里给的是 ${JSON.stringify(value)}`)
  }
  return [...value] as KnowledgeSourceKind[]
}

/** 要几条命中：没给用缺省，给了得是 1 到上限的整数。 */
function limitOf(value: unknown): number {
  if (isUndefined(value)) return KnowledgeSearchLimits.defaultResults
  if (!isNumber(value) || !Number.isInteger(value) || value < 1 || value > KnowledgeSearchLimits.results) {
    throw invalid(`limit 要 1–${KnowledgeSearchLimits.results} 之间的整数，这里给的是 ${JSON.stringify(value)}`)
  }
  return value
}

/** 检索：query 非空；其余按各自的规矩核对，没给的不出现。 */
export function searchInput(input: unknown): KnowledgeCheckedSearch {
  const value = objectOf(input, 'search')
  if (!isNonBlankString(value.query)) throw invalid(`query 要一句非空的检索语句，这里给的是 ${JSON.stringify(value.query)}`)
  const checked: KnowledgeCheckedSearch = { query: value.query.trim(), workspaceRoot: workspaceOf(value.workspaceRoot), limit: limitOf(value.limit) }
  const sourceKinds = sourceKindsOf(value.sourceKinds)
  if (sourceKinds) checked.sourceKinds = sourceKinds
  const pathHints = textListOf(value.pathHints, 'pathHints', KnowledgeSearchLimits.pathHints)
  if (pathHints) checked.pathHints = pathHints
  const symbolHints = textListOf(value.symbolHints, 'symbolHints', KnowledgeSearchLimits.symbolHints)
  if (symbolHints) checked.symbolHints = symbolHints
  const documentIds = textListOf(value.documentIds, 'documentIds', KnowledgeSearchLimits.documentIds)
  if (documentIds) checked.documentIds = documentIds
  return checked
}

/** 同步：两项都可以不给；程序绕过类型检查什么都没传也当空对象，给了就核对工作区与 force。 */
export function syncInput(input: unknown): KnowledgeSyncInput {
  if (isUndefined(input)) return {}
  const value = objectOf(input, 'sync')
  const checked: KnowledgeSyncInput = {}
  const workspaceRoot = workspaceOf(value.workspaceRoot)
  if (workspaceRoot) checked.workspaceRoot = workspaceRoot
  if (!isUndefined(value.force)) {
    if (!isBoolean(value.force)) throw invalid(`force 要 true 或 false，这里给的是 ${JSON.stringify(value.force)}`)
    checked.force = value.force
  }
  return checked
}
