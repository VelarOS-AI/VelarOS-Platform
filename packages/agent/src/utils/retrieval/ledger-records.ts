// 在驻留账本里按模型手里的 ref 找回那条记录。
// 全保真层被 GC 之后，账本往往还留着原文，这条路是召回的最后兜底。纯函数，不记状态，调用方传入账本视图。

import type { ResidencyLedgerView } from '../../types/residency.js'
import type { ResolvedLedgerRecord } from '../../types/retrieval.js'

/**
 * 按一个 ref 在账本里定位记录：认记录 id、`payloadRef`、`toolCallId`（带不带 `tool:` 前缀都行）和折叠信封的 `excerpt.ref`——
 * 口径必须和 `ContextGovernanceSession.recordFault` 记缺页时认的那几种逐条对齐，否则会出现「记了 fault 却取不回」的错位。
 *
 * 命中优先级：先直查记录 id；再从**新往旧**扫（同一个 toolCallId 会同时挂在 tool-call 和 tool-result 两条记录上，
 * 正序扫必然先撞上只有参数没有正文的那条，而模型要的是结果）；一条 role:'tool' 消息里装了多份结果时，
 * 命中哪一份就用**那一份**自己的 payloadRef，不能回退到记录级 ref（否则第 2..N 份都会指向第一份的正文）。
 * 都没命中、或 ref 去掉空白后为空时返回 null。
 */
export function findLedgerRecordByRef(
  ledger: ResidencyLedgerView,
  ref: string,
): Nullable<ResolvedLedgerRecord> {
  const key = ref.trim()
  if (!key) return null

  const direct = ledger.get(key)
  if (direct)
    return {
      record: direct,
      payloadRef: direct.payloadRef,
      toolCallId: direct.toolCallId,
      toolName: direct.toolName,
    }

  const bare = key.startsWith('tool:') ? key.slice('tool:'.length) : key
  const records = ledger.list()
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]!
    if (record.payloadRef === key || record.excerpt?.ref === key)
      return {
        record,
        payloadRef: record.payloadRef,
        toolCallId: record.toolCallId,
        toolName: record.toolName,
      }

    const part = record.toolParts.find(
      (candidate) =>
        candidate.toolCallId === bare ||
        candidate.payloadRef === key ||
        candidate.excerpt?.ref === key,
    )
    if (part)
      return {
        record,
        payloadRef: part.payloadRef,
        toolCallId: part.toolCallId,
        toolName: part.toolName,
      }
    if (record.toolCallId === bare)
      return {
        record,
        payloadRef: record.payloadRef,
        toolCallId: record.toolCallId,
        toolName: record.toolName,
      }
  }

  return null
}
