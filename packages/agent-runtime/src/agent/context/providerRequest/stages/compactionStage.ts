/**
 * Ring 1 stage ④——compaction（microCompaction 边界 + distill 折叠）。
 *
 * 本编译器里的压缩是 pass 间回收：`compileWithReclaim` 在 okToSend=false 时按 zone reclaimOrder
 * 逐级回收，每级经 `applyProviderRequestReclaimState` 施加——其内含 conversation 级 micro-compact
 * （`enforceConversationScopedToolResultBudget`，保留最近 `MinRecentToolResultsPerConversation`=6 条
 * 工具结果全文，以最后一次 `distill_context` 为消化边界）+ 超大用户文本安全阀 + ContextOS 块剥离。
 * 实测校准常数（最近 6、回收阶梯字符预算）住在 microCompaction / ProviderRequestReclaim 本体，
 * 迁移原样带走，本 stage 一克不重估。
 *
 * CompactionEntry 对齐（宪章 §6 会话树 entry 类型学）：压缩/蒸馏折叠的治理产物终局是带类型的
 * 会话条目，追加进 SessionStore。本批只对齐**类型形状**、不改落盘行为——落盘权威仍在现状机制，
 * WS2 才把此处的折叠摘要真正投影成 CompactionEntry 追加落盘。
 *
 * 权威类型源：`@velaros-ai/agent-protocol` session.ts 的 `CompactionEntry`
 * （`{ type:'compaction', summary:string, replacedEntryIds:string[] }` + 会话 entry 基字段）。
 * 本批不引入 agent-runtime→kernel-protocol 的依赖边（该依赖声明由吸收批统一建立），故此处以
 * 结构镜像声明压缩产物的判别字段与摘要面，待依赖边落定后 WS2 可无缝替换为对 CompactionEntry
 * 的硬 `import type`。
 */
import type { ModelMessage } from 'ai'

import type { CompactionEntry } from '@velaros-ai/agent-protocol'

import type { ProviderHistoryRewriteSignal } from '../../ProviderRequestCompiler'
import {
  applyProviderRequestReclaimState,
  type ProviderRequestReclaimState,
} from '../../ProviderRequestReclaim'

/**
 * 压缩产物的落盘目标形状 = kernel-protocol `CompactionEntry` 的压缩判别面（去掉账本基座字段）。
 * WS2 落盘时以协议 entry 全形为准，本批仅锁定形状、不改行为。
 */
export type ProviderRequestCompactionEntry = Pick<
  CompactionEntry,
  'type' | 'summary' | 'replacedEntryIds'
>

/** 把一次回收动作投影成历史改写签名；未真正改动消息则无签名。 */
export function buildRequestReclaimRewriteSignals(input: {
  attempts: number
  state: ProviderRequestReclaimState
  changed: boolean
}): ProviderHistoryRewriteSignal[] {
  if (!input.changed) return []

  return [
    {
      kind: 'provider-request-reclaim',
      details: {
        attempts: input.attempts,
        state: input.state,
      },
    },
  ]
}

/**
 * pass 间压缩：对上一 pass 的原始消息施加回收态（microCompaction「最近 6」窗口 + 用户文本安全阀
 * + ContextOS 块剥离），并投影本次回收的改写签名。消息未变则签名为空。
 */
export function runProviderRequestCompactionStage(params: {
  originalMessages: ModelMessage[]
  reclaimState: ProviderRequestReclaimState
  attempts: number
}): { messages: ModelMessage[]; rewriteSignals: ProviderHistoryRewriteSignal[] } {
  const messages = applyProviderRequestReclaimState(params.originalMessages, params.reclaimState)
  const rewriteSignals = buildRequestReclaimRewriteSignals({
    attempts: params.attempts,
    state: params.reclaimState,
    changed: messages !== params.originalMessages,
  })

  return { messages, rewriteSignals }
}
