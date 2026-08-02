import { memo, type ReactElement, type ReactNode } from 'react'

import type { FileChangeSummaryListEntry } from '../cards/FileChangeSummaryList'
import type { ConversationTurnContextView } from '../projection'
import type { BrowserScreenshotDisplayMode } from '../render-slots'
import type {
  ChatInlineNoticeMeta,
  ChatInlineNoticeRuntimeSource,
} from '../status/chatStatus'
import { isGoalToolStateToolName } from '../tool-render/goal/goalToolBlock'

import { AssistantMessageBubble } from './AssistantMessageBubble'
import {
  areInlineNoticesEqual,
  areRunMarkersEqual,
  type ConversationMessageRunMarker,
  type GoalCompletionActivitySummary,
} from './messageBubbleRenderModel'
import { UserMessageBubble } from './UserMessageBubble'

import type {
  ChatMessage,
  ChatProviderId,
  ModelPricingCatalog,
  ProjectRootEntry,
  ToolCallBlock as ToolCallBlockType,
  UserActionCardResult,
} from '#contracts'
import { isPresent } from '#internal/runtime'

interface MessageBubbleProps {
  browserScreenshotDisplayMode?: BrowserScreenshotDisplayMode
  message: ChatMessage
  sessionId: string
  questionMessage?: LooseOptional<ChatMessage>
  isGuidedInput?: boolean
  isStreaming?: boolean
  runMarker?: LooseOptional<ConversationMessageRunMarker>
  inlineNotice?: LooseOptional<ChatInlineNoticeMeta>
  inlineNoticeRuntimeSource?: LooseOptional<ChatInlineNoticeRuntimeSource>
  showToolDetails?: boolean
  hidePlanToolBlocks?: boolean
  hiddenPlanToolCallId?: LooseOptional<string>
  hideGoalToolBlocks?: boolean
  planUpdateIndexByToolCallId?: ReadonlyMap<string, number>
  activeProjectRoot?: LooseOptional<string>
  projectRoots?: ProjectRootEntry[]
  canShowFileChangeSummary?: boolean
  billingModel?: LooseOptional<{
    provider: ChatProviderId
    model: string
  }>
  pricingCatalog?: LooseOptional<ModelPricingCatalog>
  runtimeCostContexts?: ConversationTurnContextView[]
  goalCompletionSummary?: LooseOptional<GoalCompletionActivitySummary>
  activityLeadingElement?: LooseOptional<ReactElement>
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
  canChooseRewindFiles?: boolean
}

const UserActionCardPresenceByMessage = new WeakMap<ChatMessage, boolean>()
const WorkerThreadAnchorToolPresenceByMessage = new WeakMap<ChatMessage, boolean>()
const PlanToolPresenceByMessage = new WeakMap<ChatMessage, boolean>()
const GoalToolPresenceByMessage = new WeakMap<ChatMessage, boolean>()

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

function hasGoalToolBlock(message: ChatMessage): boolean {
  const cached = GoalToolPresenceByMessage.get(message)
  if (isPresent(cached)) return cached

  for (const block of message.blocks) {
    if (block.type === 'tool-call' && isGoalToolStateToolName(block.toolName)) {
      GoalToolPresenceByMessage.set(message, true)
      return true
    }
  }

  GoalToolPresenceByMessage.set(message, false)
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

function areToolVisibilityPropsEqual(
  prev: Readonly<MessageBubbleProps>,
  next: Readonly<MessageBubbleProps>
): boolean {
  const hasPlanTool = hasPlanToolBlock(prev.message) || hasPlanToolBlock(next.message)
  if (hasPlanTool && prev.hidePlanToolBlocks !== next.hidePlanToolBlocks) return false
  if (hasPlanTool && prev.hiddenPlanToolCallId !== next.hiddenPlanToolCallId) return false

  const hasGoalTool = hasGoalToolBlock(prev.message) || hasGoalToolBlock(next.message)
  return !(hasGoalTool && prev.hideGoalToolBlocks !== next.hideGoalToolBlocks)
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

function MessageBubbleInner(props: MessageBubbleProps): Nullable<ReactElement> {
  return props.message.role === 'user' ? (
    <UserMessageBubble
      message={props.message}
      isGuidedInput={props.isGuidedInput}
      onRewindToMessage={props.onRewindToMessage}
      canRewindToMessage={props.canRewindToMessage}
      canChooseRewindFiles={props.canChooseRewindFiles}
    />
  ) : (
    <AssistantMessageBubble
      message={props.message}
      browserScreenshotDisplayMode={props.browserScreenshotDisplayMode}
      sessionId={props.sessionId}
      questionMessage={props.questionMessage}
      isStreaming={props.isStreaming}
      runMarker={props.runMarker}
      inlineNotice={props.inlineNotice}
      inlineNoticeRuntimeSource={props.inlineNoticeRuntimeSource}
      showToolDetails={props.showToolDetails}
      hidePlanToolBlocks={props.hidePlanToolBlocks}
      hiddenPlanToolCallId={props.hiddenPlanToolCallId}
      hideGoalToolBlocks={props.hideGoalToolBlocks}
      planUpdateIndexByToolCallId={props.planUpdateIndexByToolCallId}
      activeProjectRoot={props.activeProjectRoot}
      projectRoots={props.projectRoots}
      canShowFileChangeSummary={props.canShowFileChangeSummary}
      billingModel={props.billingModel}
      pricingCatalog={props.pricingCatalog}
      runtimeCostContexts={props.runtimeCostContexts}
      goalCompletionSummary={props.goalCompletionSummary}
      activityLeadingElement={props.activityLeadingElement}
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
    prev.isGuidedInput === next.isGuidedInput &&
    prev.isStreaming === next.isStreaming &&
    prev.inlineNoticeRuntimeSource === next.inlineNoticeRuntimeSource &&
    prev.showToolDetails === next.showToolDetails &&
    areToolVisibilityPropsEqual(prev, next) &&
    arePlanToolRenderPropsEqual(prev, next) &&
    prev.activeProjectRoot === next.activeProjectRoot &&
    prev.projectRoots === next.projectRoots &&
    prev.canShowFileChangeSummary === next.canShowFileChangeSummary &&
    prev.billingModel?.provider === next.billingModel?.provider &&
    prev.billingModel?.model === next.billingModel?.model &&
    prev.pricingCatalog === next.pricingCatalog &&
    prev.runtimeCostContexts === next.runtimeCostContexts &&
    prev.goalCompletionSummary === next.goalCompletionSummary &&
    prev.activityLeadingElement === next.activityLeadingElement &&
    areToolSlotRenderPropsEqual(prev, next) &&
    prev.onOpenBrowserLink === next.onOpenBrowserLink &&
    prev.onOpenFileChange === next.onOpenFileChange &&
    prev.onOpenProjectPath === next.onOpenProjectPath &&
    prev.onReviewFileChanges === next.onReviewFileChanges &&
    prev.onRewindToMessage === next.onRewindToMessage &&
    prev.onTranslateThinkingBlock === next.onTranslateThinkingBlock &&
    prev.canRewindToMessage === next.canRewindToMessage &&
    prev.canChooseRewindFiles === next.canChooseRewindFiles &&
    areUserActionCardRenderPropsEqual(prev, next) &&
    areRunMarkersEqual(prev.runMarker, next.runMarker) &&
    areInlineNoticesEqual(prev.inlineNotice, next.inlineNotice)
  )
}

export const MessageBubble = memo(MessageBubbleInner, areMessageBubblePropsEqual)

MessageBubble.displayName = 'MessageBubble'
