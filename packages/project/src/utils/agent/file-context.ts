import { isAbsolute, relative, resolve } from 'node:path'

import {
  type FileContextCarrier,
  fileContextFor,
  type FileContextRange,
  type FileContextSnapshot,
} from '@velaros-ai/agent/tool-contract'
import { isEmpty, isUndefined } from '@velaros-ai/core'

import type { ProjectToolApi } from '../../contract/requires'

import type { AgentProjectPreparedPatch, AgentProjectReadResult } from './kernel-port'
import { projectAgentReadResult } from './kernel-port'
import { finalizeProjectModelResult, presentProjectRead } from './source-window.js'

/** 大文件当前视图最多读取的范围段数。 */
const MaxFocusRanges = 8

export interface ProjectFileContextCarrier extends FileContextCarrier {
  project: Pick<ProjectToolApi, 'getRootPath' | 'kernel'>
}

/** 读取端口仍经过 Project 授权；宿主在发送模型首轮前登记，以支持重启后的视图恢复。 */
export function registerProjectFileContext(context: ProjectFileContextCarrier): ReturnType<typeof fileContextFor> {
  const coordinator = fileContextFor(context)
  if (!coordinator) return undefined
  const root = resolve(context.project.getRootPath())
  const currentKernel = async () => {
    context.abortSignal?.throwIfAborted()
    const kernel = await context.project.kernel()
    if (resolve((await kernel.status()).root) !== root)
      throw new Error('File context project changed; register the current workspace before reading')
    return kernel
  }
  const normalizePath = (path: string) => {
    const normalized = relative(root, resolve(root, path))
    if (normalized === '..' || normalized.startsWith('../') || isAbsolute(normalized))
      throw new Error('File context path is outside project')
    return normalized.replaceAll('\\', '/')
  }
  coordinator.registerSource({
    workspaceId: root,
    normalizePath,
    finalizeModelResult: (value, scopeId) => finalizeProjectModelResult({ ...context, fileRefScopeId: scopeId }, value),
    validateArchive: async (snapshot) => {
      context.abortSignal?.throwIfAborted()
      const kernel = await currentKernel()
      if (!kernel.prepareContextSnapshot)
        throw new Error('Historical snapshot authorization is unavailable')
      const visible = await kernel.prepareContextSnapshot({
        path: normalizePath(snapshot.path),
        content: snapshot.content,
      })
      if (visible.content !== snapshot.content)
        throw new Error('Historical snapshot is restricted by current redaction policy')
    },
    read: async (path, ranges, scopeId) => {
      context.abortSignal?.throwIfAborted()
      const kernel = await currentKernel()
      const normalized = normalizePath(path)
      const stat = await kernel.stat({ path: normalized })
      if (!stat.exists)
        return [
          {
            workspaceId: root,
            path: normalized,
            revision: 'deleted',
            exists: false,
            content: '',
            range: { startLine: 1, endLine: 1 },
            totalLines: 0,
            complete: true,
          },
        ]
      if (!stat.readableText || !stat.revision) throw new Error('Current file is not readable text')
      const selected =
        stat.sizeBytes <= 32_000 ? [undefined] : ranges.length ? ranges.slice(0, MaxFocusRanges) : [undefined]
      const snapshots: FileContextSnapshot[] = []
      for (const range of selected) {
        context.abortSignal?.throwIfAborted()
        const result = await kernel.read({
          path: normalized,
          baseRevision: stat.revision,
          range,
          maxChars: Math.floor(64_000 / selected.length),
        })
        const snapshot = snapshotFromRead(root, result)
        if (snapshot) {
          const projected = await presentProjectRead({ ...context, fileRefScopeId: scopeId }, projectAgentReadResult(normalized, result))
          snapshots.push({ ...snapshot, viewSource: projected.viewSource, presentation: {
            lines: projected.lines, fragments: projected.fragments,
            continuation: projected.continuation, hasMore: result.hasMore,
          } })
        }
      }
      if (isEmpty(snapshots)) throw new Error('Current source snapshot is unavailable')
      return snapshots
    },
  })
  return coordinator
}

export function snapshotFromRead(
  workspaceId: string,
  result: Pick<
    AgentProjectReadResult,
    'snapshot' | 'content' | 'range' | 'totalLines' | 'truncated' | 'hasMore' | 'redacted'
  >
): FileContextSnapshot | undefined {
  if (result.snapshot.isBinary || result.snapshot.isDirectory || !result.snapshot.revision)
    return undefined
  const content = result.content ?? ''
  const range = result.range ?? { startLine: 1, endLine: Math.max(1, result.totalLines ?? 1) }
  return {
    workspaceId,
    path: result.snapshot.path,
    revision: result.snapshot.revision,
    exists: result.snapshot.exists,
    content,
    redacted: result.redacted,
    range,
    totalLines: result.totalLines ?? 0,
    complete:
      range.startLine === 1 &&
      (range.startColumn ?? 1) === 1 &&
      !result.truncated &&
      !result.hasMore &&
      range.endLine >= (result.totalLines ?? 0),
  }
}

interface DiffHunk { oldStart: number; oldLines: number; newStart: number; newLines: number }

