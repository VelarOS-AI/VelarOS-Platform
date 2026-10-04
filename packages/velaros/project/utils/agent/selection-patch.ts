/** 已绑定目标批量拼接：各文件共享原始坐标，复用现有规划器和事务提交，不逐项写盘。 */
import { randomUUID } from 'node:crypto'

import { isEmpty, isNumber, isUndefined } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { ProjectOperationContext } from '../../contract/requires.js'
import type { PrepareEditInput } from '../../types/edit.js'
import type { ProjectFileView } from '../../types/file-refs.js'
import type { ProjectContentEdit } from '../../types/files.js'
import type {
  ProjectPatchDraft,
  ProjectPatchIssue,
  ProjectPatchResult,
} from '../../types/selection.js'
import { planProjectFileEdits } from '../editing/content-planner.js'
import { ProjectError } from '../errors.js'

import { commitPreparedProjectEdit } from './edit-commit.js'
import { consumeReceipt, resolveFileRef, saveReceipt } from './file-refs.js'
import { patchInput } from './selection-input.js'
import { loadSelection } from './selection-refs.js'

/** 定位阶段只有已知领域失败可汇总；取消、未知宿主故障必须抛回调用方。 */
function patchIssue(error: unknown, index?: number): ProjectPatchIssue {
  if (error instanceof ProjectError) {
    const issue: ProjectPatchIssue = { code: error.reason, message: error.message }
    if (!isUndefined(index)) issue.index = index
    if (error.details) issue.details = error.details
    if (error.suggestedNextAction) issue.next = error.suggestedNextAction
    return issue
  }
  throw error
}

/** 未写入计划可恢复；引用依旧受到根、会话、可见范围和版本核对。 */
function blocked(
  ctx: ProjectOperationContext,
  draft: ProjectPatchDraft,
  issues: ProjectPatchIssue[]
): ProjectPatchResult {
  return {
    status: 'blocked',
    executionOutcome: 'not-applied',
    planRef: saveReceipt(ctx, 'plan', { ...structuredClone(draft), nonce: randomUUID() }),
    issues,
  }
}

/** 全部定位并验证每个文件后才进入事务；复核一次文件正文，不为每个目标重复读取。 */
export async function patchSelections(
  input: unknown,
  ctx: ProjectOperationContext
): Promise<ProjectPatchResult> {
  const { draft, previous } = patchInput(input, ctx)
  const issues: ProjectPatchIssue[] = []
  const current = new Map<string, Promise<ProjectFileView>>()
  const groups = new Map<
    string,
    { view: ProjectFileView; edits: ProjectContentEdit[]; indices: number[] }
  >()
  for (const [index, edit] of draft.edits.entries()) {
    ctx.abortSignal.throwIfAborted()
    if (!edit) continue
    try {
      const { record, view } = await loadSelection(ctx, edit.target)
      const key = `${view.path}:${view.contentRevision}`
      if (!current.has(key)) current.set(key, resolveFileRef(ctx, record.fileRef))
      const checked = await current.get(key)!
      // 同一文件可能来自多个独立窗口，合并的只是每个已签发目标的覆盖，不能填补中间间隙。
      const group = groups.get(view.path) ?? {
        view: { ...checked, coverage: [] },
        edits: [],
        indices: [],
      }
      if (group.view.contentRevision !== view.contentRevision)
        throw new ProjectError('BASE_REVISION_MISMATCH', '同文件的目标不属于同一原始版本。', {
          path: view.path,
        })
      group.view.coverage.push(...view.coverage)
      const span = {
        start: record.start,
        end: record.end,
        lines: record.lines && (record.kind === 'lines' || record.kind === 'symbol'),
      }
      group.edits.push(
        edit.op === 'before' || edit.op === 'after'
          ? { op: 'insert', side: edit.op, span, text: edit.text }
          : { op: 'replace', span, text: edit.text }
      )
      group.indices.push(index)
      groups.set(view.path, group)
      // @arch-guard:suspend code-style/require-error-logging 理由：已知领域异常转为 issues 回执；patchIssue 将未知异常重抛。
    } catch (error) {
      issues.push(patchIssue(error, index))
    }
  }
  const plan: PrepareEditInput = {
    operations: [],
    baseRevisions: {},
    metadata: { source: 'velaros:project', selectionPatch: true },
  }
  for (const { view, edits, indices } of groups.values()) {
    ctx.abortSignal.throwIfAborted()
    try {
      const { content } = planProjectFileEdits(view, edits)
      plan.baseRevisions![view.path] = view.revision
      plan.operations.push({
        operation: {
          type: 'replace_content',
          path: view.path,
          expectedContent: view.content,
          content,
          mode: 'edit',
        },
      })
      // @arch-guard:suspend code-style/require-error-logging 理由：已知领域异常转为 issues 回执；patchIssue 将未知异常重抛。
    } catch (error) {
      const issue = patchIssue(error)
      const at = issue.details?.editIndex
      if (isNumber(at)) issue.index = indices[at]
      const other = issue.details?.conflictsWith
      if (isNumber(other)) issue.details = { ...issue.details, conflictsWithIndex: indices[other] }
      issues.push(issue)
    }
  }
  if (!isEmpty(issues)) return blocked(ctx, draft, issues)
  let result
  try {
    result = await commitPreparedProjectEdit(plan, ctx, draft.receipt === 'full')
  } catch (error) {
    // 只有明确未写入的校验/冲突才成为可增量修正的 blocked；提交或恢复状态不明仍走原错误边界。
    if (error instanceof ProjectError && error.details?.executionOutcome === 'not-applied')
      return blocked(ctx, draft, [patchIssue(error)])
    if (
      error instanceof AppError &&
      error.context?.executionOutcome === 'not-applied' &&
      !['CANCELLED', 'TIMEOUT'].includes(error.code)
    )
      return blocked(ctx, draft, [
        { code: error.code, message: error.message, details: error.context },
      ])
    throw error
  }
  if (previous) consumeReceipt(ctx, 'plan', previous)
  if (draft.receipt === 'full') return { status: 'applied', ...result }
  const { files: _files, diff: _diff, ...summary } = result
  return { status: 'applied', ...summary }
}
