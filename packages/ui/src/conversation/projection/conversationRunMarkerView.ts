import type { ConversationRunUsage } from './conversationRunUsage'

import type {
  ProjectCheckpointDiffFailure,
  ProjectCheckpointFileDiff,
  StreamTurnContextPayload,
} from '#contracts'

/**
 * `ConversationRunMarkerView` — 消息运行标记的**渲染切片投影**（MessageStatusMarker / 气泡状态角标消费）。
 *
 * §12.8：只承载渲染读取的字段（status/detail/turnCount/turnKind），不整桶宿主 `ChatMessageRunMarker`
 * （goalMode / workspaceCheckpointDiff / timestamp 等运行态字段留宿主）。status/turnKind 值域镜像宿主枚举。
 */
export type ConversationRunMarkerStatus =
  | 'completed'
  | 'aborted'
  | 'failed'
  | 'awaiting-confirmation'
  | 'awaiting-input'

export type ConversationRunMarkerTurnKind = 'turn' | 'totalTurns'

export interface ConversationVerificationSummary {
  status: 'not-run' | 'stale' | 'passed' | 'failed' | 'timed-out' | 'aborted' | 'unknown'
  command?: string
  issues?: string[]
}

export interface ConversationRunMarkerView {
  verification?: ConversationVerificationSummary
  status: ConversationRunMarkerStatus
  detail: Nullable<string>
  turnCount: Nullable<number>
  turnKind: Nullable<ConversationRunMarkerTurnKind>
}

/**
 * `ConversationMessageRunMarker` — 气泡渲染模型 + memo 相等比较 + transcript 派生所读的运行标记结构面
 * （在 `ConversationRunMarkerView` 之上追加 memo/duration/文件变更卡真正读到的字段）。宿主
 * `ChatMessageRunMarker` 结构可赋值（超型）。窄叶子视图仍是 `ConversationRunMarkerView`（状态角标 / slot）。
 */
export interface ConversationMessageRunMarker extends ConversationRunMarkerView {
  messageId: string
  /** 此消息所属执行的开始时间；随消息标记持久化，后续执行不会覆盖。 */
  startedAt?: number
  /** 此消息所属执行的最终耗时；随消息标记持久化，避免从会话级最新执行时间反推。 */
  durationMs?: number
  goalMode?: boolean
  goalStatus?: 'active' | 'paused' | 'complete' | 'blocked' | 'cancelled' | 'removed'
  workspaceCheckpointDiff?: {
    capturedAt: number
    changes: ProjectCheckpointFileDiff[]
    failedRoots: ProjectCheckpointDiffFailure[]
    error: Nullable<string>
  }
  /**
   * 这次执行的供应方用量账（宿主在执行期间用 `addConversationRunUsageTelemetry` /
   * `addConversationRunSubAgentUsage` 累加，随标记持久化）。缺席时约价从会话的
   * `runtime.usageTelemetry` 按执行时间窗与这次执行消息里的子 Agent 结果推出来。
   */
  usage?: LooseOptional<ConversationRunUsage>
  timestamp: number
}

/**
 * `ConversationTurnContextView` — 回合上下文的**渲染切片投影**（成本估算 messageCostEstimate 消费）。
 *
 * §12.8：只承载成本估算读取的字段（turn/timestamp/roleRuntimeModel），不整桶宿主
 * `ChatTurnContextSnapshot`（systemPrompt / promptSegments / messages 等重字段留宿主）。
 */
export interface ConversationTurnContextView {
  turn: number
  timestamp: number
  roleRuntimeModel: StreamTurnContextPayload['roleRuntimeModel']
}
