import type { ChatStatusRuntime } from '../status/chatStatus'

import type {
  ConfirmationRequestDetail,
  ProjectAutoApprovalNotice,
  StreamUsageTelemetryPayload,
  UserActionCard,
} from '#contracts'

/**
 * `ConversationStickyDockItem` — 会话顶栏坞项的**渲染切片投影**（镜像宿主 `StickyDockItem` 联合，
 * 全部经 Conversation UI 自有纯展示基元表达；宿主结构可赋值）。会话壳按 `kind` 分发到 `stickyDockItemContent`
 * slot（user-action-card / project-auto-approval）或包内 PlanToolRender（plan-update）。
 */
export type ConversationStickyDockItem =
  | { kind: 'project-auto-approval'; id: string; createdAt: number; notice: ProjectAutoApprovalNotice }
  | { kind: 'plan-update'; id: string; createdAt: number; summary: string }
  | { kind: 'user-action-card'; id: string; createdAt: number; card: UserActionCard }
  /** 宿主自有的会话转交建议卡：批准即建新会话，身份必须是声明式的，不能靠 id 前缀嗅。 */
  | { kind: 'handoff-suggestion'; id: string; createdAt: number; card: UserActionCard }

/**
 * `ConversationRuntimeView` — 宿主 `ChatRuntimeState` 的**运行态渲染切片投影**（pass-4 会话壳収口）。
 *
 * §12.8「按域投影非整桶透传」：在既有窄投影 `ChatStatusRuntime`（状态渲染面）之上，只**追加会话壳
 * 实际读取**的运行态字段（顶栏坞项 / 等待确认卡 / run 窗口时间戳 / 用量遥测）。宿主 `ChatRuntimeState`
 * 是结构超集，直接满足本契约；desktop 边界 `build-ConversationView` 从权威源装配，WS2 后只改边界映射。
 * 深宿主运行态字段（contextCompaction / handoffSuggestion 等治理面）**不整桶拉进包**。
 */
export interface ConversationRuntimeView extends ChatStatusRuntime {
  stickyDockItems: ConversationStickyDockItem[]
  awaitingConfirmationUserActionCards: UserActionCard[]
  awaitingConfirmationExecutionId: Nullable<string>
  /** 等待确认的结构化信封；缺席时确认卡按 `awaitingConfirmationMessage` 散文渲染。 */
  awaitingConfirmationDetail: Nullable<ConfirmationRequestDetail>
  lastRunFinishedAt: Nullable<number>
  usageTelemetry: StreamUsageTelemetryPayload[]
}
