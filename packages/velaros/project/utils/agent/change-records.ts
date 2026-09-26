/**
 * inspect、undo 共用的一步：凭 changeRef 取回事务。
 */

import type { ProjectOperationContext } from '../../contract/requires.js'
import { ProjectError } from '../errors.js'

import { readReceipt } from './file-refs.js'

/** 凭 changeRef 取回事务号与提交前后的版本；取不回来时什么都没做，照实说。 */
export function changeRecordOf(
  changeRef: string,
  ctx: ProjectOperationContext
): {
  transactionId: string
  oldRevisions?: Record<string, string>
  newRevisions?: Record<string, string>
} {
  return readReceipt(ctx, 'change', changeRef) as {
    transactionId: string
    oldRevisions?: Record<string, string>
    newRevisions?: Record<string, string>
  }
}

/** 从内核取事务；已经不在（重启过、超过保留条数）时说清楚它不能再 inspect、undo。 */
export async function changeTransactionOf(
  ctx: ProjectOperationContext,
  transactionId: string,
  changeRef: string
) {
  const transaction = (await ctx.project.kernel()).getTransaction(transactionId)
  if (!transaction) {
    throw new ProjectError(
      'TARGET_NOT_FOUND',
      '这次改动的记录已经不在内核里（重启过，或者超过了保留条数）。',
      { changeRef },
      '它不能再 inspect、undo 了：改动本身还在，要撤就用 git，或者再 edit 一次改回去。'
    )
  }
  return transaction
}
