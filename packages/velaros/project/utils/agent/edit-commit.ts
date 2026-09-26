/**
 * 一次 edit 的规划与提交：规划、交内核准备与提交、编回执。排队的项目资源门在执行类里套，这里不管。
 */

import { isEmpty, isPlainObject, optionalWhen } from '@velaros-ai/core'

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
 * 提交失败时丢掉事务，一个文件都没写。
 */
export async function commitProjectEdit(
  steps: ProjectPlanInput['steps'],
  ctx: ProjectOperationContext
): Promise<ProjectEditResult> {
  const plan = (await compileProjectEdit({ steps }, projectPlannerResolver(ctx)).catch(
    rethrowNotApplied
  )) as PrepareEditInput
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
    const applied = await kernel.applyEdit({ transactionId: prepared.transactionId })
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
      files: await changeWindows(ctx, final.patches, applied.newRevisions),
      diff: final.diff,
      diffLines: final.changedLines,
    }
    if (recode) receipt.recode = recode
    return receipt
  } catch (error) {
    kernel.discardTransaction(prepared.transactionId)
    throw error
  }
}
