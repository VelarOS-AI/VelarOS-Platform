import { createContext, type ReactElement, type ReactNode, useContext } from 'react'

import type { FileChangeSummaryListEntry } from '../cards/FileChangeSummaryList'
import type { ConversationRunMarkerView, UserActionResolution } from '../projection'
import type { ConversationWorkerThread } from '../projection/conversationWorkerThread'

import type {
  ChatGoalLifecycleAction,
  ChatMessage,
  ContentBlock,
  ProjectAutoApprovalNotice,
  UserActionCard,
} from '#contracts'
import type { GoalDockViewModel } from '#internal/goalLifecycle'

/**
 * 顶栏坞项内容的**判别联合注入面**（pass-4 収口）：会话壳产出坞项元数据（id/createdAt/reveal/spotlight），
 * 内容按 `kind` 交宿主 `stickyDockItemContent` slot 渲染。宿主实现在各 kind 内处理专属卡的宿主耦合
 * （wizard 分发 / 权限页导航 / i18n）。`plan-update` 由包内 PlanToolRender 直渲，不进本联合。
 *
 * **加一张宿主自有坞卡时只有一条路**：在本联合加一个 kind，带上它自己的回传回调
 * （`onResolve` / `onAction`）。不要在坞项 id 上编码身份、也不要往 `window` 上挂
 * `velaros:*-resolve` 全局事件——那条旁路当天能做完，代价是身份可冒充、通道谁都能派发。
 */
