import type { ChatStatusRuntime } from '../status/chatStatus'

import type {
  ConfirmationRequestDetail,
  ProjectAutoApprovalNotice,
  StreamUsageTelemetryPayload,
  UserActionCard,
} from '#contracts'

/**
 * 会话正文卡片的渲染切片投影。这里只承载宿主或工具产生的卡片内容，
 * 不表达停靠位置；Plan / Goal 的 sticky dock 由会话壳根据权威状态自行派生。
 */
export type ConversationCardItem =
  | { kind: 'project-auto-approval'; id: string; createdAt: number; notice: ProjectAutoApprovalNotice }
  /** 宿主自有的会话转交建议卡：批准即建新会话，身份必须是声明式的，不能靠 id 前缀嗅。 */
  | { kind: 'handoff-suggestion'; id: string; createdAt: number; card: UserActionCard }

/** @deprecated 仅供已发布的旧宿主完成跨版本升级；新代码使用 `ConversationCardItem`。 */
export type ConversationStickyDockItem = ConversationCardItem

/**
 * `ConversationRuntimeView` — 宿主 `ChatRuntimeState` 的**运行态渲染切片投影**（pass-4 会话壳収口）。
 *
 * §12.8「按域投影非整桶透传」：在既有窄投影 `ChatStatusRuntime`（状态渲染面）之上，只**追加会话壳
 * 实际读取**的运行态字段（正文卡片 / 等待确认卡 / run 窗口时间戳 / 用量遥测）。宿主 `ChatRuntimeState`
 * 是结构超集，直接满足本契约；desktop 边界 `build-ConversationView` 从权威源装配，WS2 后只改边界映射。
 * 深宿主运行态字段（contextCompaction / handoffSuggestion 等治理面）**不整桶拉进包**。
 */
export interface ConversationRuntimeView extends ChatStatusRuntime {
  conversationCards: ConversationCardItem[]
  /** @deprecated 旧宿主的读取兼容镜像；会话壳不会据此决定卡片位置。 */
  stickyDockItems?: ConversationCardItem[]
  awaitingConfirmationUserActionCards: UserActionCard[]
  awaitingConfirmationExecutionId: Nullable<string>
  /** 等待确认的结构化信封；缺席时确认卡按 `awaitingConfirmationMessage` 散文渲染。 */
  awaitingConfirmationDetail: Nullable<ConfirmationRequestDetail>
  lastRunFinishedAt: Nullable<number>
  usageTelemetry: StreamUsageTelemetryPayload[]
}
