import { isEmpty } from '@velaros-ai/core'

import { ProjectError } from '../../errors.js'
import type { PrepareEditInput } from '../../types/edit.js'
import { type ProjectResolvedMutation, selectProjectMutations } from '../selectors/select.js'
import type { ProjectEditInput, ProjectEditView, ProjectPlannerResolver } from '../types.js'

import { applyProjectMutations } from './content.js'

export async function compileProjectEdit(input: ProjectEditInput, resolver: ProjectPlannerResolver): Promise<PrepareEditInput> {
  if (isEmpty(input.files) || input.files.length > 1000) throw new ProjectError('INVALID_INPUT', 'files 需要 1–1000 个文件分组。')
  const operations: PrepareEditInput['operations'] = []
  const baseRevisions: Record<string, string> = {}
  const paths = new Map<string, { view: ProjectEditView; mutations: ProjectResolvedMutation[] }>()
  for (const [fileIndex, file] of input.files.entries()) {
    try {
      const view = await resolver.resolveFileRef(file.fileRef)
      const previous = paths.get(view.path)
      if (previous && (previous.view.revision !== view.revision || previous.view.content !== view.content)) throw new ProjectError('BASE_REVISION_MISMATCH', '同一文件的所有编辑必须基于同一原始版本。', { path: view.path })
      const mutations = selectProjectMutations(view, file.edits).map((mutation) => ({ ...mutation, fileIndex }))
      if (previous) previous.mutations.push(...mutations)
      else paths.set(view.path, { view, mutations })
      baseRevisions[view.path] = view.revision
    } catch (error) {
      if (!(error instanceof ProjectError)) throw error
      throw new ProjectError(error.reason, error.message, { ...error.details, fileIndex }, error.suggestedNextAction)
    }
  }
  for (const { view, mutations } of paths.values()) operations.push({ operation: {
    type: 'replace_content', path: view.path, expectedContent: view.content, content: applyProjectMutations(view, mutations), mode: 'edit',
  } })
  return { operations, baseRevisions, metadata: { projectContract: 2, tool: 'project:edit' } }
}
