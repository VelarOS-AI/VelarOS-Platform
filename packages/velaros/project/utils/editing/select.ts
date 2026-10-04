import { isEmpty, isString, isUndefined } from '@velaros-ai/core'

import { ProjectFileLimits } from '../../contract/constants.js'
import type {
  OffsetWindow,
  ProjectEditView,
  ProjectMatchCandidate,
  ProjectMatchElsewhere,
  ProjectResolvedMutation,
} from '../../types/editing.js'
import type { ProjectContentEdit } from '../../types/files.js'
import { ProjectError } from '../errors.js'
import { assertWellFormedProjectText } from '../text.js'
import { ProjectTuning } from '../tuning.js'

import { normalizeProjectLineRange } from './line-range.js'
import { insertionLineText, replacementLineText } from './line-text.js'
import { exactMatchCandidates, matchesElsewhere, missingMatchCandidates } from './match-feedback.js'
import {
  assertVisibleLines,
  assertVisibleSpan,
  intersectWindows,
  visibleWindows,
} from './selection-coverage.js'
import {
  createProjectSourceCoordinates,
  logicalSourceOffset,
  normalizePhysicalNewlines,
  physicalSourceOffset,
  sourceLineCount,
  sourceNewlineAt,
} from './source.js'

const CandidateNextAction =
  '照候选的原文改 oldText 再提交；出现好几处就带上前后几行让它唯一，newText 也要带上同样的前后文。候选只供确认，什么都没写。'

/** 零命中按原因给下一步：原文在所选的行外、在没读到的行、有相近候选，或完全对不上。 */
function missingMatchGuidance(
  candidates: readonly ProjectMatchCandidate[],
  elsewhere: readonly ProjectMatchElsewhere[]
): { message: string; next: string } {
  const lines = (visible: boolean) =>
    elsewhere
      .filter((item) => item.visible === visible)
      .slice(0, 3)
      .map(({ range: [start, end] }) => (start === end ? `${start}` : `${start}–${end}`))
      .join('、')
  if (elsewhere.some((item) => item.visible))
    return {
      message: `要换的原文不在所选的行里，它出现在第 ${lines(true)} 行。`,
      next: '按原文在整个文件里找，别限定行。',
    }
  if (!isEmpty(elsewhere))
    return {
      message: `要换的原文不在读到的范围里，它在第 ${lines(false)} 行。`,
      next: '重新提交这一步，按原文在整个文件里找。',
    }
  if (!isEmpty(candidates))
    return {
      message: 'oldText 在文件里没有一模一样的原文，下面是最接近的几处。',
      next: CandidateNextAction,
    }
  return {
    message: 'oldText 在文件里没有一模一样的原文，也没有相近的。',
    next: '先 read 要改的那一段，照读到的原文写 oldText（空白、引号、反斜杠、换行都要一样）。',
  }
}

