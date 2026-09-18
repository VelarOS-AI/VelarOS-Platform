/**
 * 源码窗口：把读取结果排成 [行号, 原文] 的行与带列范围的片段，按实际交给程序的范围签发 fileRef 与续读引用，最后写成模型面的 `ProjectWindow`。
 * 分两步：先出候选窗口（记着源码快照），交出去之前再按窗口里真有的行核对一遍、签发 fileRef——同一份源码的几个窗口共用可见范围的并集。
 * 引用签发不了时源码照常作为只读内容给出，只是不带编辑权。
 */

import { isArray, isEmpty, isNumber, isPlainObject, isString, isTrue, isUndefined, Log, numberOrNull, optionalWhen, toOptional } from '@velaros-ai/core'

import { ProjectPolicyDefaults } from '../../contract/constants.js'
import type { ProjectOperationContext } from '../../contract/requires.js'
import type { AgentProjectReadResult } from '../../types/agent-port.js'
import type { ProjectVisibleCoverage } from '../../types/file-refs.js'
import type { ProjectFragment, ProjectWindow } from '../../types/files.js'
import type { ProjectSourceLine, ProjectSourceWindow } from '../../types/source-window.js'
import { assertWellFormedProjectText } from '../text.js'
import { ProjectTuning } from '../tuning.js'

import { loadFileView, resolveFileSource, saveFileRef, saveFileSource, saveReadPage } from './file-refs.js'

const log = Log.tag('FileSourceWindow')

/** 把正文切成物理行：偏移按原文算，显示的行文本去掉换行符（CRLF 的 \r 也去掉）。 */
export function projectSourceLines(content: string): ProjectSourceLine[] {
  const lines: ProjectSourceLine[] = []
  let start = 0
  for (let offset = 0; offset <= content.length; offset++) {
    if (offset < content.length && content[offset] !== '\n') continue
    const bodyEnd = offset > start && content[offset - 1] === '\r' && content[offset] === '\n' ? offset - 1 : offset
    lines.push({ line: lines.length + 1, start, bodyEnd, end: offset < content.length ? offset + 1 : offset, text: content.slice(start, bodyEnd) })
    start = offset + 1
  }
  return lines
}

/**
 * 把一次读取排成候选窗口：能拿到完整原文时按原文定位每一行（整行进 lines、半行进 fragments）并落一份源码快照；
 * 拿不到（脱敏过、太大、读的时候文件变了）就只给只读窗口。编辑引用要等 `finalizeFileWindows` 按实际交出去的行签发。
 */
