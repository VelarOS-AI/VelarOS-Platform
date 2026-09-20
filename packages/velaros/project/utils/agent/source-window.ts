/**
 * 源码窗口：把读取结果排成 [行号, 原文] 的行，按实际交给程序的行签发 fileRef，最后写成模型面的 `ProjectWindow`。
 * 分两步：先出候选窗口（记着源码快照），交出去之前再按窗口里真有的行核对一遍、签发 fileRef——同一份源码的几个窗口共用可见范围的并集。
 * 读取总是整行的，窗口里没有半行。引用签发不了时源码照常作为只读内容给出，只是不带编辑权。
 */

import { isEmpty, isNumber, isString, isTrue, isUndefined, Log } from '@velaros-ai/core'

import { ProjectPolicyDefaults } from '../../contract/constants.js'
import type { ProjectOperationContext } from '../../contract/requires.js'
import type { LineSpan } from '../../types/agent.js'
import type { AgentProjectReadResult } from '../../types/agent-port.js'
import type { ProjectVisibleCoverage } from '../../types/file-refs.js'
import type { ProjectWindow } from '../../types/files.js'
import type { ProjectSourceLine, ProjectSourceWindow } from '../../types/source-window.js'
import { ProjectError } from '../errors.js'
import { ProjectTuning } from '../tuning.js'

import { loadFileView, resolveFileSource, saveFileRef, saveFileSource } from './file-refs.js'
import { readAgentFile } from './kernel-port.js'

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
 * 能拿来签发编辑引用的整份原文：读的就是整个文件时就是读到的正文，只读了一段时钉住同一个版本再整份读一次。
 * 读不全、读的时候文件变了就拿不到；超过可编辑的大小的也不给，另外说一声，好给只读窗口一句说明。
 */
async function editableOriginal(ctx: ProjectOperationContext, file: AgentProjectReadResult, content: string, wholeFile: boolean): Promise<{ original?: string; beyondEditableSize?: boolean }> {
  if (!file.snapshot.revision) return {}
  let full: Optional<string>
  if (wholeFile && !file.truncated) full = content
  else {
    try {
      const kernel = await ctx.project.kernel()
      const read = await kernel.read({ path: file.snapshot.path, baseRevision: file.snapshot.revision, maxChars: ProjectTuning.agent.fullReadChars })
      if (!read.truncated && !read.hasMore && isString(read.content)) full = read.content
    } catch (error) {
      // 再读一次时文件变了：已经读到的照样给，只是不授予编辑范围。
      log.debug('整份原文读不到，窗口只读', { error: String(error) })
    }
  }
  if (isUndefined(full)) return {}
  // 读得全不等于改得了：补丁策略要的是带完整正文的快照，快照正文受 policy.maxFileSizeToReadBytes 约束。
  // 两边上限对齐，超限的文件只给只读窗口并说明，不签发一个用起来必然 NOT_SUPPORTED 的编辑引用。
  if (Buffer.byteLength(full, 'utf8') > ProjectPolicyDefaults.maxFileSizeToReadBytes) return { beyondEditableSize: true }
  return { original: full }
}

/**
 * 只读窗口的行：照读到的正文按行切（CRLF 的 \r 去掉）。读到了文件末尾、正文以换行结尾时，最后那个空段是结尾换行之后的零宽行，
 * 和可编辑窗口一样照 `wc -l` 不算一行，总行数跟着改。
 */
function readOnlyLines(result: ProjectSourceWindow, content: string, startLine: number, kernelTotal: Optional<number>): void {
  const parts = content.split('\n')
  const lastLine = startLine + parts.length - 1
  if (isEmpty(parts.at(-1) ?? '') && isNumber(kernelTotal) && lastLine >= kernelTotal) {
    parts.pop()
    result.totalLines = lastLine - 1
  }
  for (const [index, raw] of parts.entries()) result.lines.push([startLine + index, raw.endsWith('\r') ? raw.slice(0, -1) : raw])
  result.editable = false
}

/** 照 `wc -l` 数行：结尾换行之后那个零宽的行（空文件里是唯一的那一行）不算。 */
function wcLineCount(fullLines: readonly ProjectSourceLine[]): number {
  const last = fullLines.at(-1)
  return last && last.start === last.end ? fullLines.length - 1 : fullLines.length
}

/**
 * 把一次读取排成候选窗口：拿得到可编辑的整份原文时按原文定位每一行、落一份源码快照（编辑引用等 `finalizeFileWindows` 按实际交出去的行签发）；
 * 拿不到（超过可编辑的大小、读的时候文件变了）就给只读窗口。requested 是请求的行范围，不给就是读了整个文件。
 * 交进来的读取要是读全了的：调用方先挡掉 truncated。
 */
