/**
 * `velar:project` 的入参核对：模型的程序在写的时候已经过了类型检查，这里拦的是类型挡不住的——
 * 数值范围、互斥的字段、空字符串，以及绕过检查塞进来的错形状。不合法就当场以 INVALID_INPUT 拒绝，一步都不做。
 */

import { isArray, isBoolean, isEmpty, isNumber, isPlainObject, isString, isUndefined } from '@velaros-ai/core'

import { ProjectFileLimits } from '../../contract/constants.js'
import type { ListQuery } from '../../types/agent.js'
import type {
  ProjectChangeInput,
  ProjectEditInput,
  ProjectEditStep,
  ProjectLineRange,
  ProjectReadItem,
  ProjectSearchInput,
} from '../../types/files.js'
import { ProjectError } from '../errors.js'

/** 入参不合法：说清是哪个字段、要什么。 */
function invalid(message: string): ProjectError {
  return new ProjectError('INVALID_INPUT', message)
}

/** 入参本身得是个对象。 */
function objectOf(input: unknown, operation: string): Record<string, unknown> {
  if (!isPlainObject(input)) throw invalid(`${operation} 要一个对象作入参，这里给的是 ${JSON.stringify(input)}`)
  return input
}

/** 非空字符串。 */
function text(value: unknown, field: string): string {
  if (!isString(value) || isEmpty(value.trim())) throw invalid(`${field} 要一个非空字符串，这里给的是 ${JSON.stringify(value)}`)
  return value
}

/** 在 [min, max] 之内的整数；没给时用缺省值（缺省值为 undefined 时照样返回 undefined）。 */
function integer<T extends Optional<number>>(value: unknown, field: string, min: number, max: number, fallback: T): number | T {
  if (isUndefined(value)) return fallback
  if (!isNumber(value) || !Number.isInteger(value) || value < min || value > max) throw invalid(`${field} 要 ${min}–${max} 之间的整数，这里给的是 ${JSON.stringify(value)}`)
  return value
}

/** 可选的布尔值。 */
function flag(value: unknown, field: string): Optional<boolean> {
  if (isUndefined(value) || isBoolean(value)) return value
  throw invalid(`${field} 要 true 或 false，这里给的是 ${JSON.stringify(value)}`)
}

/** glob 列表：非空字符串，最多 ProjectFileLimits.patterns 条。 */
function patterns(value: unknown, field: string): Optional<string[]> {
  if (isUndefined(value)) return undefined
  if (!isArray(value) || value.length > ProjectFileLimits.patterns) throw invalid(`${field} 要最多 ${ProjectFileLimits.patterns} 条 glob 的数组`)
  return value.map((pattern, index) => text(pattern, `${field}[${index}]`))
}

/** 行号或闭区间：51、[51]、[42, 45]，末行不小于首行。 */
export function lineRange(value: unknown, field: string): Optional<ProjectLineRange> {
  if (isUndefined(value)) return undefined
  const line = (item: unknown) => isNumber(item) && Number.isSafeInteger(item) && item > 0
  if (line(value)) return value as number
  if (isArray(value) && value.length === 1 && line(value[0])) return [value[0] as number]
  if (isArray(value) && value.length === 2 && line(value[0]) && line(value[1]) && (value[1] as number) >= (value[0] as number)) return [value[0] as number, value[1] as number]
  throw invalid(`${field} 要行号或 [首行, 末行]（从 1 起，末行不小于首行），这里给的是 ${JSON.stringify(value)}`)
}

/** read 的入参：files 与 continuation 只给一个，maxChars 至少给每个文件分到一个字符。 */
export function readInput(input: unknown): { files?: ProjectReadItem[]; continuation?: string; maxChars?: number } {
  const value = objectOf(input, 'read')
  const hasFiles = !isUndefined(value.files)
  const hasContinuation = !isUndefined(value.continuation)
  if (hasFiles === hasContinuation) throw invalid('read 的 files 与 continuation 只给一个：读新文件给 files，接着上次读给 continuation')
  const maxChars = integer(value.maxChars, 'maxChars', 1, ProjectFileLimits.readChars, undefined)
  if (hasContinuation) {
    const continuation = text(value.continuation, 'continuation')
    if (!continuation.startsWith('read-page:')) throw invalid('continuation 要原样用上次窗口里的 continuation（read-page:…）')
    return { continuation, maxChars }
  }
  if (!isArray(value.files) || isEmpty(value.files) || value.files.length > ProjectFileLimits.readFiles) throw invalid(`files 要 1–${ProjectFileLimits.readFiles} 项的数组`)
  const files = value.files.map((item, index) => {
    const file = objectOf(item, `files[${index}]`)
    const read: ProjectReadItem = { path: text(file.path, `files[${index}].path`) }
    const range = lineRange(file.range, `files[${index}].range`)
    if (!isUndefined(range)) read.range = range
    return read
  })
  if (!isUndefined(maxChars) && maxChars < files.length) throw invalid(`读 ${files.length} 个文件时 maxChars 至少是 ${files.length}（每个文件至少分到一个字符）`)
  return { files, maxChars }
}

