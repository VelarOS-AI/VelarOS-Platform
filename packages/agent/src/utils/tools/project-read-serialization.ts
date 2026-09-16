import { isArray, isEmpty, isNumber, isPlainObject, isString } from '@velaros-ai/core'

import type { Fragment,Line, RecordValue } from '../../types/tools.js'

/**
 * 该值是否是新式源码窗口记录——纯对象且 `kind === 'project-source-window'`。
 * 只认这一个判别字段，不看里面有没有 lines/fragments（空窗口也算窗口）。
 */
function isWindow(value: unknown): boolean {
  return isPlainObject(value) && value.kind === 'project-source-window'
}

/** 历史源码仍可读取，模型统一接收行号与正文分离的行记录。 */
function legacyWindow(value: RecordValue): RecordValue {
  const content = (value.contentFormat === 'line-numbered'
    ? String(value.content).split('\n').map((line) => line.replace(/^\d+\|/u, '')).join('\n')
    : value.content) as string
  const snapshot = value.snapshot as RecordValue
  const range = isPlainObject(value.range) ? value.range : {}
  const first = isNumber(range.startLine) ? range.startLine : 1
  const column = isNumber(range.startColumn) ? range.startColumn : 1
  const continuation = isPlainObject(value.continuation) && isPlainObject(value.continuation.range) ? value.continuation.range : {}
  const result: RecordValue = { ...value, kind: 'project-source-window', path: snapshot.path, revision: snapshot.revision, lines: [] }
  delete result.content
  delete result.contentFormat
  // 旧选择引用没有最终可见范围约束，不能自动升级为新的视图引用。
  delete result.editTarget
  const lines = result.lines as Line[]
  const fragments: Fragment[] = []
  const parts = content.split('\n')
  for (const [index, raw] of parts.entries()) {
    if (index === parts.length - 1 && isEmpty(raw) && value.hasMore && content.endsWith('\n')) continue
    const line = first + index
    const complete = (index !== 0 || column === 1) && (index < parts.length - 1 || !value.hasMore || (isNumber(continuation.startLine) && continuation.startLine > line))
    if (complete) lines.push([line, raw.endsWith('\r') ? raw.slice(0, -1) : raw])
    else if (raw) fragments.push({ line, columns: [index ? 1 : column, (index ? 1 : column) + raw.length], text: raw })
  }
  if (!isEmpty(fragments)) result.fragments = fragments
  return result
}

/**
 * 内核给的行号元数据描述裁剪前的窗口；裁剪后按实际显示的末尾重算（口径同内核读取），
 * 与 continuation 指向同一续读点。只更新窗口里原本就有的字段。
 */
function withReadCursor(value: RecordValue, line: number, column: number): RecordValue {
  const result: RecordValue = { ...value }
  if (isPlainObject(value.range)) {
    const range: RecordValue = { ...value.range, endLine: column > 1 ? line : line - 1 }
    if (column > 1) range.endColumn = column
    else delete range.endColumn
    result.range = range
  }
  if (Object.hasOwn(value, 'nextStartLine')) {
    if (column === 1) result.nextStartLine = line
    else delete result.nextStartLine
  }
  if (Object.hasOwn(value, 'remainingLines') && isNumber(value.totalLines))
    result.remainingLines = Math.max(0, value.totalLines - line + (column > 1 ? 1 : 0))
  return result
}

/**
 * 把一个被裁短的源码窗口标成「还有下文」：置 `truncated`/`hasMore` 为真，按实际显示末尾重算读取游标，
 * 并写出指向 `line`/`column` 的 `continuation`（沿用原 continuation 的其余 range 字段，并把当前 revision 记进 baseRevisions）。
 * 有了这段，模型续读拿到的是同一版本的下一段，而不是对着改动过的文件接着读。
 */
function nextPage(value: RecordValue, line: number, column = 1): RecordValue {
  const prior = isPlainObject(value.continuation) ? value.continuation : {}
  const priorRange = isPlainObject(prior.range) ? prior.range : {}
  return {
    ...withReadCursor(value, line, column), truncated: true, hasMore: true,
    continuation: {
      path: value.path,
      range: { ...priorRange, startLine: line, startColumn: column },
      baseRevisions: { [String(value.path)]: value.revision },
    },
  }
}

/**
 * 取一行正文的前 units 个 UTF-16 码元，但刀口落在代理对中间、或正好把 `\r\n` 劈开时回退一位。
 * 单行长到一整行都放不下时才用它切片段；少切一个码元换「片段是合法文本、列范围不错位」。
 */