/** 把一个文件的 edits 按原始坐标逐项定位成拼接：range 按整行、match 在可见区域里唯一匹配；定位不了时抛出带候选与下一步的错误。 */
export function selectProjectMutations(
  view: ProjectEditView,
  edits: readonly ProjectContentEdit[]
): ProjectResolvedMutation[] {
  if (isEmpty(edits) || edits.length > ProjectFileLimits.editsPerFile)
    throw new ProjectError(
      'INVALID_INPUT',
      `每个文件需要 1–${ProjectFileLimits.editsPerFile} 项 edits。`
    )
  const source = createProjectSourceCoordinates(view.content)
  const allWindows = visibleWindows(view, source)
  return edits.map((edit, editIndex) => {
    try {
      assertWellFormedProjectText(edit.text)
      if (edit.op !== 'replace' && edit.op !== 'insert')
        throw new ProjectError('INVALID_INPUT', '编辑操作仅支持 replace 或 insert。')
      if ('at' in edit) {
        if (
          edit.op !== 'insert' ||
          (edit.at !== 'start' && edit.at !== 'end') ||
          'range' in edit ||
          'match' in edit ||
          'side' in edit
        ) {
          throw new ProjectError('INVALID_INPUT', 'at 插入形式不能同时包含 range、match 或 side。')
        }
        const line = edit.at === 'start' ? 1 : source.lines.length
        assertVisibleLines(view, line, line, true)
        const offset = edit.at === 'start' ? 0 : view.content.length
        return {
          start: offset,
          end: offset,
          text: insertionLineText(source, offset, edit.text),
          editIndex,
          kind: 'insert',
        }
      }
      if (!('span' in edit) && isUndefined(edit.range) && isUndefined(edit.match))
        throw new ProjectError('INVALID_INPUT', '编辑需要 range 或 match。')
      if (edit.op === 'insert' && edit.side !== 'before' && edit.side !== 'after')
        throw new ProjectError('INVALID_INPUT', '定位插入需要 side:before 或 after。')
      if (edit.op === 'replace' && 'side' in edit)
        throw new ProjectError('INVALID_INPUT', 'replace 不接受 side。')
      if ('span' in edit) {
        if ('range' in edit || 'match' in edit)
          throw new ProjectError('INVALID_INPUT', '工具绑定的 span 不能与 range、match 混用。')
        const { start, end, lines } = edit.span
        assertVisibleSpan(view, source, start, end, allWindows)
        if (edit.op === 'replace')
          return {
            start,
            end,
            editIndex,
            kind: 'replace',
            text: lines
              ? replacementLineText(source, start, end, edit.text)
              : normalizePhysicalNewlines(edit.text, sourceNewlineAt(source, start, end)),
          }
        const offset = edit.side === 'before' ? start : end
        return {
          start: offset,
          end: offset,
          editIndex,
          kind: 'insert',
          text: lines
            ? insertionLineText(source, offset, edit.text)
            : normalizePhysicalNewlines(edit.text, sourceNewlineAt(source, start, end)),
        }
      }
      let windows = allWindows
      let start = 0
      let end = view.content.length
      if (!isUndefined(edit.range)) {
        const [startLine, endLine] = normalizeProjectLineRange(edit.range)
        // 最后一行的下一行（结尾换行之后那个零宽的行）照样认：在那儿替换或插入就是加在末尾，原文件的结尾换行保留。
        if (endLine > source.lines.length) {
          const lineCount = sourceLineCount(source)
          throw new ProjectError(
            'INVALID_INPUT',
            `第 ${endLine} 行超出了文件的行数（${lineCount} 行）。`,
            { range: edit.range, totalLines: lineCount },
            "要加在文件末尾用 { op: 'insert', at: 'end' }；行号照 read 给的写。"
          )
        }
        assertVisibleLines(view, startLine, endLine, isUndefined(edit.match))
        start = source.lines[startLine - 1].start
        end = source.lines[endLine - 1].end
        windows = intersectWindows(allWindows, start, end)
      }
      const characterSelection = !isUndefined(edit.match)
      if (characterSelection) {
        if (!isString(edit.match) || isEmpty(edit.match))
          throw new ProjectError('INVALID_INPUT', 'match 必须是非空字面源码。')
        assertWellFormedProjectText(edit.match)
        const needle = edit.match.replace(/\r\n/g, '\n')
        const matches: OffsetWindow[] = []
        let total = 0
        for (const window of windows) {
          const from = logicalSourceOffset(source, window.start)
          const until = logicalSourceOffset(source, window.end)
          for (
            let at = source.logical.indexOf(needle, from);
            at !== -1 && at + needle.length <= until;
            at = source.logical.indexOf(needle, at + 1)
          ) {
            total += 1
            if (matches.length < ProjectTuning.editing.candidates)
              matches.push({
                start: physicalSourceOffset(source, at),
                end: physicalSourceOffset(source, at + needle.length),
              })
          }
        }
        if (total !== 1) {
          const candidates =
            total === 0
              ? missingMatchCandidates(view, source, windows, edit.match)
              : exactMatchCandidates(source, windows, matches)
          const elsewhere =
            total === 0 ? matchesElsewhere(source, allWindows, windows, edit.match) : []
          const details: Record<string, unknown> = {
            path: view.path,
            revision: view.revision,
            range: edit.range,
            matches: total,
          }
          // 一个候选都没有时不给 recovery：空的确认信封只会让模型以为还有东西可确认。
          if (!isEmpty(candidates))
            details.recovery = {
              kind: 'project-edit-candidates',
              requiresConfirmation: true,
              candidates,
              candidatesTruncated: total > candidates.length,
            }
          if (!isEmpty(elsewhere)) details.elsewhere = elsewhere
          const { message, next } =
            total === 0
              ? missingMatchGuidance(candidates, elsewhere)
              : { message: `oldText 在文件里出现了 ${total} 次。`, next: CandidateNextAction }
          throw new ProjectError(
            total === 0 ? 'TARGET_NOT_FOUND' : 'AMBIGUOUS_TARGET',
            message,
            details,
            next
          )
        }
        start = matches[0].start
        end = matches[0].end
      }
      if (edit.op === 'replace')
        return {
          start,
          end,
          editIndex,
          kind: 'replace',
          text: characterSelection
            ? normalizePhysicalNewlines(edit.text, sourceNewlineAt(source, start, end))
            : replacementLineText(source, start, end, edit.text),
        }
      const offset = edit.side === 'before' ? start : end
      return {
        start: offset,
        end: offset,
        editIndex,
        kind: 'insert',
        text: characterSelection
          ? normalizePhysicalNewlines(edit.text, sourceNewlineAt(source, start, end))
          : insertionLineText(source, offset, edit.text),
      }
    } catch (error) {
      if (!(error instanceof ProjectError)) throw error
      throw new ProjectError(
        error.reason,
        error.message,
        { ...error.details, path: view.path, editIndex },
        error.suggestedNextAction
      )
    }
  })
}
