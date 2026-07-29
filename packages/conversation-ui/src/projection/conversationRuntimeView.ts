import type { ChatStatusRuntime } from '../status/chatStatus'

import type {
  StreamUsageTelemetryPayload,
  UserActionCard,
  WorkspaceAutoApprovalNotice,
} from '#contracts'

/**
 * `ConversationStickyDockItem` — 会话顶栏坞项的**渲染切片投影**（镜像宿主 `StickyDockItem` 联合，
 * 全部经 Conversation UI 自有纯展示基元表达；宿主结构可赋值）。会话壳按 `kind` 分发到 `stickyDockItemContent`
 * slot（user-action-card / workspace-auto-approval）或包内 PlanToolRender（plan-update）。
 */
export type ConversationStickyDockItem =
  | { kind: 'workspace-auto-approval'; id: string; createdAt: number; notice: WorkspaceAutoApprovalNotice }
  | { kind: 'plan-update'; id: string; createdAt: number; summary: string }
  | { kind: 'user-action-card'; id: string; createdAt: number; card: UserActionCard }

/**
 * `ConversationRuntimeView` — 宿主 `ChatRuntimeState` 的**运行态渲染切片投影**（pass-4 会话壳収口）。
 *
 * §12.8「按域投影非整桶透传」：在既有窄投影 `ChatStatusRuntime`（状态渲染面）之上，只**追加会话壳
 * 实际读取**的运行态字段（顶栏坞项 / 等待确认卡 / run 窗口时间戳 / 用量遥测）。宿主 `ChatRuntimeState`
 * 是结构超集，直接满足本契约；desktop 边界 `build-ConversationView` 从权威源装配，WS2 后只改边界映射。
 * 深宿主运行态字段（contextCompaction / handoffSuggestion / evidenceLedger 等治理面）**不整桶拉进包**。
 */
export interface ConversationRuntimeView extends ChatStatusRuntime {
  stickyDockItems: ConversationStickyDockItem[]
  awaitingConfirmationUserActionCards: UserActionCard[]
  awaitingConfirmationExecutionId: Nullable<string>
  lastRunFinishedAt: Nullable<number>
  usageTelemetry: StreamUsageTelemetryPayload[]
}