export type ConversationStickyDockContent =
  | {
      kind: 'user-action-card'
      card: UserActionCard
      sessionId: string
      onDismiss?: () => void
      onOpenArtifact?: (path: string) => unknown
    }
  | {
      /**
       * 宿主自有的会话转交建议卡。与 `user-action-card` 分开的理由是**身份与回传**：
       * 它不是模型产出，批准会去建一个新会话，所以走 typed kind + `onResolve` 正路——
       * 而不是"坞项 id 前缀嗅探 + window CustomEvent"那条旁路（谁都能冒充、谁都能派发）。
       */
      kind: 'handoff-suggestion'
      card: UserActionCard
      sessionId: string
      onResolve: (resolution: UserActionResolution) => void
      onDismiss?: () => void
      onOpenArtifact?: (path: string) => unknown
    }
  | {
      kind: 'project-auto-approval'
      notice: ProjectAutoApprovalNotice
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
 * `messageMarkdown` 替换槽的 props。
 *
 * 由 `MessageMarkdownBlock` / `StreamingTextBlock`（`../blocks/MessageMarkdownBlocks`）的真实入参
 * **收窄**而来：只留替换件真正需要的两位，不透传 `TextBlock` / 运行标记等内部形状——props 越宽，
 * 本包被冻结的内部形状越多。
 *
 * - `text` 是**官方渲染器逐字消费的那份正文**（`prepareStreamdownMarkdownText` 的产物：目录树补围栏、
 *   裸 `$` 转义），替换件因此拿到与被替换件完全相同的输入；
 * - `isStreaming` 是**消息是否仍在流式产出**，只用于调整静态呈现（尾标记 / 占位）。替换件**不得自带
 *   揭示层**：屏显节奏的唯一权威是 `ChatStreamPacer`，第二层逐字动画只会与它打架。
 *
 * v1 已知边界：运行标记（成本 / 状态尾标）由官方件在正文内联渲染，不在本 props 内——整块被替换时
 * 它随之缺席。要保留它得把内部投影透传出去，那正是本契约拒绝做的事。
 */
export interface ConversationMarkdownSlotProps {
  /** 已按流式规则准备好的 markdown 正文。 */
  text: string
  /** 该消息是否仍在流式产出。 */
  isStreaming: boolean
}

/**
 * `messageCodeBlock` 替换槽的 props。
 *
 * 由 `useMessageMarkdownComponents(...)` 内 `ExpandableCodeBlockFrame` / `RenderableHtmlCodeBlockFrame`
 * 的真实入参收窄而来。语言原样给出（含 `mermaid` / `html` 这些官方走专用分支的值），替换件自己判
 * 要不要接管——闭集判定留在官方分支里，替换件就永远拿不到新语言。
 */
export interface ConversationCodeBlockSlotProps {
  /** 代码围栏的语言标注（小写；无标注为空串）。 */
  language: string
  code: string
  /** 该代码块是否仍在流式产出（尾块未闭合时为真）。 */
  isStreaming: boolean
}

/**
 * 会话渲染 render-slot 契约（§12.9 封闭）：**有限具名集合**，非任意 children 洞。
 *
 * 管线组件（`MessageContentBlock` / `AssistantMessageBubble`）不硬 import 宿主专属的黑名单卡件
 * （能力自动批准 / 定时任务提案 / 旗标任务建议 / 浏览器截图组），而是经此注入面消费——每个 slot
 * 是一个具名、带类型 props 的渲染函数。宿主在装配点提供实现（`desktopConversationRenderSlots`）。
 * 缺注入时各 slot 默认渲染 `null`（这些卡是渲染增强，缺失即不显示，不影响正文），宿主装配后即生效。
 *
 * **两类 slot 语义相反，别混**：
 * - **增强槽**（下面绝大多数，必填 + 默认 `() => null`）：缺席 = 那张卡不显示，正文照旧；
 * - **替换槽**（`messageMarkdown` / `messageCodeBlock`，**可选**）：缺席 = **官方内置件逐字节原行为**。
 *   替换槽必须可选而不是「必填 + 默认返回 null」——后者会让「宿主忘了填」与「渲染空白」长得一模一样，
 *   而这两格空白掉的是消息正文本身。可选性就是那道机械防线：不写它 = 官方实现。
 */
export interface ConversationRenderSlots {
  capabilityAutoApprovalNotice: (props: {
    block: Extract<ContentBlock, { type: 'capability-auto-approval' }>
  }) => Nullable<ReactElement>
  /**
   * 定时任务提案卡。「已创建」不再由管线传状态——它是 `block.resolution`（随会话存档落盘）
   * 的读法，宿主件自己读、自己在创建成功后写回去。
   */
  scheduledTaskProposal: (props: {
    block: Extract<ContentBlock, { type: 'scheduled-task-proposal' }>
    sessionId: string
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
    selectedThreadId?: LooseOptional<string>
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
    runMarker?: LooseOptional<ConversationRunMarkerView>
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
  /**
   * **替换槽**：消息正文 markdown 渲染器（官方件 = `MessageMarkdownBlock` / `StreamingTextBlock`）。
   *
   * 缺席（`undefined`）= 官方原路径，连官方件的 lazy 分包都照旧按需加载；注入后 `MessageContentBlock`
   * 在**硬 lazy-import 那一层**就改道，替换件生效时官方 markdown 分包根本不会被拉起——这才是「替换」
   * 而不是「套一层」。
   *
   * 三条失败路径统一回落官方件：返回 `null`（声明本次不替换）/ 渲染抛错（错误边界捕获）/ 槽位缺席。
   * 思考块（`ThinkingBlock`）**不在本槽范围**：它有自己的折叠、翻译与流式呈现，用正文替换件顶上去
   * 只会丢功能。
   */
  messageMarkdown?: (props: ConversationMarkdownSlotProps) => Nullable<ReactElement>
  /**
   * **替换槽**：markdown 围栏代码块渲染器（官方件 = `ExpandableCodeBlockFrame` /
   * `RenderableHtmlCodeBlockFrame` / mermaid 直渲分支）。高亮、图表、可运行都在这一格里换。
   *
   * 缺席 = 官方原路径。取不到围栏正文时也回落官方——替换件唯一的输入没有，替换就没有意义。
   * 行内代码（`inlineCode`）不属于本槽：它是句中片段，不是块级渲染器。
   */
  messageCodeBlock?: (props: ConversationCodeBlockSlotProps) => Nullable<ReactElement>
}

/** 浏览器截图组展示模式（渲染侧单源，desktop 组件消费此定义）。 */
export type BrowserScreenshotDisplayMode = 'original' | 'model-debug'

export type ConversationWorkerThreadVariant = 'default' | 'side'

/**
 * 缺注入时的默认面：增强槽一律 `() => null`（卡不显示，正文照旧）。
 *
 * **替换槽刻意不在这里出现**——给 `messageMarkdown` / `messageCodeBlock` 填一个 `() => null` 默认值
 * 等于把「没人替换」写成「替换成空白」，正文会整块消失。缺席就是缺席，由调用点判 `undefined` 走官方件。
 */
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
