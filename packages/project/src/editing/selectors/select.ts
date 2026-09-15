import { isEmpty, isString, isUndefined } from '@velaros-ai/core'

import { ProjectError } from '../../errors.js'
import { assertWellFormedProjectText } from '../../utils/text.js'
import { insertionLineText, replacementLineText } from '../mutations/line-text.js'
import type { ProjectContentEdit, ProjectEditView } from '../types.js'

import { assertVisibleLines, intersectWindows, type OffsetWindow, visibleWindows } from './coverage.js'
import { exactMatchCandidates, matchesElsewhere, missingMatchCandidates, type ProjectMatchCandidate, type ProjectMatchElsewhere } from './feedback.js'
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

const CandidateNextAction = '请检查候选后用 reuse + changes 缩小 range 或修正 match；扩展 match 时，替换 text 也须保留候选 prefix/suffix。候选仅供确认，没有写入。'

/** 零命中按原因给下一步：原文在 range 外、在未显示的行、有相近候选，或完全对不上。 */
function missingMatchGuidance(candidates: readonly ProjectMatchCandidate[], elsewhere: readonly ProjectMatchElsewhere[]): { message: string; next: string } {
  const lines = (visible: boolean) => elsewhere.filter((item) => item.visible === visible).slice(0, 3)
    .map(({ range: [start, end] }) => start === end ? `${start}` : `${start}–${end}`).join('、')
  if (elsewhere.some((item) => item.visible)) return {
    message: `match 不在所选 range 内，它出现在第 ${lines(true)} 行。`,
    next: '用 reuse + changes 把该项的 range 改成覆盖这段原文，或去掉 range 只用 match（须在可见区域中唯一）。',
  }
  if (!isEmpty(elsewhere)) return {
    message: `match 在 fileRef 可见区域中没有匹配，原文在未显示的第 ${lines(false)} 行。`,
    next: '先用 project:read 读取这些行获取新 fileRef，再用 reuse + changes 替换 fileRef（必要时同步 range），正文保持原样。',
  }
  if (!isEmpty(candidates)) return { message: 'match 在所选可见区域中没有精确匹配。', next: CandidateNextAction }
  return {
    message: 'match 在所选可见区域中没有精确匹配，也没有相近的原文。',
    next: '重新读取目标行，按显示的原文逐字复制 match（空白、引号、反斜杠以 JSON 解码后的源码为准）；或改用 range 按整行定位。',
  }
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
          const elsewhere = total === 0 ? matchesElsewhere(source, allWindows, windows, edit.match) : []
          const details: Record<string, unknown> = { path: view.path, revision: view.revision, range: edit.range, matches: total,
            recovery: { kind: 'project-edit-candidates', requiresConfirmation: true, candidates, candidatesTruncated: total > candidates.length } }
          if (!isEmpty(elsewhere)) details.elsewhere = elsewhere
          const { message, next } = total === 0
            ? missingMatchGuidance(candidates, elsewhere)
            : { message: `match 在所选可见区域中有 ${total} 个匹配。`, next: CandidateNextAction }
          throw new ProjectError(total === 0 ? 'TARGET_NOT_FOUND' : 'AMBIGUOUS_TARGET', message, details, next)
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
