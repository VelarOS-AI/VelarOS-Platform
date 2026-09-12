import { memo, type ReactElement, type ReactNode } from 'react'

import type { FileChangeSummaryListEntry } from '../cards/FileChangeSummaryList'
import type { ConversationRewindPlan, ConversationTurnContextView } from '../projection'
import { type BrowserScreenshotDisplayMode, useConversationRenderSlots } from '../render-slots'
import type {
  ChatInlineNoticeMeta,
  ChatInlineNoticeRuntimeSource,
} from '../status/chatStatus'

import { AssistantMessageBubble } from './AssistantMessageBubble'
import {
  areInlineNoticesEqual,
  areRunMarkersEqual,
  type ConversationMessageRunMarker,
  type GoalCompletionActivitySummary,
} from './messageBubbleRenderModel'
import type { RunCostEstimate } from './messageCostEstimate'
import { SystemNoticeMessageRow } from './SystemNoticeMessageRow'
import { UserMessageBubble } from './UserMessageBubble'

import type {
  ChatMessage,
  ChatProviderId,
  ModelPricingCatalog,
  ProjectRootEntry,
  ToolCallBlock as ToolCallBlockType,
  UserActionCardResult,
} from '#contracts'
import { isSystemNoticeMessage } from '#contracts'
import { isPresent } from '#internal/runtime'

interface MessageBubbleProps {
  browserScreenshotDisplayMode?: BrowserScreenshotDisplayMode
  message: ChatMessage
  sessionId: string
  questionMessage?: LooseOptional<ChatMessage>
  isStreaming?: boolean
  runMarker?: LooseOptional<ConversationMessageRunMarker>
  implicitlyCompletedRun?: boolean
  inlineNotice?: LooseOptional<ChatInlineNoticeMeta>
  inlineNoticeRuntimeSource?: LooseOptional<ChatInlineNoticeRuntimeSource>
  showToolDetails?: boolean
  planUpdateIndexByToolCallId?: ReadonlyMap<string, number>
  activeProjectRoot?: LooseOptional<string>
  projectRoots?: ProjectRootEntry[]
  canShowFileChangeSummary?: boolean
  /** @deprecated 约价改由 `runCostEstimate` 提供（按执行用量账计价）；保留只为已发布宿主。 */
  billingModel?: LooseOptional<{
    provider: ChatProviderId
    model: string
  }>
  /** @deprecated 同 `billingModel`。 */
  pricingCatalog?: LooseOptional<ModelPricingCatalog>
  /** @deprecated 同 `billingModel`。 */
  runtimeCostContexts?: ConversationTurnContextView[]
  /** 这次执行的约价（主 Agent 全部模型调用 + 子 Agent 运行）；缺席时回答末尾不显示金额。 */
  runCostEstimate?: LooseOptional<RunCostEstimate>
  goalCompletionSummary?: LooseOptional<GoalCompletionActivitySummary>
  activityLeadingElement?: LooseOptional<ReactElement>
  activityTrailingElement?: LooseOptional<ReactElement>
  renderAfterToolCall?: (block: ToolCallBlockType) => Nullable<ReactNode>
  onOpenBrowserLink?: (url: string) => void | Promise<void>
  onOpenFileChange?: (entry: FileChangeSummaryListEntry) => void | Promise<void>
  onOpenProjectPath?: (path: string) => unknown
  onReviewFileChanges?: (entries: FileChangeSummaryListEntry[]) => void | Promise<void>
  activeUserActionCardIds?: readonly string[]
  onResolveUserActionCard?: (request: UserActionCardResult) => void | Promise<void>
  onRewindToMessage?: (messageId: string, options?: { restoreFiles?: boolean }) => Promise<void>
  onTranslateThinkingBlock?: (request: {
    messageId: string
    blockIndex: number
    text: string
  }) => Promise<void>
  canRewindToMessage?: boolean
  getRewindPlan?: (messageId: string) => Nullable<ConversationRewindPlan>
}