export async function presentFileRead(
  ctx: ProjectOperationContext,
  file: AgentProjectReadResult,
  requestedRange?: { startLine?: number; startColumn?: number },
  sourceRef?: string
): Promise<ProjectSourceWindow> {
  const { content = '', ...metadata } = file
  const result: ProjectSourceWindow = {
    ...metadata, kind: 'project-source-window', path: file.snapshot.path,
    revision: file.snapshot.revision, lines: [],
  }
  if (file.snapshot.isDirectory || file.snapshot.isBinary || !file.snapshot.exists) return result
  const startLine = file.range?.startLine ?? requestedRange?.startLine ?? 1
  const startColumn = file.range?.startColumn ?? requestedRange?.startColumn ?? 1
  if (!isUndefined(file.totalLines) && startLine > Math.max(1, file.totalLines)) return result
  let original: Optional<string>
  let beyondEditableSize = false
  if (sourceRef) {
    try {
      original = resolveFileSource(ctx, sourceRef).content
    } catch (error) {
      log.debug('原来的源码快照不可用，改读当前授权的源码', { error: String(error) })
    }
  }
  if (isUndefined(original) && !file.redacted && file.snapshot.revision) {
    try {
      const kernel = await ctx.project.kernel()
      const full = await kernel.read({ path: file.snapshot.path, baseRevision: file.snapshot.revision, maxChars: ProjectTuning.agent.fullReadChars })
      if (!full.redacted && !full.truncated && !full.hasMore && isString(full.content)) {
        // 读得全不等于改得了：补丁策略要的是带完整正文的快照，快照正文受 policy.maxFileSizeToReadBytes 约束。
        // 两边上限对齐，超限的文件只给只读窗口并说明，不签发一个用起来必然 NOT_SUPPORTED 的编辑引用。
        if (Buffer.byteLength(full.content, 'utf8') > ProjectPolicyDefaults.maxFileSizeToReadBytes) beyondEditableSize = true
        else original = full.content
      }
    } catch (error) {
      // 再读一次时文件变了或被拒：已经读到的照样给，只是不授予编辑范围。
      log.debug('整份原文读不到，窗口只读', { error: String(error) })
    }
  }
  const fullLines = isUndefined(original) ? undefined : projectSourceLines(original)
  const start = fullLines?.[startLine - 1]
  if (fullLines && start && original?.slice(start.start + startColumn - 1, start.start + startColumn - 1 + content.length) === content) {
    const from = start.start + startColumn - 1
    const to = from + content.length
    for (const line of fullLines) {
      if (line.line < startLine || line.start > to) continue
      // 整读的正文带着行尾换行，止于换行符时下一行的正文还没显示；按范围读的正文不带末行的换行符，
      // 以换行结尾是因为最后那行是空行，它已经交出去了。
      if (!file.range && line.start === to && content.endsWith('\n') && to < original.length) continue
      if (line.bodyEnd < from) continue
      if (from <= line.start && to >= line.bodyEnd) result.lines.push([line.line, line.text])
      else {
        const a = Math.max(from, line.start)
        const b = Math.min(to, line.bodyEnd)
        if (b > a) (result.fragments ??= []).push({ line: line.line, columns: [a - line.start + 1, b - line.start + 1], text: original.slice(a, b) })
      }
    }
    result.viewSource = saveFileSource(ctx, { path: file.snapshot.path, revision: file.snapshot.revision!, content: original })
    countLikeWc(result, fullLines)
  } else {
    // 只读降级也用于脱敏过的内容；末行的边界保守处理，免得扩大编辑范围。
    const parts = content.split('\n')
    for (const [index, raw] of parts.entries()) {
      const line = startLine + index
      const complete = (index > 0 || startColumn === 1) && (index < parts.length - 1 || !file.hasMore)
      if (complete) result.lines.push([line, raw.endsWith('\r') ? raw.slice(0, -1) : raw])
      else if (raw) (result.fragments ??= []).push({ line, columns: [index ? 1 : startColumn, (index ? 1 : startColumn) + raw.length], text: raw })
    }
    result.editable = false
    if (beyondEditableSize) {
      result.referenceUnavailable = `文件超过可编辑的上限（${Math.floor(ProjectPolicyDefaults.maxFileSizeToReadBytes / 1024 / 1024)} MiB），只给只读窗口：用命令处理它，或者先把文件拆小。`
    }
  }
  return result
}

/**
 * 行数照 `wc -l` 数：结尾换行之后那个零宽的行不算一行（空文件是 0 行）。它在内核里照样有行号：
 * 窗口交出了最后一行真实的行（或者文件是空的）时，把它记进可见范围——程序凭这个 fileRef 在文件末尾插入要它——
 * 同时标成 trailingLine，交给模型之前去掉；这时文件已经读到头，续读也就没有了。
 */
function countLikeWc(result: ProjectSourceWindow, fullLines: readonly ProjectSourceLine[]): void {
  const last = fullLines.at(-1)
  // 最后一段长度为零：它就是结尾换行之后那个行（空文件里是唯一的那一行）；没有结尾换行的文件，最后一段是真实的一行。
  if (!last || last.start !== last.end) return
  result.totalLines = fullLines.length - 1
  const lastReal = fullLines.at(-2)
  const shown = new Set(result.lines.map(([line]) => line))
  if (lastReal && !shown.has(lastReal.line)) return
  if (!shown.has(last.line)) result.lines.push([last.line, ''])
  result.trailingLine = last.line
  result.hasMore = false
  delete result.continuation
}