export async function presentFileRead(ctx: ProjectOperationContext, file: AgentProjectReadResult, requested?: LineSpan): Promise<ProjectSourceWindow> {
  const content = file.content ?? ''
  const result: ProjectSourceWindow = { kind: 'project-source-window', path: file.snapshot.path, revision: file.snapshot.revision, lines: [] }
  if (isNumber(file.totalLines)) result.totalLines = file.totalLines
  if (isString(file.note)) result.note = file.note
  if (file.snapshot.isDirectory || file.snapshot.isBinary || !file.snapshot.exists) return result
  // 起始行在文件外时内核不回 range：起始行按请求的算。
  const startLine = file.range?.startLine ?? requested?.startLine ?? 1
  const { original, beyondEditableSize } = await editableOriginal(ctx, file, content, isUndefined(requested))
  const fullLines = isUndefined(original) ? undefined : projectSourceLines(original)
  if (isNumber(file.totalLines) && startLine > Math.max(1, file.totalLines)) {
    // 没有行可给，也不签编辑引用。内核按换行切来数行，拿得到原文时照 wc -l 重数，说明也照它写。
    if (fullLines) {
      const total = wcLineCount(fullLines)
      result.totalLines = total
      result.note = `文件共 ${total} 行，要的起始行 ${startLine} 超出范围，没有返回内容；要读末尾，起始行不要超过 ${Math.max(1, total)}。`
    }
    return result
  }
  const start = fullLines?.[startLine - 1]
  if (!isUndefined(original) && fullLines && start && original.slice(start.start, start.start + content.length) === content) {
    const end = start.start + content.length
    // 按范围读的正文不带末行的换行符，所以末行止于 end；以换行结尾是因为最后那行是空行，它也交出去了。
    for (const line of fullLines) {
      if (line.line >= startLine && line.start <= end && line.bodyEnd <= end) result.lines.push([line.line, line.text])
    }
    result.viewSource = saveFileSource(ctx, { path: file.snapshot.path, revision: file.snapshot.revision!, content: original })
    countLikeWc(result, fullLines)
  } else {
    readOnlyLines(result, content, startLine, file.totalLines)
    if (isTrue(beyondEditableSize)) {
      result.referenceUnavailable = `文件超过可编辑的上限（${Math.floor(ProjectPolicyDefaults.maxFileSizeToReadBytes / 1024 / 1024)} MiB），只给只读窗口：用命令处理它，或者先把文件拆小。`
    }
  }
  return result
}

/**
 * 行数照 `wc -l` 数：结尾换行之后那个零宽的行不算一行（空文件是 0 行）。它在内核里照样有行号：
 * 窗口交出了最后一行真实的行（或者文件是空的）时，把它记进可见范围——程序凭这个 fileRef 在文件末尾插入要它；
 * range 本身就读到了它（从最后一行的下一行起读）也一样。它标成 trailingLine，交给模型之前去掉。
 */
function countLikeWc(result: ProjectSourceWindow, fullLines: readonly ProjectSourceLine[]): void {
  const last = fullLines.at(-1)
  // 最后一段长度为零：它就是结尾换行之后那个行（空文件里是唯一的那一行）；没有结尾换行的文件，最后一段是真实的一行。
  if (!last || last.start !== last.end) return
  result.totalLines = wcLineCount(fullLines)
  const shown = new Set(result.lines.map(([line]) => line))
  if (!shown.has(last.line)) {
    const lastReal = fullLines.at(-2)
    if (lastReal && !shown.has(lastReal.line)) return
    result.lines.push([last.line, ''])
  }
  result.trailingLine = last.line
}

/**
 * 一个文件里几段行的窗口（search 的命中处、edit 回执的改动处）：钉住版本整份读一次，只留这几段里的行，签发的 fileRef 也只覆盖它们。
 * 文件在那个版本之后又被改了抛 BASE_REVISION_MISMATCH，大到整份读不全抛 SCOPE_VIOLATION：调用方决定跳过还是重来。
 */
