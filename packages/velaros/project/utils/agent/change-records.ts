/**
 * edit、inspect、undo 共用的几步：取回 fileRef 原来看得到的整行、凭 changeRef 取回事务。
 */

import { isString, Log } from '@velaros-ai/core'

import type { ProjectOperationContext } from '../../contract/requires.js'
import type { LineSpan } from '../../types/agent.js'
import type { ProjectEditInput } from '../../types/files.js'
import { ProjectError } from '../errors.js'

import { loadFileView, readReceipt } from './file-refs.js'

const log = Log.tag('ProjectChangeRecords')

/** 这次编辑凭的 fileRef 原来看得到哪些整行：改完之后沿补丁链迁过去，回执窗口照样给程序看这些地方。 */
export async function seenFileSpans(steps: ProjectEditInput['steps'], ctx: ProjectOperationContext): Promise<Record<string, LineSpan[]>> {
  const spans: Record<string, LineSpan[]> = {}
  for (const step of steps) {
    if (!('fileRef' in step) || !isString(step.fileRef)) continue
    try {
      const view = await loadFileView(ctx, step.fileRef)
      const lines = view.coverage.filter((region) => region.completeLines).map(({ startLine, endLine }) => ({ startLine, endLine }))
      spans[view.path] = [...(spans[view.path] ?? []), ...lines]
    } catch (error) {
      log.debug('fileRef 的可见范围取不回来，回执窗口只看改动处', { error: String(error) })
    }
  }
  return spans
}

/** 凭 changeRef 取回事务号与提交前后的版本；取不回来时什么都没做，照实说。 */
export function changeRecordOf(changeRef: string, ctx: ProjectOperationContext): { transactionId: string; oldRevisions?: Record<string, string>; newRevisions?: Record<string, string> } {
  return readReceipt(ctx, 'change', changeRef) as { transactionId: string; oldRevisions?: Record<string, string>; newRevisions?: Record<string, string> }
}

/** 从内核取事务；已经不在（重启过、超过保留条数）时说清楚它不能再 inspect、undo。 */
export async function changeTransactionOf(ctx: ProjectOperationContext, transactionId: string, changeRef: string) {
  const transaction = (await ctx.project.kernel()).getTransaction(transactionId)
  if (!transaction) {
    throw new ProjectError('TARGET_NOT_FOUND', '这次改动的记录已经不在内核里（重启过，或者超过了保留条数）。', { changeRef },
      '它不能再 inspect、undo 了：改动本身还在，要撤就用 git，或者再 edit 一次改回去。')
  }
  return transaction
}
