/**
 * 源码窗口的呈现协议：把读取结果排成 [行号, 原文] 的行与带列范围的片段，按实际显示给模型的范围签发 fileRef 与续读引用；
 * 引用签发不了时源码照常作为只读证据给出。
 */

import type { FileContextSnapshot } from '@velaros-ai/agent/tool-contract'
import { isArray, isEmpty, isNumber, isPlainObject, isString, isUndefined, Log, numberOrNull, optionalWhen, toOptional } from '@velaros-ai/core'

import { ProjectPolicyDefaults } from '../../contract/constants.js'
import type { AgentProjectReadResult } from '../../types/agent-port.js'
import type { ProjectReferenceContext, ProjectVisibleCoverage } from '../../types/file-refs.js'
import type { ProjectSourceLine, ProjectSourceWindow } from '../../types/source-window.js'
import { assertWellFormedProjectText } from '../text.js'
import { ProjectTuning } from '../tuning.js'

import { loadProjectFileView, resolveProjectFileSource, saveProjectFileRef, saveProjectFileSource, saveProjectReadPage } from './file-refs.js'

/** 偏移仍依据归档原文计算，显示记录只分离物理换行符。 */
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

/** 此时只生成候选，最终模型投影验证实际可见记录后才签发编辑引用。 */
export async function presentProjectRead(
  context: ProjectReferenceContext,
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
  let original: string | undefined
  let beyondEditableSize = false
  if (sourceRef) {
    try { original = (await resolveProjectFileSource(context, sourceRef)).content } catch { Log.tag('ProjectSourceWindow').debug('原始引用不可用，尝试读取当前授权源码') }
  }
  if (isUndefined(original) && !file.redacted && file.snapshot.revision) {
    try {
      const kernel = await context.project.kernel()
      const full = await kernel.read({ path: file.snapshot.path, baseRevision: file.snapshot.revision, maxChars: ProjectTuning.agent.fullReadChars })
      if (!full.redacted && !full.truncated && !full.hasMore && isString(full.content)) {
        // 这里读得全，不等于改得了：补丁策略要的是带完整正文的快照，而快照正文受 policy.maxFileSizeToReadBytes 约束。
        // 两边上限对齐，超限的文件只给只读窗口并说明，不再签发一个用起来必然 NOT_SUPPORTED 的可编辑引用。
        if (Buffer.byteLength(full.content, 'utf8') > ProjectPolicyDefaults.maxFileSizeToReadBytes) beyondEditableSize = true
        else original = full.content
      }
    } catch {
    Log.tag('ProjectSourceWindow').debug('引用解析或持久化失败，保留证据并限制编辑权限')
      // 二次读取过期或权限拒绝时，保留已读证据但不授予编辑范围。
    }
  }
  const fullLines = isUndefined(original) ? undefined : projectSourceLines(original)
  const start = fullLines?.[startLine - 1]
  if (start && original?.slice(start.start + startColumn - 1, start.start + startColumn - 1 + content.length) === content) {
    const from = start.start + startColumn - 1
    const to = from + content.length
    for (const line of fullLines!) {
      if (line.line < startLine || line.start > to) continue
      // 前缀止于换行符时，下一行正文尚未显示。
      if (line.start === to && content.endsWith('\n') && to < original.length) continue
      if (line.bodyEnd < from) continue
      if (from <= line.start && to >= line.bodyEnd) result.lines.push([line.line, line.text])
      else {
        const a = Math.max(from, line.start)
        const b = Math.min(to, line.bodyEnd)
        if (b > a) (result.fragments ??= []).push({ line: line.line, columns: [a - line.start + 1, b - line.start + 1], text: original.slice(a, b) })
      }
    }
    try {
      result.viewSource = await saveProjectFileSource(context, { path: file.snapshot.path, revision: file.snapshot.revision!, content: original })
    } catch {
    Log.tag('ProjectSourceWindow').debug('引用解析或持久化失败，保留证据并限制编辑权限')
      result.editable = false
      result.referenceUnavailable = '源码已读到，但引用存储不可用。'
    }
  } else {
    // 只读降级也适用于脱敏内容，末行边界保守标记以免扩大编辑权限。
    const parts = content.split('\n')
    for (const [index, raw] of parts.entries()) {
      const line = startLine + index
      const complete = (index > 0 || startColumn === 1) && (index < parts.length - 1 || !file.hasMore)
      if (complete) result.lines.push([line, raw.endsWith('\r') ? raw.slice(0, -1) : raw])
      else if (raw) (result.fragments ??= []).push({ line, columns: [index ? 1 : startColumn, (index ? 1 : startColumn) + raw.length], text: raw })
    }
    result.editable = false
    if (beyondEditableSize) {
      result.referenceUnavailable = `文件超过可编辑上限（${Math.floor(ProjectPolicyDefaults.maxFileSizeToReadBytes / 1024 / 1024)} MiB），只给只读窗口：请改用 project:run 里的命令行工具处理，或先把文件拆小。`
    }
  }
  return result
}

