/**
 * 可撤销历史的字节账：一个事务在内存与事务状态文件里占多少字节，按三份分开算（事务本身、它的变更投影、它的字节计划）。
 * 预算在 `ProjectTuning.persistence.historyBytes`，超了由 `TransactionRepository.capBytes` 按「最旧先出」淘汰；
 * 它管的只是历史，还没应用的事务和正在写盘的那一个永远留着——历史大小不能让 apply 失败。
 */

import { isRecord, isString } from '@velaros-ai/core'

import type { ProjectChangeRecordInput } from '../../types/change-feed.js'
import type { StoredTransaction, TransactionBytePlan } from '../../types/transaction.js'

/** 一个字符串字段占多少字节（UTF-8）；缺席算 0。 */
function stringBytes(value: LooseOptional<string>): number {
  return value ? Buffer.byteLength(value, 'utf8') : 0
}

/** 一个事务自己占多少字节：每个补丁的新旧正文与差量、事务差量、基准快照正文。 */
export function storedTransactionBytes(transaction: StoredTransaction): number {
  let bytes = stringBytes(transaction.diff)
  for (const patch of transaction.patches) {
    bytes += stringBytes(patch.oldContent) + stringBytes(patch.newContent) + stringBytes(patch.diff)
  }
  for (const snapshot of transaction.baseSnapshots) bytes += stringBytes(snapshot.content)
  return bytes
}

/** 一条变更投影占多少字节：差量、原因、每个补丁的差量，以及意图里带的正文字段。 */
export function changeProjectionBytes(projection: ProjectChangeRecordInput): number {
  let bytes = stringBytes(projection.diff) + stringBytes(projection.reason)
  for (const patch of projection.patches) bytes += stringBytes(patch.diff)
  for (const intent of projection.intents) {
    if (!isRecord(intent.operation)) continue
    for (const value of Object.values(intent.operation))
      if (isString(value)) bytes += stringBytes(value)
  }
  return bytes
}

/** 一份字节计划占多少字节：每个补丁写前、写后的 base64 原字节。 */
export function transactionBytePlanBytes(plan: TransactionBytePlan): number {
  let bytes = 0
  for (const patch of plan.patches) bytes += stringBytes(patch.before) + stringBytes(patch.after)
  return bytes
}
