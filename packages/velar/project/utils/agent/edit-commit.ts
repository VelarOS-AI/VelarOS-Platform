/**
 * 一次 edit 的规划与提交：规划、过授权、交内核准备与提交、编回执。排队的项目资源门与问用户的审批桥在执行类里套，这里不管。
 */

import { isEmpty, isPlainObject, optionalWhen } from '@velaros-ai/core'

import type { ProjectOperationContext } from '../../contract/requires.js'
import type { PrepareEditInput } from '../../types/edit.js'
import type { ProjectEditInput, ProjectEditResult, ProjectRecodeReceipt } from '../../types/files.js'
import { compileProjectEdit } from '../editing/planner-index.js'
import { plannedFilePaths } from '../transactions/edit-intents.js'
import { rethrowNotApplied } from '../transactions/transaction-errors.js'
import { ProjectTuning } from '../tuning.js'

import { authorizeProjectWrite, seenFileSpans } from './change-records.js'
import { changeWindows } from './change-windows.js'
import { withEditRecovery } from './edit-recovery.js'
import { saveReceipt } from './file-refs.js'
import { projectPlannerResolver } from './planner-resolver.js'
import { projectCreatedPaths, projectTransactionHasChanges } from './transaction-result.js'

/** 差量太长时回执里的那句说明。 */
const TruncatedDiffNote = `差量太长，只给了前 ${ProjectTuning.transactions.receiptDiffChars} 个字符；要看完整结果就 read 改后的文件。`

/**
 * 规划并提交一次改动：规划是纯计算（版本过期时按原意图重新定位）；计划有写入时带着要写的路径过宿主的修改授权，
 * 再由内核准备、校验、提交（回滚不了的高风险写入经审批端口问用户）。计划没有写入（全是已经是目标格式的 recode）时不开事务。
 * 提交失败时丢掉事务，一个文件都没写。
 */
export async function commitProjectEdit(steps: ProjectEditInput['steps'], ctx: ProjectOperationContext): Promise<ProjectEditResult> {
  const plan = await withEditRecovery(steps, ctx, () => compileProjectEdit({ steps }, projectPlannerResolver(ctx)))
    .catch(rethrowNotApplied) as PrepareEditInput
  const recode = optionalWhen(isPlainObject, plan.metadata?.recode) as Optional<ProjectRecodeReceipt>
  if (isEmpty(plan.operations)) {
    const unchanged: ProjectEditResult = {
      changeRef: '', transactionId: '', changed: false, changedFiles: [], oldRevisions: {}, newRevisions: {},
      files: [], diff: '', diffTruncated: false, diffLines: 0,
      notes: ['没有需要写入的文件，什么都没改（changeRef 为空）。'],
    }
    if (recode) unchanged.recode = recode
    return unchanged
  }
  // 规划之后、开事务之前问：确认卡片能列出这次会写哪些文件，被拒时一个字节都没写。
  await authorizeProjectWrite(ctx, '改项目文件', plannedFilePaths(plan.operations))
  const previous = await seenFileSpans(steps, ctx)
  const kernel = await ctx.project.kernel()
  const prepared = await kernel.prepareEdit(plan).catch(rethrowNotApplied)
  try {
    const applied = await kernel.applyEdit({ transactionId: prepared.transactionId })
    const final = kernel.getTransaction(prepared.transactionId) ?? prepared
    const created = projectCreatedPaths(final.patches)
    const diff = final.diff.slice(0, ProjectTuning.transactions.receiptDiffChars)
    const receipt: ProjectEditResult = {
      changeRef: saveReceipt(ctx, 'change', { transactionId: prepared.transactionId, oldRevisions: applied.oldRevisions, newRevisions: applied.newRevisions }),
      transactionId: prepared.transactionId,
      changed: projectTransactionHasChanges(final.patches),
      changedFiles: applied.changedFiles,
      // 界面按「不在 oldRevisions 里」认出新建的文件；内核对不存在的路径也给 revision，所以新建的要剔掉。
      oldRevisions: Object.fromEntries(Object.entries(applied.oldRevisions).filter(([path]) => !created.has(path))),
      newRevisions: applied.newRevisions,
      files: await changeWindows(ctx, final.patches, applied.newRevisions, previous),
      diff,
      diffTruncated: diff.length < final.diff.length,
      diffLines: final.changedLines,
    }
    if (receipt.diffTruncated) receipt.notes = [TruncatedDiffNote]
    if (recode) receipt.recode = recode
    return receipt
  } catch (error) {
    kernel.discardTransaction(prepared.transactionId)
    throw error
  }
}
