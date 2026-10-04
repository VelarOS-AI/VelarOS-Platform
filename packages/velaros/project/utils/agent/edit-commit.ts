/**
 * 一次 edit 的规划与提交：规划、交内核准备与提交、编回执。排队的项目资源门在执行类里套，这里不管。
 */

import { isEmpty, isPlainObject, Log, optionalWhen } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { ProjectOperationContext } from '../../contract/requires.js'
import type { PrepareEditInput } from '../../types/edit.js'
import type {
  ProjectEditResult,
  ProjectPlanInput,
  ProjectRecodeReceipt,
} from '../../types/files.js'
import { compileProjectEdit } from '../editing/planner-index.js'
import { beforeWrite, rethrowNotApplied } from '../transactions/transaction-errors.js'

import { changeWindows } from './change-windows.js'
import { saveReceipt } from './file-refs.js'
import { projectPlannerResolver } from './planner-resolver.js'
import { projectCreatedPaths, projectTransactionHasChanges } from './transaction-result.js'

/**
 * 规划并提交一次改动：规划是纯计算（版本过期时按原意图重新定位）；计划有写入时由内核准备、校验、提交，不问用户。
 * 计划没有写入（全是已经是目标格式的 recode）时不开事务。
 * 仅清理尚未提交的失败事务；提交后的诊断保留回执和恢复身份。
 */
export async function commitProjectEdit(
  steps: ProjectPlanInput['steps'],
  ctx: ProjectOperationContext
): Promise<ProjectEditResult> {
  ctx.abortSignal.throwIfAborted()
  const plan = (await compileProjectEdit({ steps }, projectPlannerResolver(ctx)).catch(
    rethrowNotApplied
  )) as PrepareEditInput
  return commitPreparedProjectEdit(plan, ctx)
}

/** 复用同一事务内核提交已完成定位的计划；摘要请求不读取和构造不需要的变更窗口，原始差量仍在事务账本中。 */
export async function commitPreparedProjectEdit(
  plan: PrepareEditInput,
  ctx: ProjectOperationContext,
  includeWindows = true
): Promise<ProjectEditResult> {
  ctx.abortSignal.throwIfAborted()
  const recode = optionalWhen(
    isPlainObject,
    plan.metadata?.recode
  ) as Optional<ProjectRecodeReceipt>
  if (isEmpty(plan.operations)) {
    const unchanged: ProjectEditResult = {
      changeRef: '',
      transactionId: '',
      changed: false,
      changedFiles: [],
      oldRevisions: {},
      newRevisions: {},
      files: [],
      diff: '',
      diffLines: 0,
      notes: ['没有需要写入的文件，什么都没改（changeRef 为空）。'],
    }
    if (recode) unchanged.recode = recode
    return unchanged
  }
  const kernel = await beforeWrite(() => ctx.project.kernel())
  const prepared = await kernel.prepareEdit(plan).catch(rethrowNotApplied)
  try {
    ctx.abortSignal.throwIfAborted()
    const applied = await kernel.applyEdit(
      { transactionId: prepared.transactionId },
      ctx.abortSignal
    )
    const final = kernel.getTransaction(prepared.transactionId) ?? prepared
    const created = projectCreatedPaths(final.patches)
    const receipt: ProjectEditResult = {
      changeRef: saveReceipt(ctx, 'change', {
        transactionId: prepared.transactionId,
        oldRevisions: applied.oldRevisions,
        newRevisions: applied.newRevisions,
      }),
      transactionId: prepared.transactionId,
      changed: projectTransactionHasChanges(final.patches),
      changedFiles: applied.changedFiles,
      // 界面按「不在 oldRevisions 里」认出新建的文件；内核对不存在的路径也给 revision，所以新建的要剔掉。
      oldRevisions: Object.fromEntries(
        Object.entries(applied.oldRevisions).filter(([path]) => !created.has(path))
      ),
      newRevisions: applied.newRevisions,
      files: [],
      diff: final.diff,
      diffLines: final.changedLines,
    }
    if (applied.notes?.length) receipt.notes = [...applied.notes]
    try {
      if (includeWindows)
        receipt.files = await changeWindows(ctx, final.patches, applied.newRevisions)
    } catch (error) {
      const failure = AppError.from(error)
      Log.tag('ProjectEdit').warn('已提交事务的变更窗口读取失败', {
        transactionId: prepared.transactionId,
        changeRef: receipt.changeRef,
        error,
      })
      receipt.notes = [
        ...(receipt.notes ?? []),
        `文件已提交；读取变更窗口失败 [${failure.code}] ${failure.message}`,
      ]
    }
    if (recode) receipt.recode = recode
    return receipt
  } catch (error) {
    const status = kernel.getTransaction(prepared.transactionId)?.status
    if (status === 'applied' || status === 'rolled_back') {
      const changeRef = saveReceipt(ctx, 'change', { transactionId: prepared.transactionId })
      const failure = AppError.from(error)
      throw new AppError(
        failure.code,
        `事务 ${prepared.transactionId} 已${status === 'applied' ? '提交' : '撤销'}，恢复引用 ${changeRef}；附带步骤失败 [${failure.code}] ${failure.message}`,
        error,
        { executionOutcome: status, transactionId: prepared.transactionId, changeRef }
      )
    }
    try {
      kernel.discardTransaction(prepared.transactionId)
    } catch (cleanupError) {
      Log.tag('ProjectEdit').warn('failed transaction cleanup failed', {
        transactionId: prepared.transactionId,
        error: cleanupError,
      })
    }
    throw error
  }
}
