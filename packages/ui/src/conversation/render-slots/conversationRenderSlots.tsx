import { createContext, type ReactElement, type ReactNode, useContext } from 'react'

import type { FileChangeSummaryListEntry } from '../cards/FileChangeSummaryList'
import type { ConversationRunMarkerView, UserActionResolution } from '../projection'
import type { ConversationWorkerThread } from '../projection/conversationWorkerThread'

import type {
  ChatGoalLifecycleAction,
  ChatMessage,
  ContentBlock,
  UserActionCard,
  WorkspaceAutoApprovalNotice,
} from '#contracts'
import type { GoalDockViewModel } from '#internal/goalLifecycle'

/**
 * 顶栏坞项内容的**判别联合注入面**（pass-4 収口）：会话壳产出坞项元数据（id/createdAt/reveal/spotlight），
 * 内容按 `kind` 交宿主 `stickyDockItemContent` slot 渲染。宿主实现在各 kind 内处理专属卡的宿主耦合
 * （wizard 分发 / handoff 事件 / 权限页导航 / i18n）。`plan-update` 由包内 PlanToolRender 直渲，不进本联合。
 */
export type ConversationStickyDockContent =
  | {
      kind: 'user-action-card'
      /** 坞项 id（宿主实现据此判定是否转交建议卡 → 走 handoff 事件通道）。 */
      itemId: string
      card: UserActionCard
      sessionId: string
      onDismiss?: () => void
      onOpenArtifact?: (path: string) => unknown
    }
  | {
      kind: 'workspace-auto-approval'
      notice: WorkspaceAutoApprovalNotice
      onDismiss?: () => void
    }
  | {
      kind: 'preflight-action'
      card: UserActionCard
      sessionId: string
      onResolve: (resolution: UserActionResolution) => void
      onOpenArtifact?: (path: string) => unknown
    }
  | {
      kind: 'goal-lifecycle'
      model: GoalDockViewModel
      busy: boolean
      onAction: (action: ChatGoalLifecycleAction) => Promise<boolean>
      onContinue: () => void | Promise<void>
    }

/**
 * 会话渲染 render-slot 契约（§12.9 封闭）：**有限具名集合**，非任意 children 洞。
 *
 * 管线组件（`MessageContentBlock` / `AssistantMessageBubble`）不硬 import 宿主专属的黑名单卡件
 * （能力自动批准 / 定时任务提案 / 旗标任务建议 / 浏览器截图组），而是经此注入面消费——每个 slot
 * 是一个具名、带类型 props 的渲染函数。宿主在装配点提供实现（`desktopConversationRenderSlots`）。
 * 缺注入时各 slot 默认渲染 `null`（这些卡是渲染增强，缺失即不显示，不影响正文），宿主装配后即生效。
 */
