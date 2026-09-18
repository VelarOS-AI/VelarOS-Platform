import { isEmpty, isString, isUndefined } from '@velaros-ai/core'

import { ProjectFileLimits } from '../../contract/constants.js'
import type { OffsetWindow, ProjectEditView, ProjectMatchCandidate, ProjectMatchElsewhere, ProjectResolvedMutation } from '../../types/editing.js'
import type { ProjectContentEdit } from '../../types/files.js'
import { ProjectError } from '../errors.js'
import { assertWellFormedProjectText } from '../text.js'
import { ProjectTuning } from '../tuning.js'

import { normalizeProjectLineRange } from './line-range.js'
import { insertionLineText, replacementLineText } from './line-text.js'
import { exactMatchCandidates, matchesElsewhere, missingMatchCandidates } from './match-feedback.js'
import { assertVisibleLines, intersectWindows, visibleWindows } from './selection-coverage.js'
import { createProjectSourceCoordinates, logicalSourceOffset, normalizePhysicalNewlines, physicalSourceOffset, sourceLineCount, sourceNewlineAt } from './source.js'

const CandidateNextAction = '核对候选后缩小 range 或修正 match 再提交；把 match 扩成更长的原文时，替换的 text 也要带上候选的 prefix/suffix。候选只供确认，什么都没写。'

/** 零命中按原因给下一步：原文在 range 外、在未显示的行、有相近候选，或完全对不上。 */
function missingMatchGuidance(candidates: readonly ProjectMatchCandidate[], elsewhere: readonly ProjectMatchElsewhere[]): { message: string; next: string } {
  const lines = (visible: boolean) => elsewhere.filter((item) => item.visible === visible).slice(0, 3)
    .map(({ range: [start, end] }) => start === end ? `${start}` : `${start}–${end}`).join('、')
  if (elsewhere.some((item) => item.visible)) return {
    message: `match 不在所选 range 内，它出现在第 ${lines(true)} 行。`,
    next: '把这一处的 range 改成覆盖这段原文，或者去掉 range 只用 match（在读到的范围里必须唯一）。',
  }
  if (!isEmpty(elsewhere)) return {
    message: `match 在 fileRef 可见区域中没有匹配，原文在未显示的第 ${lines(false)} 行。`,
    next: '先 read 这些行拿新 fileRef，把这一步的 fileRef 换成它（有 range 的一起改），text 不用动。',
  }
  if (!isEmpty(candidates)) return { message: 'match 在读到的这段里没有精确匹配，下面是相近的原文。', next: CandidateNextAction }
  return {
    message: 'match 在读到的这段里没有精确匹配，也没有相近的原文。',
    next: '照窗口 lines 里那几行的原文写 match（空白、引号、反斜杠都要一样）；或者去掉 match，只用 range 按整行改。',
  }
}

/** 把一个文件的 edits 按原始坐标逐项定位成拼接：range 按整行、match 在可见区域里唯一匹配；定位不了时抛出带候选与下一步的错误。 */
export function selectProjectMutations(view: ProjectEditView, edits: readonly ProjectContentEdit[]): ProjectResolvedMutation[] {
  if (isEmpty(edits) || edits.length > ProjectFileLimits.editsPerFile) throw new ProjectError('INVALID_INPUT', `每个文件需要 1–${ProjectFileLimits.editsPerFile} 项 edits。`)
  const source = createProjectSourceCoordinates(view.content)
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
        // 最后一行的下一行（结尾换行之后那个零宽的行）照样认：在那儿替换或插入就是加在末尾，原文件的结尾换行保留。
        if (endLine > source.lines.length) {
          const lineCount = sourceLineCount(source)
          throw new ProjectError('INVALID_INPUT', `第 ${endLine} 行超出了文件的行数（${lineCount} 行）。`, { range: edit.range, totalLines: lineCount },
            "要加在文件末尾用 { op: 'insert', at: 'end' }；行号照 read 给的写。")
        }
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
          const from = logicalSourceOffset(source, window.start)
          const until = logicalSourceOffset(source, window.end)
          for (let at = source.logical.indexOf(needle, from); at !== -1 && at + needle.length <= until; at = source.logical.indexOf(needle, at + 1)) {
            total += 1
            if (matches.length < ProjectTuning.editing.candidates) matches.push({ start: physicalSourceOffset(source, at), end: physicalSourceOffset(source, at + needle.length) })
          }
        }
        if (total !== 1) {
          const candidates = total === 0
            ? missingMatchCandidates(view, source, windows, edit.match)
            : exactMatchCandidates(source, windows, matches)
          const elsewhere = total === 0 ? matchesElsewhere(source, allWindows, windows, edit.match) : []
          const details: Record<string, unknown> = { path: view.path, revision: view.revision, range: edit.range, matches: total }
          // 一个候选都没有时不给 recovery：空的确认信封只会让模型以为还有东西可确认。
          if (!isEmpty(candidates))
            details.recovery = { kind: 'project-edit-candidates', requiresConfirmation: true, candidates, candidatesTruncated: total > candidates.length }
          if (!isEmpty(elsewhere)) details.elsewhere = elsewhere
          const { message, next } = total === 0
            ? missingMatchGuidance(candidates, elsewhere)
            : { message: `match 在读到的这段里出现了 ${total} 次。`, next: CandidateNextAction }
          throw new ProjectError(total === 0 ? 'TARGET_NOT_FOUND' : 'AMBIGUOUS_TARGET', message, details, next)
        }
        start = matches[0].start
        end = matches[0].end
      }
      if (edit.op === 'replace') return {
        start, end, editIndex, kind: 'replace',
        text: characterSelection
          ? normalizePhysicalNewlines(edit.text, sourceNewlineAt(source, start, end))
          : replacementLineText(source, start, end, edit.text),
      }
      const offset = edit.side === 'before' ? start : end
      return { start: offset, end: offset, editIndex, kind: 'insert', text: characterSelection
        ? normalizePhysicalNewlines(edit.text, sourceNewlineAt(source, start, end))
        : insertionLineText(source, offset, edit.text) }
    } catch (error) {
      if (!(error instanceof ProjectError)) throw error
      throw new ProjectError(error.reason, error.message, { ...error.details, path: view.path, editIndex }, error.suggestedNextAction)
    }
  })
}
