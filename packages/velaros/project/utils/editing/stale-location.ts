import { isUndefined } from '@velaros-ai/core'

import type { ProjectEditView, ProjectRelocatedEdit } from '../../types/editing.js'
import type { ProjectContentEdit } from '../../types/files.js'

import { normalizeProjectLineRange } from './line-range.js'
import { selectProjectMutations } from './select.js'
import { createProjectSourceCoordinates, sourceLineAt } from './source.js'

/** text 在 content 里只出现一次时返回它的位置，没有或不止一处返回 -1。 */
function uniqueIndex(content: string, text: string): number {
  if (!text) return -1
  const first = content.indexOf(text)
  return first >= 0 && !content.includes(text, first + 1) ? first : -1
}

/** 仅提供定位建议；原文和相邻唯一行保持不变仍不能证明编辑意图。 */
export function suggestProjectEditLocations(
  previous: ProjectEditView,
  edits: readonly ProjectContentEdit[],
  current: string
): ProjectRelocatedEdit[] | undefined {
  const oldSource = createProjectSourceCoordinates(previous.content)
  const newSource = createProjectSourceCoordinates(current)
  const candidates: ProjectRelocatedEdit[] = []
  for (const [editIndex, edit] of edits.entries()) {
    const selector =
      edit.op === 'insert' && !('at' in edit)
        ? { op: 'replace' as const, range: edit.range, match: edit.match, text: '' }
        : edit
    const target = selectProjectMutations(previous, [selector])[0]
    const [startLine, endLine] =
      !('at' in edit) && !isUndefined(edit.range)
        ? normalizeProjectLineRange(edit.range)
        : [
            sourceLineAt(oldSource, target.start),
            sourceLineAt(oldSource, Math.max(target.start, target.end - 1)),
          ]
    const contextStart = oldSource.lines[Math.max(0, startLine - 2)].start
    const contextEnd = oldSource.lines[Math.min(oldSource.lines.length - 1, endLine)].end
    const original = previous.content.slice(contextStart, contextEnd)
    if (uniqueIndex(previous.content, original) < 0) return undefined
    const at = uniqueIndex(current, original)
    if (at < 0) return undefined
    const start = at + oldSource.lines[startLine - 1].start - contextStart
    const end = at + oldSource.lines[endLine - 1].bodyEnd - contextStart
    if ('at' in edit) {
      const boundary = at + target.start - contextStart
      if (boundary !== (edit.at === 'start' ? 0 : current.length)) return undefined
    }
    const first = sourceLineAt(newSource, start)
    const last = sourceLineAt(newSource, Math.max(start, end - 1))
    candidates.push({ editIndex, range: first === last ? first : [first, last], unchanged: true })
  }
  return candidates
}