/** 事务回执和当前视图复用已经授权的快照，避免重复访问磁盘。 */
export async function presentProjectContextSnapshot(context: ProjectReferenceContext, snapshot: FileContextSnapshot) {
  return presentProjectRead(context, {
    snapshot: { path: snapshot.path, revision: snapshot.revision, exists: snapshot.exists, isBinary: false, isDirectory: false },
    content: snapshot.content,
    range: snapshot.range,
    totalLines: snapshot.totalLines,
    redacted: snapshot.redacted,
    hasMore: !snapshot.complete,
  }, undefined, snapshot.viewSource)
}

/** 是不是普通对象（可以当键值表读）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value)
}

/** 引用不可签发时，只返回当前 read schema 可接受的重读参数。 */
function withoutUnsignedContinuation(result: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(result.continuation)) return result
  const range = optionalWhen(isPlainObject, result.continuation.range)
  delete result.continuation
  result.continuationUnavailable = '续读引用当前不可用；请按 readAgain 重新读取当前源码。'
  if (isString(result.path)) {
    const file: Record<string, unknown> = { path: result.path }
    if (Number.isSafeInteger(range?.startLine) && Number(range?.startLine) > 0) file.range = range!.startLine
    result.readAgain = { files: [file] }
  }
  return result
}

/** 代码详情、搜索、编辑回执与恢复候选递归共用同一呈现协议。 */
async function finalizeProjectWindowTree(context: ProjectReferenceContext, value: unknown): Promise<unknown> {
  if (isArray(value)) return Promise.all(value.map((item) => finalizeProjectWindowTree(context, item)))
  if (!isRecord(value)) return value
  if (value.kind !== 'project-source-window') {
    const entries = await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await finalizeProjectWindowTree(context, item)] as const))
    return Object.fromEntries(entries)
  }
  const result = { ...value }
  const ref = isString(result.viewSource) ? result.viewSource : optionalWhen(isString, result.fileRef)
  delete result.viewSource
  delete result.fileRef
  if (!ref || result.redacted) return withoutUnsignedContinuation(result)
  let source: Awaited<ReturnType<typeof resolveProjectFileSource>>
  try { source = await resolveProjectFileSource(context, ref) } catch {
    Log.tag('ProjectSourceWindow').debug('引用解析或持久化失败，保留证据并限制编辑权限')
    // 其他已注册工作区可能拥有该候选，保留给对应来源完成签发。
    // 编辑解析器只接受正式视图引用。
    return value
  }
  try {
    if (source.path !== result.path || source.revision !== result.revision) return withoutUnsignedContinuation(result)
    const sourceLines = projectSourceLines(source.content)
    const coverage: ProjectVisibleCoverage[] = []
    for (const record of isArray(result.lines) ? result.lines : []) {
      if (!isArray(record) || record.length !== 2 || !Number.isInteger(record[0]) || !isString(record[1])) continue
      const line = sourceLines[Number(record[0]) - 1]
      if (!line || line.text !== record[1]) continue
      coverage.push({ startOffset: line.start, endOffset: line.end, startLine: line.line, endLine: line.line, completeLines: true })
    }
    for (const fragment of isArray(result.fragments) ? result.fragments : []) {
      if (!isRecord(fragment) || !Number.isInteger(fragment.line) || !isArray(fragment.columns) || fragment.columns.length !== 2 || !isString(fragment.text)) continue
      const line = sourceLines[Number(fragment.line) - 1]
      const [a, b] = fragment.columns
      if (!line || !isNumber(a) || !isNumber(b) || !Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b <= a || b > line.text.length + 1 || line.text.slice(a - 1, b - 1) !== fragment.text) continue
      assertWellFormedProjectText(fragment.text)
      coverage.push({ startOffset: line.start + a - 1, endOffset: line.start + b - 1, startLine: line.line, endLine: line.line, completeLines: false })
    }
    // 脱敏或截断的行记录不会保留原始整行权限。
    coverage.sort((a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset)
    const merged: ProjectVisibleCoverage[] = []
    for (const region of coverage) {
      const last = merged.at(-1)
      if (last?.completeLines && region.completeLines && last.endOffset === region.startOffset && last.endLine + 1 === region.startLine) {
        last.endOffset = region.endOffset
        last.endLine = region.endLine
      } else merged.push({ ...region })
    }
    if (!isEmpty(merged)) result.fileRef = await saveProjectFileRef(context, ref, merged)
    if (isRecord(result.continuation) && isRecord(result.continuation.range)) {
      const range = result.continuation.range
      if (isNumber(range.startLine)) result.continuation = await saveProjectReadPage(context, ref, {
        startLine: range.startLine,
        startColumn: toOptional(numberOrNull(range.startColumn)),
        endLine: toOptional(numberOrNull(range.endLine)),
        endColumn: toOptional(numberOrNull(range.endColumn)),
      })
    }
  } catch {
    Log.tag('ProjectSourceWindow').debug('引用解析或持久化失败，保留证据并限制编辑权限')
    // 作用域变化或存储失败时不给编辑权限，源码仍可作为只读证据。
  }
  return withoutUnsignedContinuation(result)
}