/** 是不是普通对象（可以当键值表读）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value)
}

/** 签发不了引用时去掉续读位置，改成一句怎么重读。 */
function withoutUnsignedContinuation(result: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(result.continuation)) return result
  const range = optionalWhen(isPlainObject, result.continuation.range)
  delete result.continuation
  const startLine = Number(range?.startLine)
  result.continuationUnavailable = Number.isSafeInteger(startLine) && startLine > 0
    ? `续读引用签发不了：从第 ${startLine} 行起重新 read 这个文件。`
    : '续读引用签发不了：重新 read 这个文件。'
  return result
}

/** 按窗口里真有的行与片段算出可见范围：行文本对不上原文的（脱敏、截断）一律不算。 */
function visibleCoverage(sourceContent: string, window: Record<string, unknown>): ProjectVisibleCoverage[] {
  const sourceLines = projectSourceLines(sourceContent)
  const coverage: ProjectVisibleCoverage[] = []
  for (const record of isArray(window.lines) ? window.lines : []) {
    if (!isArray(record) || record.length !== 2 || !Number.isInteger(record[0]) || !isString(record[1])) continue
    const line = sourceLines[Number(record[0]) - 1]
    if (!line || line.text !== record[1]) continue
    coverage.push({ startOffset: line.start, endOffset: line.end, startLine: line.line, endLine: line.line, completeLines: true })
  }
  for (const fragment of isArray(window.fragments) ? window.fragments : []) {
    if (!isRecord(fragment) || !Number.isInteger(fragment.line) || !isArray(fragment.columns) || fragment.columns.length !== 2 || !isString(fragment.text)) continue
    const line = sourceLines[Number(fragment.line) - 1]
    const [a, b] = fragment.columns
    if (!line || !isNumber(a) || !isNumber(b) || !Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b <= a || b > line.text.length + 1 || line.text.slice(a - 1, b - 1) !== fragment.text) continue
    assertWellFormedProjectText(fragment.text)
    coverage.push({ startOffset: line.start + a - 1, endOffset: line.start + b - 1, startLine: line.line, endLine: line.line, completeLines: false })
  }
  coverage.sort((a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset)
  const merged: ProjectVisibleCoverage[] = []
  for (const region of coverage) {
    const last = merged.at(-1)
    if (last?.completeLines && region.completeLines && last.endOffset === region.startOffset && last.endLine + 1 === region.startLine) {
      last.endOffset = region.endOffset
      last.endLine = region.endLine
    } else merged.push({ ...region })
  }
  return merged
}

/** 给一个候选窗口签发 fileRef 与续读引用：源码快照对不上窗口（路径、版本）或窗口被遮住时不签，只读给出。 */
function signWindow(ctx: ProjectOperationContext, value: Record<string, unknown>): Record<string, unknown> {
  const result = { ...value }
  const ref = optionalWhen(isString, result.viewSource)
  delete result.viewSource
  if (!ref || result.redacted) return withoutUnsignedContinuation(result)
  try {
    const source = resolveFileSource(ctx, ref)
    if (source.path !== result.path || source.revision !== result.revision) return withoutUnsignedContinuation(result)
    const coverage = visibleCoverage(source.content, result)
    if (!isEmpty(coverage)) result.fileRef = saveFileRef(ctx, ref, coverage)
    if (isRecord(result.continuation) && isRecord(result.continuation.range)) {
      const range = result.continuation.range
      if (isNumber(range.startLine)) {
        result.continuation = saveReadPage(ctx, ref, {
          startLine: range.startLine,
          startColumn: toOptional(numberOrNull(range.startColumn)),
          endLine: toOptional(numberOrNull(range.endLine)),
          endColumn: toOptional(numberOrNull(range.endColumn)),
        })
      }
    }
  } catch (error) {
    // 会话的引用被挤掉、正文不合法这类情况：不给编辑权，源码仍作为只读内容给出。
    log.debug('签发编辑引用失败，窗口只读', { error: String(error) })
  }
  return withoutUnsignedContinuation(result)
}

/** 合并同一份源码的可见范围：整行范围相交或相邻就并起来，已被整行范围盖住的片段丢掉，其余片段按行合并，结果按偏移排序。 */
function mergeCoverage(input: ProjectVisibleCoverage[]): ProjectVisibleCoverage[] {
  const full: ProjectVisibleCoverage[] = []
  for (const region of input.filter((item) => item.completeLines).sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset)) {
    const last = full.at(-1)
    if (last && region.startOffset <= last.endOffset && region.startLine <= last.endLine + 1) {
      last.endOffset = Math.max(last.endOffset, region.endOffset)
      last.endLine = Math.max(last.endLine, region.endLine)
    } else full.push({ ...region })
  }
  const fragments: ProjectVisibleCoverage[] = []
  for (const region of input.filter((item) => !item.completeLines).sort((a, b) => a.startOffset - b.startOffset)) {
    if (full.some((item) => item.startOffset <= region.startOffset && item.endOffset >= region.endOffset)) continue
    const last = fragments.at(-1)
    if (last && last.startLine === region.startLine && region.startOffset <= last.endOffset) last.endOffset = Math.max(last.endOffset, region.endOffset)
    else fragments.push({ ...region })
  }
  return [...full, ...fragments].sort((a, b) => a.startOffset - b.startOffset)
}

