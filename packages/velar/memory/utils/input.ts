/**
 * `velar:memory` 的入参核对：入参来自模型的程序，类型检查挡不住的在这里拦——类别认不认、标题与正文是不是非空文字、
 * 各字段的长度与条数、limit 的范围，以及绕过检查塞进来的错形状。不合法当场拒绝（`VALIDATION`），一步都不做。
 */

import { isArray, isBoolean, isNonBlankString, isNumber, isPlainObject, isString, isUndefined } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { MemoryEvidenceCategories, MemoryInputLimits } from '../contract/constants.js'
import type { MemoryKind, MemorySaveInput } from '../types/memory.js'
import type { MemoryCheckedSearch } from '../types/operations.js'

/** 入参不合法：说清是哪个字段、要什么。 */
function invalid(message: string): AppError {
  return new AppError('VALIDATION', message)
}

/** 入参本身得是个对象。 */
function objectOf(input: unknown, operation: string): Record<string, unknown> {
  if (!isPlainObject(input)) throw invalid(`${operation} 要一个对象作入参，这里给的是 ${JSON.stringify(input)}`)
  return input
}

/** 必填的非空文字，最多 max 个字符。 */
function requiredText(value: unknown, field: string, max: number): string {
  if (!isNonBlankString(value) || value.length > max) throw invalid(`${field} 要 1–${max} 个字符的非空文字，这里给的是 ${JSON.stringify(value)?.slice(0, 80)}`)
  return value
}

/** 可选的文字，最多 max 个字符。 */
function optionalText(value: unknown, field: string, max: number): Optional<string> {
  if (isUndefined(value)) return undefined
  if (!isString(value) || value.length > max) throw invalid(`${field} 要最多 ${max} 个字符的文字，这里给的是 ${JSON.stringify(value)?.slice(0, 80)}`)
  return value
}

/** 一个记忆类别：只认类别表里的。 */
function kindOf(value: unknown, field: string): MemoryKind {
  const known: readonly unknown[] = MemoryEvidenceCategories
  if (!known.includes(value)) throw invalid(`${field} 只收 ${MemoryEvidenceCategories.join('、')}，这里给的是 ${JSON.stringify(value)}`)
  return value as MemoryKind
}

/** 写一条：kind、title、content 必填；其余没给的不出现。 */
export function saveInput(input: unknown): MemorySaveInput {
  const value = objectOf(input, 'save')
  const checked: MemorySaveInput = {
    kind: kindOf(value.kind, 'kind'),
    title: requiredText(value.title, 'title', MemoryInputLimits.titleChars),
    content: requiredText(value.content, 'content', MemoryInputLimits.contentChars),
  }
  const summary = optionalText(value.summary, 'summary', MemoryInputLimits.summaryChars)
  if (!isUndefined(summary)) checked.summary = summary
  const source = optionalText(value.source, 'source', MemoryInputLimits.sourceChars)
  if (!isUndefined(source)) checked.source = source
  const taskKey = optionalText(value.taskKey, 'taskKey', MemoryInputLimits.taskKeyChars)
  if (!isUndefined(taskKey)) checked.taskKey = taskKey
  if (!isUndefined(value.tags)) {
    if (!isArray(value.tags) || value.tags.length > MemoryInputLimits.tagCount) {
      throw invalid(`tags 要最多 ${MemoryInputLimits.tagCount} 个标签，这里给的是 ${JSON.stringify(value.tags)?.slice(0, 80)}`)
    }
    checked.tags = value.tags.map((tag) => requiredText(tag, 'tags 里的标签', MemoryInputLimits.tagChars))
  }
  return checked
}

/** 召回：话题可以不给（看最近记了什么）；条数没给就按有没有话题取缺省。 */
export function searchInput(input: unknown): MemoryCheckedSearch {
  const value = objectOf(input, 'search')
  const query = (optionalText(value.query, 'query', MemoryInputLimits.queryChars) ?? '').trim()
  const deep = isUndefined(value.deep) ? false : value.deep
  if (!isBoolean(deep)) throw invalid(`deep 要 true 或 false，这里给的是 ${JSON.stringify(deep)}`)
  let limit: number = query ? MemoryInputLimits.searchDefaultResults : MemoryInputLimits.browseDefaultResults
  if (!isUndefined(value.limit)) {
    if (!isNumber(value.limit) || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > MemoryInputLimits.results) {
      throw invalid(`limit 要 1–${MemoryInputLimits.results} 之间的整数，这里给的是 ${JSON.stringify(value.limit)}`)
    }
    limit = value.limit
  }
  const request: MemoryCheckedSearch = { query, limit, deep }
  if (!isUndefined(value.categories)) {
    if (!isArray(value.categories)) throw invalid(`categories 要一组类别，这里给的是 ${JSON.stringify(value.categories)}`)
    request.categories = value.categories.map((kind) => kindOf(kind, 'categories 里的类别'))
  }
  return request
}

/** 读或归档一条：id 是非空文字。 */
export function idInput(input: unknown, operation: string): string {
  const value = objectOf(input, operation)
  if (!isNonBlankString(value.id)) throw invalid(`${operation} 要 search 交回的记忆 id，这里给的是 ${JSON.stringify(value.id)}`)
  return value.id
}
