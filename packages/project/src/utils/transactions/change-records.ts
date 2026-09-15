/** 变更记录的纯函数：复制、校验落盘行、从补丁取记录要的字段、规整事务号。 */

import { isArray, isNumber, isObject, isString } from '@velaros-ai/core'

import { ProjectTransactionLimits } from '../../contract/constants.js'
import type { ProjectChangePatch, ProjectChangeRecord } from '../../types/change-feed.js'
import type { PreparedPatch } from '../../types/edit.js'
import { ProjectError } from '../errors.js'

/** 深拷贝一条变更记录：记录进出变更记录时都复制，外面改不到里面存的那份。 */
export function cloneChange(change: ProjectChangeRecord): ProjectChangeRecord {
  return structuredClone(change)
}

/** 判断落盘文件里读出的一行是不是完整的变更记录：事务号、序号、生命周期、意图、补丁、改动文件、差量、风险、版本和时间戳都在。 */
export function isProjectChangeRecord(value: unknown): value is ProjectChangeRecord {
  if (!isObject(value)) return false
  const record = value as Partial<ProjectChangeRecord>
  return (
    isString(record.transactionId) &&
    Number.isSafeInteger(record.sequence) &&
    isString(record.lifecycle) &&
    isArray(record.intents) &&
    isArray(record.patches) &&
    isArray(record.changedFiles) &&
    isString(record.diff) &&
    isNumber(record.changedLines) &&
    isString(record.risk) &&
    isArray(record.revisions) &&
    isNumber(record.createdAt) &&
    isNumber(record.updatedAt)
  )
}

/** 从事务的补丁里取变更记录要的字段：补丁号、策略、路径、基准版本、差量、改动行数、风险和编辑动作名。 */
export function projectChangePatches(
  patches: readonly PreparedPatch[],
): readonly ProjectChangePatch[] {
  return patches.map((patch) => ({
    patchId: patch.patchId,
    strategyId: patch.strategyId,
    path: patch.path,
    baseRevision: patch.baseRevision,
    diff: patch.diff,
    changedLines: patch.changedLines,
    risk: patch.risk,
    operation: isString(patch.metadata?.op) ? patch.metadata.op : undefined,
  }))
}

/** 规整外面传进来的事务号：必须是非空、不超过上限字节数的字符串，去掉首尾空白后返回；不合规抛 INVALID_INPUT。 */
export function normalizeTransactionId(value: unknown): string {
  if (!isString(value) || new TextEncoder().encode(value).byteLength > ProjectTransactionLimits.transactionIdBytes) {
    throw new ProjectError('INVALID_INPUT', `transactionId 必须是不超过 ${ProjectTransactionLimits.transactionIdBytes} 字节的非空字符串。`)
  }
  const normalized = value.trim()
  if (!normalized) throw new ProjectError('INVALID_INPUT', 'transactionId 不能为空。')
  return normalized
}
