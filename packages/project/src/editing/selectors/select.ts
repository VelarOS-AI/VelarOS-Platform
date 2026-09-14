import { isEmpty, isString, isUndefined } from '@velaros-ai/core'

import { ProjectError } from '../../errors.js'
import { assertWellFormedProjectText } from '../../utils/text.js'
import { insertionLineText, replacementLineText } from '../mutations/line-text.js'
import type { ProjectContentEdit, ProjectEditView } from '../types.js'

import { assertVisibleLines, intersectWindows, type OffsetWindow, visibleWindows } from './coverage.js'
import { exactMatchCandidates, missingMatchCandidates } from './feedback.js'
import { normalizeProjectLineRange } from './range.js'
import { normalizePhysicalNewlines, ProjectSourceCoordinates } from './source.js'

export interface ProjectResolvedMutation {
  start: number
  end: number
  text: string
  editIndex: number
  fileIndex?: number
  /** 文件末尾空行的替换仍按替换操作检查重叠。 */
  kind: 'replace' | 'insert'
}

export function selectProjectMutations(view: ProjectEditView, edits: readonly ProjectContentEdit[]): ProjectResolvedMutation[] {
  if (isEmpty(edits) || edits.length > 1000) throw new ProjectError('INVALID_INPUT', '每个文件需要 1–1000 项 edits。')
  const source = new ProjectSourceCoordinates(view.content)
  const allWindows = visibleWindows(view, source)
  return edits.map((edit, editIndex) => {
    try {
      assertWellFormedProjectText(edit.text)
      if (edit.op !== 'replace' && edit.op !== 'insert') throw new ProjectError('INVALID_INPUT', '编辑操作仅支持 replace 或 insert。')
      if ('at' in edit) {
        if (edit.op !== 'insert' || (edit.at !== 'start' && edit.at !== 'end') || 'range' in edit || 'match' in edit || 'side' in edit) {
          throw new ProjectError('INVALID_INPUT', 'at 插入形式不能同时包含 range、match 或 side。')
        }
        const line = edit.at === 'start' ? 1 : source.lines.length
        assertVisibleLines(view, line, line, true)
        const offset = edit.at === 'start' ? 0 : view.content.length
        return { start: offset, end: offset, text: insertionLineText(source, offset, edit.text), editIndex, kind: 'insert' }
      }
      if (isUndefined(edit.range) && isUndefined(edit.match)) throw new ProjectError('INVALID_INPUT', '编辑需要 range 或 match。')
      if (edit.op === 'insert' && edit.side !== 'before' && edit.side !== 'after') throw new ProjectError('INVALID_INPUT', '定位插入需要 side:before 或 after。')
      if (edit.op === 'replace' && 'side' in edit) throw new ProjectError('INVALID_INPUT', 'replace 不接受 side。')
      let windows = allWindows
      let start = 0
      let end = view.content.length
      if (!isUndefined(edit.range)) {
        const [startLine, endLine] = normalizeProjectLineRange(edit.range)
        if (endLine > source.lines.length) throw new ProjectError('INVALID_INPUT', '编辑范围超出文件行数。', { range: edit.range, totalLines: source.lines.length })
        assertVisibleLines(view, startLine, endLine, isUndefined(edit.match))
        start = source.lines[startLine - 1].start
        end = source.lines[endLine - 1].end
        windows = intersectWindows(allWindows, start, end)
      }
      const characterSelection = !isUndefined(edit.match)
      if (characterSelection) {
        if (!isString(edit.match) || isEmpty(edit.match)) throw new ProjectError('INVALID_INPUT', 'match 必须是非空字面源码。')
        assertWellFormedProjectText(edit.match)
        const needle = edit.match.replace(/\r\n/g, '\n')
        const matches: OffsetWindow[] = []
        let total = 0
        for (const window of windows) {
          const from = source.logicalOffset(window.start)
          const until = source.logicalOffset(window.end)
          for (let at = source.logical.indexOf(needle, from); at !== -1 && at + needle.length <= until; at = source.logical.indexOf(needle, at + 1)) {
            total += 1
            if (matches.length < 8) matches.push({ start: source.physicalOffset(at), end: source.physicalOffset(at + needle.length) })
          }
        }
        if (total !== 1) {
          const candidates = total === 0
            ? missingMatchCandidates(view, source, windows, edit.match)
            : exactMatchCandidates(source, windows, matches)
          throw new ProjectError(total === 0 ? 'TARGET_NOT_FOUND' : 'AMBIGUOUS_TARGET',
            total === 0 ? 'match 在所选可见区域中没有精确匹配。' : `match 在所选可见区域中有 ${total} 个匹配。`,
            { path: view.path, revision: view.revision, range: edit.range, matches: total,
              recovery: { kind: 'project-edit-candidates', requiresConfirmation: true, candidates, candidatesTruncated: total > candidates.length } },
            '请检查候选后用 reuse + changes 缩小 range 或修正 match；扩展 match 时，替换 text 也须保留候选 prefix/suffix。候选仅供确认，没有写入。')
        }
        start = matches[0].start
        end = matches[0].end
      }
      if (edit.op === 'replace') return {
        start, end, editIndex, kind: 'replace',
        text: characterSelection
          ? normalizePhysicalNewlines(edit.text, source.newlineAt(start, end))
          : replacementLineText(source, start, end, edit.text),
      }
      const offset = edit.side === 'before' ? start : end
      return { start: offset, end: offset, editIndex, kind: 'insert', text: characterSelection
        ? normalizePhysicalNewlines(edit.text, source.newlineAt(start, end))
        : insertionLineText(source, offset, edit.text) }
    } catch (error) {
      if (!(error instanceof ProjectError)) throw error
      throw new ProjectError(error.reason, error.message, { ...error.details, path: view.path, editIndex }, error.suggestedNextAction)
    }
  })
}