/**
 * 交出去之前的最后一步：给每个候选窗口按它真有的行签发 fileRef；同一份源码的几个窗口（包括不相连的）改签成一个，
 * 覆盖它们可见范围的并集——程序拿其中任何一个都能改所有这些行。
 */
export async function finalizeFileWindows(ctx: ProjectOperationContext, windows: readonly ProjectSourceWindow[]): Promise<Array<Record<string, unknown>>> {
  const signed = windows.map((window) => signWindow(ctx, window))
  const groups = new Map<string, { source: string; coverage: ProjectVisibleCoverage[]; windows: Array<Record<string, unknown>> }>()
  for (const window of signed) {
    if (!isString(window.fileRef)) continue
    try {
      const view = await loadFileView(ctx, window.fileRef)
      const key = JSON.stringify([view.path, view.revision, view.contentRevision])
      const group = groups.get(key) ?? { source: window.fileRef, coverage: [], windows: [] }
      group.coverage.push(...view.coverage)
      group.windows.push(window)
      groups.set(key, group)
    } catch (error) {
      log.debug('窗口的引用复核失败，保留它自己那份', { error: String(error) })
    }
  }
  for (const group of groups.values()) {
    if (group.windows.length < 2) continue
    const ref = saveFileRef(ctx, group.source, mergeCoverage(group.coverage))
    for (const window of group.windows) window.fileRef = ref
  }
  return signed
}

/** 把签好的窗口写成模型面的 `ProjectWindow`：只留声明里的字段。 */
export function toProjectWindow(window: Record<string, unknown>): ProjectWindow {
  const lines = isArray(window.lines) ? window.lines as Array<[number, string]> : []
  const shaped: ProjectWindow = {
    path: String(window.path),
    // 结尾换行之后那个零宽的行只进可见范围，不给模型看（模型面照 wc -l 数行）。
    lines: isNumber(window.trailingLine) ? lines.filter(([line, text]) => line !== window.trailingLine || !isEmpty(text)) : lines,
  }
  if (isString(window.revision)) shaped.revision = window.revision
  if (isString(window.fileRef)) shaped.fileRef = window.fileRef
  if (isNumber(window.totalLines)) shaped.totalLines = window.totalLines
  if (isArray(window.fragments) && !isEmpty(window.fragments)) shaped.fragments = window.fragments as ProjectFragment[]
  if (isTrue(window.hasMore)) shaped.hasMore = true
  if (isString(window.continuation)) shaped.continuation = window.continuation
  if (isTrue(window.redacted)) shaped.redacted = true
  if (!isString(window.fileRef)) shaped.editable = false
  const notes = [window.referenceUnavailable, window.continuationUnavailable, window.note].filter(isString)
  if (!isString(window.fileRef) && isEmpty(notes)) notes.push(isTrue(window.redacted) ? '有内容被遮住了，这段只能看、不能改。' : '这段只能看、不能改：重新 read 拿可编辑的窗口。')
  if (!isEmpty(notes)) shaped.note = notes.join(' ')
  return shaped
}