function safePrefix(text: string, units: number): string {
  let end = Math.min(text.length, units)
  const last = text.charCodeAt(end - 1)
  if ((last >= 0xd800 && last <= 0xdbff) || (text[end - 1] === '\r' && text[end] === '\n')) end--
  return text.slice(0, Math.max(0, end))
}

/** 优先保留完整行记录，过长行只能显示为明确的列范围片段。 */
function fitWindow(value: RecordValue, maximum: number): RecordValue {
  const lines = (isArray(value.lines) ? value.lines : []).filter((line): line is Line => isArray(line) && line.length === 2 && isNumber(line[0]) && isString(line[1]))
  const fragments = (isArray(value.fragments) ? value.fragments : []).filter((item): item is Fragment => isPlainObject(item) && isNumber(item.line) && isArray(item.columns) && isString(item.text))
  const records = [
    ...lines.map(([line, text]) => ({ line, column: 1, text, full: true })),
    ...fragments.map((fragment) => ({ line: fragment.line, column: fragment.columns[0], text: fragment.text, full: false })),
  ].sort((a, b) => a.line - b.line || a.column - b.column)
  const result: RecordValue = { ...value, lines: [...lines] }
  if (!isEmpty(fragments)) result.fragments = [...fragments]
  if (JSON.stringify(result).length <= maximum) return result
  let count = records.length
  const build = (take: number): RecordValue => {
    const selected = records.slice(0, take)
    const next = records[take]
    let candidate: RecordValue = {
      ...value,
      lines: selected.filter((item) => item.full).map((item) => [item.line, item.text]),
      fragments: selected.filter((item) => !item.full).map((item) => ({ line: item.line, columns: [item.column, item.column + item.text.length], text: item.text })),
    }
    if (next) candidate = nextPage(candidate, next.line, next.column)
    return candidate
  }
  // 二分搜索避免大量短行产生平方级序列化成本。
  let low = 0
  let high = records.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (JSON.stringify(build(middle)).length <= maximum) low = middle
    else high = middle - 1
  }
  count = low
  if (count > 0 || isEmpty(records)) return build(count)
  const first = records[0]!
  const partial = (units: number) => {
    const text = safePrefix(first.text, units)
    return nextPage({ ...value, lines: [], fragments: text ? [{ line: first.line, columns: [first.column, first.column + text.length], text }] : [] }, first.line, first.column + text.length)
  }
  low = 0
  high = first.text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (JSON.stringify(partial(middle)).length <= maximum) low = middle
    else high = middle - 1
  }
  return partial(low)
}

/**
 * 结果里（任意层级的数组/对象中）是否出现过源码窗口记录。
 * 为真时序列化链路要走保行号的专用路径，而不是通用的字符串截断与数组裁剪——后者会改动源码原文、留下对不上的续读位置。
 * 注意只认新式 `kind: 'project-source-window'`，尚未升级的旧式窗口在这里不算（它们要先过 fitProjectReadsForModel 的归一化）。
 */
export function hasProjectSourceWindows(value: unknown): boolean {
  if (isWindow(value)) return true
  if (isArray(value)) return value.some(hasProjectSourceWindows)
  return isPlainObject(value) && Object.values(value).some(hasProjectSourceWindows)
}

/**
 * 把一份含源码读取结果的返回值整体收进 `maximum` 字符预算：先递归归一化（旧式 `content + snapshot` 窗口升级成行记录窗口），
 * 没有任何窗口就原样返回归一化结果。
 * 有窗口时先量出「把所有窗口挖空后」的元数据体积，再把剩余预算按窗口数均分（每个至少 256 字符），逐个交给 fitWindow 按整行裁。
 * 裁掉的行不是丢失：每个被裁的窗口都带 continuation 指向确切的续读行列与文件 revision，模型照它接着读就行。
 */
export function fitProjectReadsForModel(result: unknown, maximum: number): unknown {
  const windows: RecordValue[] = []
  const normalize = (value: unknown): unknown => {
    if (isArray(value)) return value.map(normalize)
    if (!isPlainObject(value)) return value
    const window = isWindow(value) ? value : isString(value.content) && isPlainObject(value.snapshot) && isString(value.snapshot.path) && isString(value.snapshot.revision) ? legacyWindow(value) : undefined
    if (window) { windows.push(window); return window }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]))
  }
  const normalized = normalize(result)
  if (isEmpty(windows)) return normalized
  const set = new Set(windows)
  const metadata = JSON.stringify(normalized, (_key, value) => set.has(value) ? null : value).length
  const perWindow = Math.max(256, Math.floor((maximum - metadata) / windows.length))
  const replace = (value: unknown): unknown => {
    if (isPlainObject(value) && isWindow(value)) return fitWindow(value, perWindow)
    if (isArray(value)) return value.map(replace)
    if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]))
    return value
  }
  return replace(normalized)
}