export async function presentFileSpans(ctx: ProjectOperationContext, path: string, revision: string, spans: readonly LineSpan[]): Promise<ProjectSourceWindow> {
  const kernel = await ctx.project.kernel()
  const file = await readAgentFile(kernel, { path, baseRevision: revision, maxChars: ProjectTuning.agent.fullReadChars })
  if (isTrue(file.truncated)) throw new ProjectError('SCOPE_VIOLATION', `${path} 太大，整份读不全，给不了它的窗口。`, { path }, '用 read 带 range 读要看的那几行。')
  const window = await presentFileRead(ctx, file)
  const inside = (line: number) => spans.some((span) => span.startLine <= line && line <= span.endLine)
  // 结尾换行之后那个零宽的行跟着最后一行真实的行走：那一行在，它才进可见范围。空文件里它就是唯一的那一行。
  const trailing = window.trailingLine
  window.lines = window.lines.filter(([line]) => inside(line) || (line === trailing && inside(Math.max(1, line - 1))))
  if (isNumber(trailing) && !window.lines.some(([line]) => line === trailing)) delete window.trailingLine
  return window
}

/** 按窗口里真有的行算出可见范围：行文本对不上原文的不算，相邻的行并成一段。 */
function visibleCoverage(sourceContent: string, lines: ReadonlyArray<[number, string]>): ProjectVisibleCoverage[] {
  const sourceLines = projectSourceLines(sourceContent)
  const coverage: ProjectVisibleCoverage[] = []
  for (const [number, text] of [...lines].sort((a, b) => a[0] - b[0])) {
    const line = sourceLines[number - 1]
    if (!line || line.text !== text) continue
    const last = coverage.at(-1)
    if (last && last.endOffset === line.start && last.endLine + 1 === line.line) {
      last.endOffset = line.end
      last.endLine = line.line
    } else coverage.push({ startOffset: line.start, endOffset: line.end, startLine: line.line, endLine: line.line, completeLines: true })
  }
  return coverage
}

/** 给一个候选窗口签发 fileRef：源码快照对不上窗口（路径、版本）时不签，只读给出。 */
function signWindow(ctx: ProjectOperationContext, value: ProjectSourceWindow): ProjectSourceWindow {
  const { viewSource, ...result } = value
  if (!isString(viewSource)) return result
  try {
    const source = resolveFileSource(ctx, viewSource)
    if (source.path !== result.path || source.revision !== result.revision) return result
    const coverage = visibleCoverage(source.content, result.lines)
    if (!isEmpty(coverage)) result.fileRef = saveFileRef(ctx, viewSource, coverage)
  } catch (error) {
    // 会话的引用被挤掉、正文不合法这类情况：不给编辑权，源码仍作为只读内容给出。
    log.debug('签发编辑引用失败，窗口只读', { error: String(error) })
  }
  return result
}

/** 合并同一份源码的可见范围（都是整行）：相交或相邻就并起来，结果按偏移排序。 */
function mergeCoverage(input: readonly ProjectVisibleCoverage[]): ProjectVisibleCoverage[] {
  const merged: ProjectVisibleCoverage[] = []
  for (const region of [...input].sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset)) {
    const last = merged.at(-1)
    if (last && region.startOffset <= last.endOffset && region.startLine <= last.endLine + 1) {
      last.endOffset = Math.max(last.endOffset, region.endOffset)
      last.endLine = Math.max(last.endLine, region.endLine)
    } else merged.push({ ...region })
  }
  return merged
}

/**
 * 交出去之前的最后一步：给每个候选窗口按它真有的行签发 fileRef；同一份源码的几个窗口（包括不相连的）改签成一个，
 * 覆盖它们可见范围的并集——程序拿其中任何一个都能改所有这些行。
 */
export async function finalizeFileWindows(ctx: ProjectOperationContext, windows: readonly ProjectSourceWindow[]): Promise<ProjectSourceWindow[]> {
  const signed = windows.map((window) => signWindow(ctx, window))
  const groups = new Map<string, { source: string; coverage: ProjectVisibleCoverage[]; windows: ProjectSourceWindow[] }>()
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
export function toProjectWindow(window: ProjectSourceWindow): ProjectWindow {
  const shaped: ProjectWindow = {
    path: window.path,
    // 结尾换行之后那个零宽的行只进可见范围，不给模型看（模型面照 wc -l 数行）。
    lines: isNumber(window.trailingLine) ? window.lines.filter(([line, text]) => line !== window.trailingLine || !isEmpty(text)) : window.lines,
  }
  if (isString(window.revision)) shaped.revision = window.revision
  if (isString(window.fileRef)) shaped.fileRef = window.fileRef
  if (isNumber(window.totalLines)) shaped.totalLines = window.totalLines
  if (!isString(window.fileRef)) shaped.editable = false
  const notes = [window.referenceUnavailable, window.note].filter(isString)
  if (!isString(window.fileRef) && isEmpty(notes)) notes.push('这段只能看、不能改：重新 read 拿可编辑的窗口。')
  if (!isEmpty(notes)) shaped.note = notes.join(' ')
  return shaped
}
