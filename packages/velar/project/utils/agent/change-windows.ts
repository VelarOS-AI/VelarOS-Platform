/**
 * edit 回执里改过的文件的窗口：本次每段改动前后几行，加上这次编辑用到的 fileRef 原来看得到、沿补丁链迁到新内容上的范围。
 * 按共用的字符预算从改完的文件里读回来，签发新的 fileRef——程序接着改就用它，不必重读。
 * 行号全部由最终补丁推导（含 rebase），不用模型提交时的原始坐标。
 */

import { isEmpty, Log } from '@velaros-ai/core'

import type { ProjectOperationContext } from '../../contract/requires.js'
import type { DiffHunk, LineSpan } from '../../types/agent.js'
import type { AgentProjectPreparedPatch } from '../../types/agent-port.js'
import type { ProjectWindow } from '../../types/files.js'
import type { ProjectSourceWindow } from '../../types/source-window.js'
import { ProjectTuning } from '../tuning.js'

import { executeAgentProjectRead } from './kernel-port.js'
import { finalizeFileWindows, presentFileRead, toProjectWindow } from './source-window.js'

const log = Log.tag('FileChangeWindows')

/** 从 unified diff 里取出每段改动的旧起始行、旧行数、新起始行、新行数；省略的行数按 1 算。 */
function diffHunks(diff: string): DiffHunk[] {
  return [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map((match) => ({
    oldStart: Number(match[1]), oldLines: Number(match[2] ?? 1),
    newStart: Number(match[3]), newLines: Number(match[4] ?? 1),
  }))
}

/** 按一个补丁的 diff 把旧行号迁到新内容；落在改动段里的行收拢到该段新范围的对应边界。 */
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

/** 按一个补丁的改动段把旧范围迁到新内容：首行按起点边界迁，末行按终点边界迁，结果至少一行。 */
function migrateSpan(span: LineSpan, hunks: readonly DiffHunk[]): LineSpan {
  const startLine = migrateLine(span.startLine, hunks, 'start')
  return { startLine, endLine: Math.max(startLine, migrateLine(span.endLine, hunks, 'end')) }
}

/** 合并相交或相邻的范围；超过段数上限时先留和本次改动相交的。 */
function mergeFocusSpans(changed: readonly LineSpan[], seen: readonly LineSpan[]): LineSpan[] {
  const merged: LineSpan[] = []
  for (const span of [...changed, ...seen].sort((a, b) => a.startLine - b.startLine)) {
    const last = merged.at(-1)
    if (last && span.startLine <= last.endLine + 1) last.endLine = Math.max(last.endLine, span.endLine)
    else merged.push({ ...span })
  }
  if (merged.length <= ProjectTuning.receiptWindows.focusRanges) return merged
  const nearChange = (span: LineSpan) => changed.some((item) => item.startLine <= span.endLine && span.startLine <= item.endLine)
  return [...merged.filter(nearChange), ...merged.filter((span) => !nearChange(span))]
    .slice(0, ProjectTuning.receiptWindows.focusRanges)
    .sort((a, b) => a.startLine - b.startLine)
}

/**
 * 改完之后每个文件要看的范围：本次 diff 每段前后几行，加上此前看得到的范围沿补丁链迁移后的位置。
 * 补丁链里每段 diff 相对前一个补丁的产出，前面的范围逐段迁移。
 */
export function changedSpans(patches: ReadonlyArray<{ path: string; diff: string }>, previous: Readonly<Record<string, readonly LineSpan[]>>): Record<string, LineSpan[]> {
  const chains = new Map<string, DiffHunk[][]>()
  for (const patch of patches) chains.set(patch.path, [...(chains.get(patch.path) ?? []), diffHunks(patch.diff)])
  const spans: Record<string, LineSpan[]> = {}
  for (const [path, chain] of chains) {
    let changed: LineSpan[] = []
    let seen = (previous[path] ?? []).map(({ startLine, endLine }) => ({ startLine, endLine }))
    for (const hunks of chain) {
      changed = changed.map((span) => migrateSpan(span, hunks))
      seen = seen.map((span) => migrateSpan(span, hunks))
      for (const hunk of hunks) {
        const startLine = Math.max(1, hunk.newStart - ProjectTuning.receiptWindows.changeContextLines)
        changed.push({ startLine, endLine: Math.max(startLine, hunk.newStart + hunk.newLines + ProjectTuning.receiptWindows.changeContextLines) })
      }
    }
    spans[path] = mergeFocusSpans(changed, seen)
  }
  return spans
}

/**
 * 读回改过的文件的窗口并签发新的 fileRef：删掉的、移走的旧路径不给；预算装不下的文件不给窗口（程序要接着改就先 read）。
 * 读不到（刚改完又被别人改了）就跳过这个文件，回执照样成立。
 */
export async function changeWindows(
  ctx: ProjectOperationContext,
  patches: readonly AgentProjectPreparedPatch[],
  newRevisions: Readonly<Record<string, string>>,
  previous: Readonly<Record<string, readonly LineSpan[]>>,
): Promise<ProjectWindow[]> {
  const spans = changedSpans(patches, previous)
  const kernel = await ctx.project.kernel()
  const windows: ProjectSourceWindow[] = []
  let remaining = ProjectTuning.receiptWindows.chars
  for (const [path, ranges] of Object.entries(spans)) {
    const revision = newRevisions[path]
    if (!revision || isEmpty(ranges) || remaining <= 0) continue
    for (const span of ranges) {
      if (remaining <= 0) break
      try {
        const read = await executeAgentProjectRead(kernel, {
          path, range: { startLine: span.startLine, endLine: span.endLine },
          baseRevisions: { [path]: revision },
          maxChars: remaining,
        }, { rootPath: ctx.project.getRootPath() })
        for (const file of read.files) {
          const window = await presentFileRead(ctx, file)
          windows.push(window)
          remaining -= JSON.stringify(window).length
        }
      } catch (error) {
        log.debug('改后的窗口读不到', { path, error: String(error) })
      }
    }
  }
  return (await finalizeFileWindows(ctx, windows)).map(toProjectWindow)
}