function diffHunks(diff: string): DiffHunk[] {
  return [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map((match) => ({
    oldStart: Number(match[1]), oldLines: Number(match[2] ?? 1),
    newStart: Number(match[3]), newLines: Number(match[4] ?? 1),
  }))
}

/** 按一个补丁的 diff 把旧行号迁移到新内容；落在改动段里的行收拢到该段新范围的对应边界。 */
function migrateLine(line: number, hunks: readonly DiffHunk[], edge: 'start' | 'end'): number {
  let shift = 0
  for (const hunk of hunks) {
    if (hunk.oldLines === 0) {
      // 纯插入：新行插在旧第 oldStart 行之后。
      if (line <= hunk.oldStart) break
      shift += hunk.newLines
      continue
    }
    if (line < hunk.oldStart) break
    if (line >= hunk.oldStart + hunk.oldLines) {
      shift += hunk.newLines - hunk.oldLines
      continue
    }
    return Math.max(1, edge === 'start' ? hunk.newStart : hunk.newStart + Math.max(hunk.newLines, 1) - 1)
  }
  return Math.max(1, line + shift)
}

function migrateRange(range: FileContextRange, hunks: readonly DiffHunk[]): FileContextRange {
  const startLine = migrateLine(range.startLine, hunks, 'start')
  return { startLine, endLine: Math.max(startLine, migrateLine(range.endLine, hunks, 'end')) }
}

/** 合并相交或相邻的范围；超过读取上限时先留和本次改动相交的范围。 */
function mergeFocusRanges(changed: readonly FileContextRange[], seen: readonly FileContextRange[]): FileContextRange[] {
  const merged: FileContextRange[] = []
  for (const range of [...changed, ...seen].sort((a, b) => a.startLine - b.startLine)) {
    const last = merged.at(-1)
    if (last && range.startLine <= last.endLine + 1) last.endLine = Math.max(last.endLine, range.endLine)
    else merged.push({ ...range })
  }
  if (merged.length <= MaxFocusRanges) return merged
  const nearChange = (range: FileContextRange) =>
    changed.some((item) => item.startLine <= range.endLine && range.startLine <= item.endLine)
  return [...merged.filter(nearChange), ...merged.filter((range) => !nearChange(range))]
    .slice(0, MaxFocusRanges)
    .sort((a, b) => a.startLine - b.startLine)
}

/**
 * 编辑后当前视图要看的范围：本次 diff 每段前后 5 行，加上此前已读范围沿补丁链迁移后的位置，大文件编辑后
 * 模型读过的上下文仍然可见、可编辑。行号全部由最终补丁推导（含 rebase），不采用模型提交时的原始坐标；
 * 补丁链里每段 diff 相对前一补丁的产出，前面的范围逐段迁移。
 */
export function changedFileContextRanges(
  patches: ReadonlyArray<{ path: string; diff: string }>,
  previous: Readonly<Record<string, readonly FileContextRange[]>> = {}
): Record<string, FileContextRange[]> {
  const chains = new Map<string, DiffHunk[][]>()
  for (const patch of patches) chains.set(patch.path, [...(chains.get(patch.path) ?? []), diffHunks(patch.diff)])
  const ranges: Record<string, FileContextRange[]> = {}
  for (const [path, chain] of chains) {
    let changed: FileContextRange[] = []
    let seen = (previous[path] ?? []).map(({ startLine, endLine }) => ({ startLine, endLine }))
    for (const hunks of chain) {
      changed = changed.map((range) => migrateRange(range, hunks))
      seen = seen.map((range) => migrateRange(range, hunks))
      for (const hunk of hunks) {
        const startLine = Math.max(1, hunk.newStart - 5)
        changed.push({ startLine, endLine: Math.max(startLine, hunk.newStart + hunk.newLines + 5) })
      }
    }
    ranges[path] = mergeFocusRanges(changed, seen)
  }
  return ranges
}

/** 从最终补丁链捕获提交前后全文；归档和模型窗口各自有独立的内容范围。 */
export function committedFileContextSnapshots(
  workspaceId: string,
  patches: readonly AgentProjectPreparedPatch[],
  before: Record<string, string>,
  after: Record<string, string>
): FileContextSnapshot[] {
  const first = new Map<string, AgentProjectPreparedPatch>()
  const last = new Map<string, AgentProjectPreparedPatch>()
  for (const patch of patches) {
    if (!first.has(patch.path)) first.set(patch.path, patch)
    last.set(patch.path, patch)
  }
  const snapshots: FileContextSnapshot[] = []
  const add = (path: string, revision?: string, content?: string) => {
    if (!revision || (isUndefined(content) && revision !== 'deleted')) return
    const text = content ?? ''
    const totalLines = text.split('\n').length
    snapshots.push({
      workspaceId,
      path,
      revision,
      content: text,
      exists: revision !== 'deleted',
      totalLines,
      range: { startLine: 1, endLine: totalLines },
      complete: true,
    })
  }
  for (const [path, patch] of first) add(path, before[path], patch.oldContent)
  for (const [path, patch] of last) add(path, after[path], patch.newContent)
  return snapshots
}