/** list 的入参：续页只传 cursor 与可选的 limit。 */
export function listInput(input: unknown): ListQuery {
  const value = objectOf(input ?? {}, 'list')
  const limit = integer(value.limit, 'limit', 1, ProjectFileLimits.listPage, ProjectFileLimits.listPageDefault)
  if (!isUndefined(value.cursor)) {
    if (!isUndefined(value.path) || !isUndefined(value.include) || !isUndefined(value.exclude) || !isUndefined(value.depth)) {
      throw invalid('续页只传 cursor 和可选的 limit；要换条件就去掉 cursor 重新列')
    }
    return { cursor: text(value.cursor, 'cursor'), limit }
  }
  const depth = value.depth === 'all' ? 'all' : integer(value.depth, 'depth', 1, ProjectFileLimits.listDepth, undefined)
  const listed: ListQuery = { limit }
  if (!isUndefined(value.path)) listed.path = text(value.path, 'path')
  const include = patterns(value.include, 'include')
  const exclude = patterns(value.exclude, 'exclude')
  if (include) listed.include = include
  if (exclude) listed.exclude = exclude
  if (!isUndefined(depth)) listed.depth = depth
  return listed
}

/** search 的入参。 */
export function searchInput(input: unknown): ProjectSearchInput {
  const value = objectOf(input, 'search')
  const search: ProjectSearchInput = { query: text(value.query, 'query') }
  if (!isUndefined(value.path)) search.path = text(value.path, 'path')
  const include = patterns(value.include, 'include')
  const exclude = patterns(value.exclude, 'exclude')
  if (include) search.include = include
  if (exclude) search.exclude = exclude
  const regex = flag(value.regex, 'regex')
  const caseSensitive = flag(value.caseSensitive, 'caseSensitive')
  if (!isUndefined(regex)) search.regex = regex
  if (!isUndefined(caseSensitive)) search.caseSensitive = caseSensitive
  const limit = integer(value.limit, 'limit', 1, ProjectFileLimits.searchHits, undefined)
  const contextLines = integer(value.contextLines, 'contextLines', 0, ProjectFileLimits.searchContextLines, undefined)
  if (!isUndefined(limit)) search.limit = limit
  if (!isUndefined(contextLines)) search.contextLines = contextLines
  return search
}

/** 一步里指文件的三种写法恰好给一种。 */
function oneSource(step: Record<string, unknown>, where: string): void {
  const given = ['fileRef', 'sourceRef', 'path'].filter((field) => !isUndefined(step[field]))
  if (given.length !== 1) throw invalid(`${where} 的 fileRef、sourceRef、path 恰好给一个，这里给了 ${isEmpty(given) ? '零个' : given.join('、')}`)
  text(step[given[0]!], `${where}.${given[0]}`)
}

/** 一步的形状：按 action 核对各自的字段；每处编辑的细节（op、range、match）由编辑规划核对。 */
function step(value: unknown, index: number): ProjectEditStep {
  const where = `steps[${index}]`
  const item = objectOf(value, where)
  switch (item.action) {
    case 'create':
      text(item.path, `${where}.path`)
      if (!isString(item.text)) throw invalid(`${where}.text 要新文件的完整正文（字符串）`)
      break
    case 'overwrite':
      oneSource(item, where)
      if (!isString(item.text)) throw invalid(`${where}.text 要替换后的完整正文（字符串）`)
      break
    case 'move':
      oneSource(item, where)
      text(item.to, `${where}.to`)
      break
    case 'delete':
      oneSource(item, where)
      break
    case 'recode':
      if (!isArray(item.paths) || isEmpty(item.paths) || item.paths.length > ProjectFileLimits.recodePaths) throw invalid(`${where}.paths 要 1–${ProjectFileLimits.recodePaths} 个文件路径`)
      item.paths.forEach((path, at) => text(path, `${where}.paths[${at}]`))
      if (!isUndefined(item.encoding) && !['utf-8', 'utf-16le', 'utf-16be', 'gb18030'].includes(String(item.encoding))) throw invalid(`${where}.encoding 只收 utf-8、utf-16le、utf-16be、gb18030`)
      flag(item.bom, `${where}.bom`)
      if (!isUndefined(item.newline) && item.newline !== 'lf' && item.newline !== 'crlf') throw invalid(`${where}.newline 只收 lf 或 crlf`)
      break
    case 'edit':
      oneSource(item, where)
      if (!isArray(item.edits) || isEmpty(item.edits) || item.edits.length > ProjectFileLimits.editsPerFile) throw invalid(`${where}.edits 要 1–${ProjectFileLimits.editsPerFile} 处编辑`)
      item.edits.forEach((edit, at) => {
        const shaped = objectOf(edit, `${where}.edits[${at}]`)
        if (!isString(shaped.text)) throw invalid(`${where}.edits[${at}].text 要字符串（空串就是删掉）`)
        if (!isUndefined(shaped.range)) lineRange(shaped.range, `${where}.edits[${at}].range`)
      })
      break
    default:
      throw invalid(`${where}.action 只收 create、overwrite、move、delete、recode、edit，这里给的是 ${JSON.stringify(item.action)}`)
  }
  return item as ProjectEditStep
}

/** edit 的入参：1–ProjectFileLimits.steps 步。 */
export function editInput(input: unknown): ProjectEditInput {
  const value = objectOf(input, 'edit')
  if (!isArray(value.steps) || isEmpty(value.steps) || value.steps.length > ProjectFileLimits.steps) throw invalid(`steps 要 1–${ProjectFileLimits.steps} 步的数组`)
  return { steps: value.steps.map(step) }
}

/** inspect、undo 的入参：一个 changeRef。 */
export function changeInput(input: unknown): ProjectChangeInput {
  const value = objectOf(input, 'inspect / undo')
  return { changeRef: text(value.changeRef, 'changeRef') }
}