/** 合并同一份源码的可见范围：整行范围相交或相邻就并起来，已被整行范围盖住的部分行片段丢掉，其余片段按行合并，结果按偏移排序。 */
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

/** 模型结果交出去前的最后一步：给每个源码窗口按实际显示的行签发 fileRef，同一份源码的多个窗口（包括不相连的）共用它们可见范围的并集。 */
export async function finalizeProjectModelResult(context: ProjectReferenceContext, value: unknown): Promise<unknown> {
  const finalized = await finalizeProjectWindowTree(context, value)
  const groups = new Map<string, { source: string; coverage: ProjectVisibleCoverage[]; windows: Array<Record<string, unknown>> }>()
  const collect = async (item: unknown): Promise<void> => {
    if (isArray(item)) { await Promise.all(item.map(collect)); return }
    if (!isRecord(item)) return
    if (item.kind === 'project-source-window' && isString(item.fileRef)) {
      try {
        const view = await loadProjectFileView(context, item.fileRef)
        const key = JSON.stringify([view.path, view.revision, view.contentRevision])
        const group = groups.get(key) ?? { source: item.fileRef, coverage: [], windows: [] }
        group.coverage.push(...view.coverage)
        group.windows.push(item)
        groups.set(key, group)
      } catch { Log.tag('ProjectSourceWindow').debug('该视图留给其所属工作区完成签发') }
      return
    }
    await Promise.all(Object.values(item).map(collect))
  }
  await collect(finalized)
  for (const group of groups.values()) {
    if (group.windows.length < 2) continue
    try {
      const ref = await saveProjectFileRef(context, group.source, mergeCoverage(group.coverage))
      for (const window of group.windows) window.fileRef = ref
    } catch {
    Log.tag('ProjectSourceWindow').debug('引用解析或持久化失败，保留证据并限制编辑权限')
      // 各窗口已有有效的窄范围引用，可选并集失败时保留已经成功的读取。
    }
  }
  return finalized
}
