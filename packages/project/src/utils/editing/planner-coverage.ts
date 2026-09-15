import type { PlannerCoverageWindow, ProjectEditView, ProjectResolvedMutation, ProjectVisibleCoverage } from '../../types/editing.js'

import { orderProjectMutations } from './content-planner.js'
import { createProjectSourceCoordinates, sourceLineAt } from './source.js'

/** 整份正文都可见时的覆盖范围：一个从头到尾、整行完整的窗口。 */
export function completeProjectCoverage(content: string): ProjectVisibleCoverage[] {
  const source = createProjectSourceCoordinates(content)
  return [{ startOffset: 0, endOffset: content.length, startLine: 1, endLine: source.lines.length, completeLines: true }]
}

/** 按本计划的拼接推进可见覆盖范围：没改动的可见原文照旧可见，再加上本计划自己写进去的文本，其余仍算没看过。 */
export function advanceProjectCoverage(view: ProjectEditView, content: string, mutations: readonly ProjectResolvedMutation[]): ProjectVisibleCoverage[] {
  const ordered = orderProjectMutations(mutations)
  const known: PlannerCoverageWindow[] = []
  let oldCursor = 0
  let newCursor = 0
  const copyKnown = (end: number) => {
    for (const window of view.coverage) {
      const start = Math.max(oldCursor, window.startOffset)
      const stop = Math.min(end, window.endOffset)
      if (stop >= start) known.push({ start: newCursor + start - oldCursor, end: newCursor + stop - oldCursor })
    }
    newCursor += end - oldCursor
    oldCursor = end
  }
  for (const mutation of ordered) {
    copyKnown(mutation.start)
    known.push({ start: newCursor, end: newCursor + mutation.text.length })
    newCursor += mutation.text.length
    oldCursor = mutation.end
  }
  copyKnown(view.content.length)
  known.sort((left, right) => left.start - right.start || left.end - right.end)
  const merged: PlannerCoverageWindow[] = []
  for (const window of known) {
    const previous = merged.at(-1)
    if (previous && previous.end >= window.start) previous.end = Math.max(previous.end, window.end)
    else merged.push({ ...window })
  }
  const source = createProjectSourceCoordinates(content)
  const coverage: ProjectVisibleCoverage[] = []
  for (const window of merged) {
    const first = sourceLineAt(source, window.start)
    const last = sourceLineAt(source, window.end)
    for (let number = first; number <= last; number += 1) {
      const line = source.lines[number - 1]
      const start = Math.max(window.start, line.start)
      const end = Math.min(window.end, line.end)
      if (end === start && line.end !== line.start) continue
      coverage.push({ startOffset: start, endOffset: end, startLine: number, endLine: number, completeLines: start === line.start && end === line.end })
    }
  }
  return coverage
}
