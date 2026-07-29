import type {
  ConversationMessageRunMarker,
  ConversationTurnContextView,
} from './conversationRunMarkerView'
import type { ConversationRuntimeView } from './conversationRuntimeView'
import type { ConversationWorkerThread } from './conversationWorkerThread'

import type {
  ChatMessage,
  ChatProviderId,
  ModelPricingCatalog,
  WorkspaceRootEntry,
} from '#contracts'

/**
 * `ConversationView` — 宿主 `ChatConversationState` 的**渲染切片投影**（会话壳 `ChatConversationPane`，
 * 批 5 步 5 収口件消费）。
 *
 * §12.8「按域投影非整桶透传」：本投影只承载**渲染直接消费**的字段。运行态编排三字段（pass-4 収口补齐）
 * 走窄投影而非整桶宿主 `ChatRuntimeState`：`runtime` → `ConversationRuntimeView`（壳实际读取的运行态切片）、
 * `messageRunMarkers` → `ConversationMessageRunMarker[]`、`turnContexts` → `ConversationTurnContextView[]`。
 * `pricingCatalog` 从 shell 边界穿过（包件不直依宿主 ModelPricingContext）。desktop 边界 `build-ConversationView`
 * 从权威源装配本投影（宿主 `ChatConversationState` 结构可赋值），WS2 权威搬迁后只改边界映射。
 */
export interface ConversationView {
  sessionId: string
  activeMemberSessionId: string
  /**
   * 工作区文件级能力位（文件变更汇总 / 回退选文件）——由宿主边界从 space 描述符
   * (`getWorkspaceSpaceDescriptor(space).supportsWorkspaceFiles`) 投影而来。host 无关的会话壳按
   * 此能力位分派，不透传原始 `WorkspaceSpaceKind` 枚举（避免包内散写枚举硬分派）。
   */
  supportsWorkspaceFiles: boolean
  messages: ChatMessage[]
  queuedMessages?: ChatMessage[]
  messageRunMarkers: ConversationMessageRunMarker[]
  turnContexts?: ConversationTurnContextView[]
  workerThreads?: ConversationWorkerThread[]
  runtime: ConversationRuntimeView
  isStreaming: boolean
  streamingAssistantMessageId?: string
  hasStreamingThinkingBlock: boolean
  liveTraceSummary?: string
  runningLabel: string
  activeWorkspaceRoot?: LooseOptional<string>
  workspaceSourceRoot?: LooseOptional<string>
  workspaceRoots?: WorkspaceRootEntry[]
  billingModel?: LooseOptional<{
    provider: ChatProviderId
    model: string
  }>
  pricingCatalog?: LooseOptional<ModelPricingCatalog>
  /** 是否还有更早的消息可以加载（分页） */
  hasOlderMessages?: boolean
  /** 正在加载更早消息 */
  isLoadingOlderMessages?: boolean
  /** 触发向上翻页加载 */
  onLoadOlderMessages?: () => void
}