export interface ConversationRenderSlots {
  capabilityAutoApprovalNotice: (props: {
    block: Extract<ContentBlock, { type: 'capability-auto-approval' }>
  }) => Nullable<ReactElement>
  scheduledTaskProposal: (props: {
    block: Extract<ContentBlock, { type: 'scheduled-task-proposal' }>
    consumed: boolean
    onConsumed?: (proposalId: string) => void
  }) => Nullable<ReactElement>
  flaggedTaskSuggestion: (props: {
    block: Extract<ContentBlock, { type: 'flagged-task' }>
    sessionId: string
  }) => Nullable<ReactElement>
  browserScreenshotGroup: (props: {
    blocks: ContentBlock[]
    displayMode: BrowserScreenshotDisplayMode
    sessionId: string
  }) => Nullable<ReactElement>
  workerThreadPanel: (props: {
    threads: ConversationWorkerThread[]
    sessionId: string
    variant?: ConversationWorkerThreadVariant
    selectedThreadId?: Nullable<string>
    onOpenThread?: (threadId: string) => void
  }) => Nullable<ReactElement>
  /**
   * 系统工具安装建议卡（宿主 `SystemToolInstallSuggestionCard` 薄容器，**永久** slot）——viewmodel 触达
   * rendererIpc.settings.installSystemTool + 全局提示留宿主。block-dispatch：MessageContentBlock 经此分发。
   */
  systemToolInstall: (props: {
    block: Extract<ContentBlock, { type: 'system-tool-install-suggestion' }>
  }) => Nullable<ReactElement>
  /**
   * 提问卡（wizard，宿主 `AskUserCarousel` 薄容器，**永久** slot）——有状态 viewmodel（表单/超时/localStorage）
   * 留宿主。dispatch 决策（wizard 判定 + onActionComplete 构造）在包内 MessageContentBlock，本 slot 只渲染容器。
   */
  askUser: (props: {
    block: Extract<ContentBlock, { type: 'user-action-card' }>
    sessionId: string
    disabled: boolean
    onActionComplete?: (resolution: UserActionResolution) => void | Promise<void>
  }) => Nullable<ReactElement>
  /**
   * 用户动作卡（非 wizard，宿主 `UserActionCard` 薄容器，**永久** slot）——有状态 viewmodel 留宿主；
   * 可见性谓词 `shouldRenderUserActionCard`（localStorage 已消费/超时判定）在宿主 slot 实现内应用（不可见回 null）。
   */
  userActionCard: (props: {
    block: Extract<ContentBlock, { type: 'user-action-card' }>
    sessionId: string
    disabled: boolean
    activeUserActionCardIds?: readonly string[]
    onActionComplete?: (resolution: UserActionResolution) => void | Promise<void>
    onOpenArtifact?: (path: string) => unknown
  }) => Nullable<ReactElement>
  /**
   * 消息文件变更汇总（宿主 `MessageFileChangeSummary`，**永久** slot）——viewmodel 触达 rendererIpc
   * （文件预览/回滚）留宿主。runMarker 走窄投影，宿主实现内读全型 workspaceCheckpointDiff。
   */
  messageFileChangeSummary: (props: {
    message: ChatMessage
    runMarker?: Nullable<ConversationRunMarkerView>
    sessionId: string
    formatPathForDisplay?: (path: string) => string
    onOpenEntry?: (entry: FileChangeSummaryListEntry) => void | Promise<void>
    onReviewEntries?: (entries: FileChangeSummaryListEntry[]) => void | Promise<void>
  }) => Nullable<ReactElement>
  /**
   * 顶栏坞项内容（pass-4 収口）——见 `ConversationStickyDockContent`。宿主渲染专属卡并处理其宿主耦合。
   */
  stickyDockItemContent: (content: ConversationStickyDockContent) => Nullable<ReactElement>
  /**
   * 单消息渲染错误边界（pass-4 収口）——ChatTranscript 每条消息经此包裹。宿主实现 `RenderErrorBoundary` +
   * `ChatMessageRenderFailureAlert`（含 staleModuleRecovery 自愈耦合，留宿主）；缺注入时直接透传 children。
   */
  renderMessageBoundary: (props: { message: ChatMessage; children: ReactNode }) => ReactElement
}

/** 浏览器截图组展示模式（渲染侧单源，desktop 组件消费此定义）。 */
export type BrowserScreenshotDisplayMode = 'original' | 'model-debug'

export type ConversationWorkerThreadVariant = 'default' | 'side'

const defaultConversationRenderSlots: ConversationRenderSlots = {
  capabilityAutoApprovalNotice: () => null,
  scheduledTaskProposal: () => null,
  flaggedTaskSuggestion: () => null,
  browserScreenshotGroup: () => null,
  workerThreadPanel: () => null,
  systemToolInstall: () => null,
  askUser: () => null,
  userActionCard: () => null,
  messageFileChangeSummary: () => null,
  stickyDockItemContent: () => null,
  renderMessageBoundary: ({ children }) => <>{children}</>,
}

const ConversationRenderSlotsContext = createContext<ConversationRenderSlots>(
  defaultConversationRenderSlots
)

export function ConversationRenderSlotsProvider({
  slots,
  children,
}: {
  slots: ConversationRenderSlots
  children: ReactNode
}): ReactElement {
  return (
    <ConversationRenderSlotsContext.Provider value={slots}>
      {children}
    </ConversationRenderSlotsContext.Provider>
  )
}

export function useConversationRenderSlots(): ConversationRenderSlots {
  return useContext(ConversationRenderSlotsContext)
}
