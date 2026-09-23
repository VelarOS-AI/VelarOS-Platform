import type {
  OffsetWindow,
  ProjectEditView,
  ProjectSourceCoordinates,
} from '../../types/editing.js'
import { ProjectError } from '../errors.js'

import { logicalSourceOffset, sourceLineAt } from './source.js'

/** 把 fileRef 的可见覆盖范围核对后合并成有序的偏移窗口；范围与正文对不上、切断 CRLF 或 Unicode 字符时拒绝。 */
export function visibleWindows(
  view: ProjectEditView,
  source: ProjectSourceCoordinates
): OffsetWindow[] {
  const windows: OffsetWindow[] = []
  for (const coverage of view.coverage) {
    const { startOffset: start, endOffset: end, startLine, endLine } = coverage
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end > source.content.length ||
      !Number.isSafeInteger(startLine) ||
      !Number.isSafeInteger(endLine) ||
      startLine < 1 ||
      endLine < startLine ||
      endLine > source.lines.length ||
      sourceLineAt(source, start) !== startLine ||
      end > source.lines[endLine - 1].end ||
      end < source.lines[endLine - 1].start ||
      (coverage.completeLines &&
        (start !== source.lines[startLine - 1].start || end !== source.lines[endLine - 1].end))
    )
      throw new ProjectError('INVALID_INPUT', '文件引用中的可见覆盖范围无效。', { path: view.path })
    logicalSourceOffset(source, start)
    logicalSourceOffset(source, end)
    for (const offset of [start, end]) {
      if (
        offset > 0 &&
        offset < source.content.length &&
        /[\uD800-\uDBFF]/.test(source.content[offset - 1]) &&
        /[\uDC00-\uDFFF]/.test(source.content[offset])
      ) {
        throw new ProjectError('INVALID_INPUT', '源码覆盖范围不能截断 Unicode 字符。')
      }
    }
    windows.push({ start, end })
  }
  windows.sort((left, right) => left.start - right.start || left.end - right.end)
  const merged: OffsetWindow[] = []
  for (const window of windows) {
    const last = merged.at(-1)
    if (last && window.start <= last.end) last.end = Math.max(last.end, window.end)
    else merged.push({ ...window })
  }
  return merged
}

/** 核对 [startLine, endLine] 每一行都在 fileRef 实际显示过的范围里（complete 为 true 时要求整行显示）；缺了就按越界拒绝。 */
export function assertVisibleLines(
  view: ProjectEditView,
  startLine: number,
  endLine: number,
  complete: boolean
): void {
  const coverage = view.coverage
    .filter((window) => !complete || window.completeLines)
    .map((window) => [window.startLine, window.endLine] as const)
    .sort((left, right) => left[0] - right[0])
  let next = startLine
  for (const [start, end] of coverage) {
    if (start > next) break
    if (end >= next) next = end + 1
    if (next > endLine) return
  }
  throw new ProjectError(
    'SCOPE_VIOLATION',
    'range 超出 fileRef 实际显示的源码范围。',
    {
      path: view.path,
      range: [startLine, endLine],
      completeLinesRequired: complete,
    },
    '请读取缺少的源码范围，使用返回的新 fileRef；超长行片段使用 match 定位。'
  )
}

/** 把每个窗口裁到 [start, end) 之内；裁完起点落在终点之后（两者不相交）的丢掉。 */
export function intersectWindows(
  windows: readonly OffsetWindow[],
  start: number,
  end: number
): OffsetWindow[] {
  return windows.flatMap((window) => {
    const from = Math.max(start, window.start)
    const to = Math.min(end, window.end)
    return to >= from ? [{ start: from, end: to }] : []
  })
}
