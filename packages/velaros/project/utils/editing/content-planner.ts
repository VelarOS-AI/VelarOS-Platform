import type { ProjectEditView, ProjectResolvedMutation } from '../../types/editing.js'
import type { ProjectContentEdit } from '../../types/files.js'
import { ProjectError } from '../errors.js'

import { selectProjectMutations } from './select.js'

/** 核对同一原始版本上的拼接互不重叠：替换范围不能交叠，插入点不能落在替换内部；冲突时报出两边的编辑序号。 */
function assertDisjoint(mutations: readonly ProjectResolvedMutation[], path: string): void {
  const replacements = mutations
    .filter((change) => change.kind === 'replace')
    .sort((left, right) => left.start - right.start || left.end - right.end)
  for (let index = 1; index < replacements.length; index += 1) {
    if (
      replacements[index].start < replacements[index - 1].end ||
      replacements[index].start === replacements[index - 1].start
    ) {
      throw new ProjectError('INVALID_INPUT', '同一原始版本的替换范围重叠，请合并编辑。', {
        path,
        editIndex: replacements[index].editIndex,
        fileIndex: replacements[index].fileIndex,
        conflictsWith: replacements[index - 1].editIndex,
        conflictsWithFile: replacements[index - 1].fileIndex,
      })
    }
  }
  let candidate = 0
  for (const insertion of mutations
    .filter((change) => change.kind === 'insert')
    .sort((left, right) => left.start - right.start)) {
    while (candidate < replacements.length && replacements[candidate].end < insertion.start)
      candidate += 1
    const replacement = replacements[candidate]
    if (
      replacement &&
      ((replacement.start < insertion.start && insertion.start < replacement.end) ||
        (replacement.start === replacement.end && replacement.start === insertion.start))
    ) {
      throw new ProjectError('INVALID_INPUT', '插入位置落在同批替换内部，请合并编辑。', {
        path,
        editIndex: insertion.editIndex,
        fileIndex: insertion.fileIndex,
        conflictsWith: replacement.editIndex,
        conflictsWithFile: replacement.fileIndex,
      })
    }
  }
}

/** 先全部定位再一次拼接：同一文件的每项编辑都用原始坐标，批量再大也不会互相挪位。 */
export function planProjectFileEdits(
  view: ProjectEditView,
  edits: readonly ProjectContentEdit[]
): { content: string; mutations: readonly ProjectResolvedMutation[] } {
  const mutations = selectProjectMutations(view, edits)
  return { content: applyProjectMutations(view, mutations), mutations }
}

/** 按起点排序拼接；同一起点的插入排在替换之前，同类的保持原顺序。 */
export function orderProjectMutations(
  mutations: readonly ProjectResolvedMutation[]
): ProjectResolvedMutation[] {
  return mutations
    .map((mutation, order) => ({ mutation, order }))
    .sort(
      (left, right) =>
        left.mutation.start - right.mutation.start ||
        (left.mutation.kind === right.mutation.kind
          ? left.order - right.order
          : left.mutation.kind === 'insert'
            ? -1
            : 1)
    )
    .map(({ mutation }) => mutation)
}

/** 把一组已定位的拼接落到原文上；各组的可见窗口可以不同，每项拼接都已按它自己那份视图核对过覆盖范围。 */
export function applyProjectMutations(
  view: ProjectEditView,
  mutations: readonly ProjectResolvedMutation[]
): string {
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
