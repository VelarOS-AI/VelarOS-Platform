import { ProjectError } from '../../errors.js'
import { type ProjectResolvedMutation, selectProjectMutations } from '../selectors/select.js'
import type { ProjectContentEdit, ProjectEditView } from '../types.js'

function assertDisjoint(mutations: readonly ProjectResolvedMutation[], path: string): void {
  const replacements = mutations.filter((change) => change.kind === 'replace').sort((left, right) => left.start - right.start || left.end - right.end)
  for (let index = 1; index < replacements.length; index += 1) {
    if (replacements[index].start < replacements[index - 1].end || replacements[index].start === replacements[index - 1].start) {
      throw new ProjectError('INVALID_INPUT', '同一原始版本的替换范围重叠，请合并编辑。', { path, editIndex: replacements[index].editIndex, fileIndex: replacements[index].fileIndex, conflictsWith: replacements[index - 1].editIndex, conflictsWithFile: replacements[index - 1].fileIndex })
    }
  }
  let candidate = 0
  for (const insertion of mutations.filter((change) => change.kind === 'insert').sort((left, right) => left.start - right.start)) {
    while (candidate < replacements.length && replacements[candidate].end < insertion.start) candidate += 1
    const replacement = replacements[candidate]
    if (replacement && ((replacement.start < insertion.start && insertion.start < replacement.end) || (replacement.start === replacement.end && replacement.start === insertion.start))) {
      throw new ProjectError('INVALID_INPUT', '插入位置落在同批替换内部，请合并编辑。', { path, editIndex: insertion.editIndex, fileIndex: insertion.fileIndex, conflictsWith: replacement.editIndex, conflictsWithFile: replacement.fileIndex })
    }
  }
}

/** Resolve first, then splice once: every edit uses original coordinates, even in a large batch. */
export function planProjectFileEdits(view: ProjectEditView, edits: readonly ProjectContentEdit[]): { content: string; mutations: readonly ProjectResolvedMutation[] } {
  const mutations = selectProjectMutations(view, edits)
  return { content: applyProjectMutations(view, mutations), mutations }
}

export function orderProjectMutations(mutations: readonly ProjectResolvedMutation[]): ProjectResolvedMutation[] {
  return mutations.map((mutation, order) => ({ mutation, order })).sort((left, right) =>
    left.mutation.start - right.mutation.start ||
    (left.mutation.kind === right.mutation.kind ? left.order - right.order : left.mutation.kind === 'insert' ? -1 : 1)
  ).map(({ mutation }) => mutation)
}

/** Groups may have different visible windows, but each mutation has already passed its own view's coverage check. */
export function applyProjectMutations(view: ProjectEditView, mutations: readonly ProjectResolvedMutation[]): string {
  assertDisjoint(mutations, view.path)
  const ordered = orderProjectMutations(mutations)
  const pieces: string[] = []
  let cursor = 0
  for (const mutation of ordered) {
    pieces.push(view.content.slice(cursor, mutation.start), mutation.text)
    cursor = mutation.end
  }
  pieces.push(view.content.slice(cursor))
  return pieces.join('')
}
