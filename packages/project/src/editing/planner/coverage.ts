import type { ProjectResolvedMutation } from '../selectors/select.js'
import { ProjectSourceCoordinates } from '../selectors/source.js'
import type { ProjectEditView, ProjectVisibleCoverage } from '../types.js'

import { orderProjectMutations } from './content.js'

interface Window { start: number; end: number }

export function completeProjectCoverage(content: string): ProjectVisibleCoverage[] {
  const source = new ProjectSourceCoordinates(content)
  return [{ startOffset: 0, endOffset: content.length, startLine: 1, endLine: source.lines.length, completeLines: true }]
}

/** Preserve knowledge of unchanged visible text and add only text generated in this plan. */
export function advanceProjectCoverage(view: ProjectEditView, content: string, mutations: readonly ProjectResolvedMutation[]): ProjectVisibleCoverage[] {
  const ordered = orderProjectMutations(mutations)
  const known: Window[] = []
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
  const merged: Window[] = []
  for (const window of known) {
    const previous = merged.at(-1)
    if (previous && previous.end >= window.start) previous.end = Math.max(previous.end, window.end)
    else merged.push({ ...window })
  }
  const source = new ProjectSourceCoordinates(content)
  const coverage: ProjectVisibleCoverage[] = []
  for (const window of merged) {
    const first = source.lineAt(window.start)
    const last = source.lineAt(window.end)
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
