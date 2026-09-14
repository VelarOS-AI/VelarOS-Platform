import { isAbsolute, relative, resolve } from 'node:path'

import {
  type FileContextCarrier,
  fileContextFor,
  type FileContextRange,
  type FileContextSnapshot,
} from '@velaros-ai/agent/tool-contract'
import { isEmpty, isUndefined } from '@velaros-ai/core'

import { finalizeProjectModelResult, presentProjectRead } from './presentation/source-window.js'
import type { AgentProjectPreparedPatch, AgentProjectReadResult } from './ProjectKernelPort'
import { projectAgentReadResult } from './ProjectKernelPort'
import type { ProjectToolApi } from './Types'

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
        stat.sizeBytes <= 32_000 ? [undefined] : ranges.length ? ranges.slice(0, 8) : [undefined]
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

/** 使用最终事务 diff 的新行号，避免 rebase 后仍从模型原始行号抓取当前片段。 */
export function changedFileContextRanges(
  patches: ReadonlyArray<{ path: string; diff: string }>
): Record<string, FileContextRange[]> {
  const ranges: Record<string, FileContextRange[]> = {}
  for (const patch of patches) {
    for (const match of patch.diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
      const startLine = Math.max(1, Number(match[1]) - 5)
      const endLine = Math.max(startLine, Number(match[1]) + Number(match[2] ?? 1) + 5)
      ;(ranges[patch.path] ??= []).push({ startLine, endLine })
    }
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
