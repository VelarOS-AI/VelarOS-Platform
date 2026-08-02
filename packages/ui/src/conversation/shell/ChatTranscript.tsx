import { Fragment, memo, type ReactElement, type ReactNode, useLayoutEffect } from 'react'

import { MessageBubble } from '../blocks/MessageBubble'
import { type GoalCompletionActivitySummary } from '../blocks/messageBubbleRenderModel'
import type { FileChangeSummaryListEntry } from '../cards/FileChangeSummaryList'
import type {
  ConversationMessageRunMarker,
  ConversationTurnContextView,
} from '../projection'
import { type SectionMetric } from '../react-hooks/scrollBehavior'
import {
  type BrowserScreenshotDisplayMode,
  useConversationRenderSlots,
} from '../render-slots'
import type {
  ChatInlineNoticeMeta,
  ChatInlineNoticeRuntimeSource,
} from '../status/chatStatus'

import type {
  ChatMessage,
  ChatProviderId,
  ModelPricingCatalog,
  ProjectRootEntry,
  ToolCallBlock as ToolCallBlockType,
  UserActionCardResult,
} from '#contracts'
import { toNullable } from '#internal/runtime'

const EmptyRuntimeCostContexts: ConversationTurnContextView[] = []

function markFirstChatTranscriptCommit(): void {
  const performance = globalThis.performance
  if (!performance || performance.getEntriesByName('velaros:chat-transcript:committed').length > 0)
    return

  performance.mark('velaros:chat-transcript:committed')
}

interface ChatTranscriptNavigationState {
  hasPreviousSection: boolean
  hasNextSection: boolean
}

/**
 * 渲染窗口的导航契约：由 useChatTranscriptWindow 实现，ChatScrollNavigator 消费。
 * section = user 消息；窗口内走 DOM 滚动，跨边界时滑动窗口。
 */
export interface ChatTranscriptNavigationHandle {
  getSectionMetrics: () => SectionMetric[]
  getSectionState: () => ChatTranscriptNavigationState
  scrollToSection: (direction: 'previous' | 'next') => boolean
  scrollToEdge: (edge: 'top' | 'bottom') => boolean
}