const UserActionCardPresenceByMessage = new WeakMap<ChatMessage, boolean>()
const WorkerThreadAnchorToolPresenceByMessage = new WeakMap<ChatMessage, boolean>()
const PlanToolPresenceByMessage = new WeakMap<ChatMessage, boolean>()

function hasUserActionCardBlock(message: ChatMessage): boolean {
  const cached = UserActionCardPresenceByMessage.get(message)
  if (isPresent(cached)) return cached

  for (const block of message.blocks) {
    if (block.type === 'user-action-card') {
      UserActionCardPresenceByMessage.set(message, true)
      return true
    }
  }

  UserActionCardPresenceByMessage.set(message, false)
  return false
}

function hasWorkerThreadAnchorToolBlock(message: ChatMessage): boolean {
  const cached = WorkerThreadAnchorToolPresenceByMessage.get(message)
  if (isPresent(cached)) return cached

  for (const block of message.blocks) {
    if (block.type === 'tool-call' && block.toolName === 'agent:dispatch') {
      WorkerThreadAnchorToolPresenceByMessage.set(message, true)
      return true
    }
  }

  WorkerThreadAnchorToolPresenceByMessage.set(message, false)
  return false
}

function hasPlanToolBlock(message: ChatMessage): boolean {
  const cached = PlanToolPresenceByMessage.get(message)
  if (isPresent(cached)) return cached

  for (const block of message.blocks) {
    if (block.type === 'tool-call' && block.toolName === 'plan:update') {
      PlanToolPresenceByMessage.set(message, true)
      return true
    }
  }

  PlanToolPresenceByMessage.set(message, false)
  return false
}

function areUserActionCardRenderPropsEqual(
  prev: Readonly<MessageBubbleProps>,
  next: Readonly<MessageBubbleProps>
): boolean {
  if (!hasUserActionCardBlock(prev.message) && !hasUserActionCardBlock(next.message)) return true

  return (
    prev.activeUserActionCardIds === next.activeUserActionCardIds &&
    prev.onResolveUserActionCard === next.onResolveUserActionCard
  )
}

function arePlanToolRenderPropsEqual(
  prev: Readonly<MessageBubbleProps>,
  next: Readonly<MessageBubbleProps>
): boolean {
  if (!hasPlanToolBlock(prev.message) && !hasPlanToolBlock(next.message)) return true


  for (const block of prev.message.blocks) {
    if (block.type !== 'tool-call') continue

    if (
      prev.planUpdateIndexByToolCallId?.get(block.toolCallId) !==
      next.planUpdateIndexByToolCallId?.get(block.toolCallId)
    )
      return false
  }

  return true
}

function areToolSlotRenderPropsEqual(
  prev: Readonly<MessageBubbleProps>,
  next: Readonly<MessageBubbleProps>
): boolean {
  if (
    !hasWorkerThreadAnchorToolBlock(prev.message) &&
    !hasWorkerThreadAnchorToolBlock(next.message)
  )
    return true

  return prev.renderAfterToolCall === next.renderAfterToolCall
}

/**
 * 消息级渲染兜底经 renderMessageBoundary slot 注入宿主 RenderErrorBoundary（自愈耦合留宿主）。
 * 边界放在 memo 之内：气泡没变时连边界一起跳过，不随每个 token 为每条消息重跑一遍。
 */
function MessageBubbleInner(props: MessageBubbleProps): Nullable<ReactElement> {
  const slots = useConversationRenderSlots()
  return slots.renderMessageBoundary({
    message: props.message,
    children: renderMessageBubbleContent(props),
  })
}