export interface ChatTranscriptProps {
  browserScreenshotDisplayMode?: BrowserScreenshotDisplayMode
  /** 已经过 useChatTranscriptWindow 切片的窗口消息，全量渲染。 */
  messages: ChatMessage[]
  sessionId: string
  className?: string
  itemClassName?: string
  pricingCatalog?: LooseOptional<ModelPricingCatalog>
  getQuestionMessage?: (message: ChatMessage) => Nullable<ChatMessage>
  getIsGuidedInput?: (message: ChatMessage) => boolean
  getIsStreaming?: (message: ChatMessage) => boolean
  getRunMarker?: (message: ChatMessage) => Nullable<ConversationMessageRunMarker>
  getInlineNotice?: (message: ChatMessage) => Nullable<ChatInlineNoticeMeta>
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
  getRuntimeCostContexts?: (message: ChatMessage) => ConversationTurnContextView[]
  getGoalCompletionSummary?: (message: ChatMessage) => Nullable<GoalCompletionActivitySummary>
  renderActivityLeadingElement?: (message: ChatMessage) => Nullable<ReactElement>
  renderBeforeMessage?: (message: ChatMessage) => Nullable<ReactNode>
  renderAfterMessage?: (message: ChatMessage) => Nullable<ReactNode>
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

function ChatTranscriptInner({
  browserScreenshotDisplayMode = 'original',
  messages,
  sessionId,
  className,
  itemClassName,
  pricingCatalog = null,
  getQuestionMessage,
  getIsGuidedInput,
  getIsStreaming,
  getRunMarker,
  getInlineNotice,
  inlineNoticeRuntimeSource = null,
  showToolDetails = true,
  hidePlanToolBlocks = false,
  hiddenPlanToolCallId = null,
  hideGoalToolBlocks = false,
  planUpdateIndexByToolCallId,
  activeProjectRoot,
  projectRoots,
  canShowFileChangeSummary = true,
  billingModel,
  getRuntimeCostContexts,
  getGoalCompletionSummary,
  renderActivityLeadingElement,
  renderBeforeMessage,
  renderAfterMessage,
  renderAfterToolCall,
  onOpenBrowserLink,
  onOpenFileChange,
  onOpenProjectPath,
  onReviewFileChanges,
  activeUserActionCardIds,
  onResolveUserActionCard,
  onRewindToMessage,
  onTranslateThinkingBlock,
  canRewindToMessage,
  canChooseRewindFiles,
}: ChatTranscriptProps): ReactElement {
  const slots = useConversationRenderSlots()

  useLayoutEffect(() => {
    markFirstChatTranscriptCommit()
  }, [])

  const renderMessageItem = (message: ChatMessage): ReactElement => {
    const inlineNotice = toNullable(getInlineNotice?.(message))

    return (
      <div className={itemClassName} data-chat-message={message.id}>
        {/* 消息级渲染兜底经 renderMessageBoundary slot 注入宿主 RenderErrorBoundary（自愈耦合留宿主）。 */}
        {slots.renderMessageBoundary({
          message,
          children: (
            <MessageBubble
              message={message}
              browserScreenshotDisplayMode={browserScreenshotDisplayMode}
              sessionId={sessionId}
              questionMessage={toNullable(getQuestionMessage?.(message))}
              isGuidedInput={!!getIsGuidedInput?.(message)}
              isStreaming={!!getIsStreaming?.(message)}
              runMarker={toNullable(getRunMarker?.(message))}
              inlineNotice={inlineNotice}
              inlineNoticeRuntimeSource={inlineNotice ? inlineNoticeRuntimeSource : null}
              showToolDetails={showToolDetails}
              hidePlanToolBlocks={hidePlanToolBlocks}
              hiddenPlanToolCallId={hiddenPlanToolCallId}
              hideGoalToolBlocks={hideGoalToolBlocks}
              planUpdateIndexByToolCallId={planUpdateIndexByToolCallId}
              activeProjectRoot={activeProjectRoot}
              projectRoots={projectRoots}
              canShowFileChangeSummary={canShowFileChangeSummary}
              billingModel={billingModel}
              pricingCatalog={pricingCatalog}
              runtimeCostContexts={getRuntimeCostContexts?.(message) ?? EmptyRuntimeCostContexts}
              goalCompletionSummary={toNullable(getGoalCompletionSummary?.(message))}
              activityLeadingElement={renderActivityLeadingElement?.(message)}
              renderAfterToolCall={renderAfterToolCall}
              onOpenBrowserLink={onOpenBrowserLink}
              onOpenFileChange={onOpenFileChange}
              onOpenProjectPath={onOpenProjectPath}
              onReviewFileChanges={onReviewFileChanges}
              activeUserActionCardIds={activeUserActionCardIds}
              onResolveUserActionCard={onResolveUserActionCard}
              onRewindToMessage={onRewindToMessage}
              onTranslateThinkingBlock={onTranslateThinkingBlock}
              canRewindToMessage={canRewindToMessage}
              canChooseRewindFiles={canChooseRewindFiles}
            />
          ),
        })}
      </div>
    )
  }

  return (
    <div className={className} data-chat-transcript={sessionId}>
      {messages.map((message) => {
        const beforeMessage = renderBeforeMessage?.(message)
        const afterMessage = renderAfterMessage?.(message)

        return (
          <Fragment key={message.id}>
            {beforeMessage}
            {renderMessageItem(message)}
            {afterMessage}
          </Fragment>
        )
      })}
    </div>
  )
}

export const ChatTranscript = memo(ChatTranscriptInner)

ChatTranscript.displayName = 'ChatTranscript'