function renderMessageBubbleContent(props: MessageBubbleProps): ReactElement {
  if (isSystemNoticeMessage(props.message)) return <SystemNoticeMessageRow message={props.message} />

  return props.message.role === 'user' ? (
    <UserMessageBubble
      message={props.message}
      onRewindToMessage={props.onRewindToMessage}
      canRewindToMessage={props.canRewindToMessage}
      getRewindPlan={props.getRewindPlan}
    />
  ) : (
    <AssistantMessageBubble
      message={props.message}
      browserScreenshotDisplayMode={props.browserScreenshotDisplayMode}
      sessionId={props.sessionId}
      questionMessage={props.questionMessage}
      isStreaming={props.isStreaming}
      runMarker={props.runMarker}
      implicitlyCompletedRun={props.implicitlyCompletedRun}
      inlineNotice={props.inlineNotice}
      inlineNoticeRuntimeSource={props.inlineNoticeRuntimeSource}
      showToolDetails={props.showToolDetails}
      planUpdateIndexByToolCallId={props.planUpdateIndexByToolCallId}
      activeProjectRoot={props.activeProjectRoot}
      projectRoots={props.projectRoots}
      canShowFileChangeSummary={props.canShowFileChangeSummary}
      runCostEstimate={props.runCostEstimate}
      goalCompletionSummary={props.goalCompletionSummary}
      activityLeadingElement={props.activityLeadingElement}
      activityTrailingElement={props.activityTrailingElement}
      renderAfterToolCall={props.renderAfterToolCall}
      onOpenBrowserLink={props.onOpenBrowserLink}
      onOpenFileChange={props.onOpenFileChange}
      onOpenProjectPath={props.onOpenProjectPath}
      onReviewFileChanges={props.onReviewFileChanges}
      activeUserActionCardIds={props.activeUserActionCardIds}
      onResolveUserActionCard={props.onResolveUserActionCard}
      onTranslateThinkingBlock={props.onTranslateThinkingBlock}
    />
  )
}

function areMessageBubblePropsEqual(
  prev: Readonly<MessageBubbleProps>,
  next: Readonly<MessageBubbleProps>
): boolean {
  return (
    prev.message === next.message &&
    prev.browserScreenshotDisplayMode === next.browserScreenshotDisplayMode &&
    prev.sessionId === next.sessionId &&
    prev.questionMessage === next.questionMessage &&
    prev.isStreaming === next.isStreaming &&
    prev.implicitlyCompletedRun === next.implicitlyCompletedRun &&
    prev.inlineNoticeRuntimeSource === next.inlineNoticeRuntimeSource &&
    prev.showToolDetails === next.showToolDetails &&
    arePlanToolRenderPropsEqual(prev, next) &&
    prev.activeProjectRoot === next.activeProjectRoot &&
    prev.projectRoots === next.projectRoots &&
    prev.canShowFileChangeSummary === next.canShowFileChangeSummary &&
    prev.runCostEstimate === next.runCostEstimate &&
    prev.goalCompletionSummary === next.goalCompletionSummary &&
    prev.activityLeadingElement === next.activityLeadingElement &&
    prev.activityTrailingElement === next.activityTrailingElement &&
    areToolSlotRenderPropsEqual(prev, next) &&
    prev.onOpenBrowserLink === next.onOpenBrowserLink &&
    prev.onOpenFileChange === next.onOpenFileChange &&
    prev.onOpenProjectPath === next.onOpenProjectPath &&
    prev.onReviewFileChanges === next.onReviewFileChanges &&
    prev.onRewindToMessage === next.onRewindToMessage &&
    prev.onTranslateThinkingBlock === next.onTranslateThinkingBlock &&
    prev.canRewindToMessage === next.canRewindToMessage &&
    prev.getRewindPlan === next.getRewindPlan &&
    areUserActionCardRenderPropsEqual(prev, next) &&
    areRunMarkersEqual(prev.runMarker, next.runMarker) &&
    areInlineNoticesEqual(prev.inlineNotice, next.inlineNotice)
  )
}

export const MessageBubble = memo(MessageBubbleInner, areMessageBubblePropsEqual)

MessageBubble.displayName = 'MessageBubble'
