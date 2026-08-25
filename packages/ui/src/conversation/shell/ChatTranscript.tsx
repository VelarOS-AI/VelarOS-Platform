import { Fragment, memo, type ReactElement, type ReactNode, useLayoutEffect, useMemo } from 'react'

import { MessageBubble } from '../blocks/MessageBubble'
import { type GoalCompletionActivitySummary } from '../blocks/messageBubbleRenderModel'
import type { FileChangeSummaryListEntry } from '../cards/FileChangeSummaryList'
import type {
  ConversationMessageRunMarker,
  ConversationTurnContextView,
} from '../projection'
import type { ConversationRewindPlan } from '../projection'
import { type SectionMetric } from '../react-hooks/scrollBehavior'
import {
  type BrowserScreenshotDisplayMode,
  useConversationRenderSlots,
} from '../render-slots'
import type {
  ChatInlineNoticeMeta,
  ChatInlineNoticeRuntimeSource,
} from '../status/chatStatus'

import {
  buildChatTranscriptMessagePresentations,
  type ChatTranscriptMessagePresentation,
} from './chatTranscriptActivityGrouping'

import type {
  ChatMessage,
  ChatProviderId,
  ModelPricingCatalog,
  ProjectRootEntry,
  ToolCallBlock as ToolCallBlockType,
  UserActionCardResult,
} from '#contracts'
import { isEmpty, toNullable } from '#internal/runtime'

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

/** 同一轮归组后的子消息始终压平；折叠边界只由承载整轮的 assistant 生成一次。 */
export function shouldForceGroupedActivityFlat(hasGroupedRunActivity: boolean): boolean {
  return hasGroupedRunActivity
}

/** 完成态中只有纯内部活动消息可以参与跨消息横排；正文、引导和卡片维持整行。 */
export function shouldInlineGroupedActivityMessage(
  message: ChatMessage,
  forceActivityFlat: boolean
): boolean {
  return (
    !forceActivityFlat &&
    message.role === 'assistant' &&
    !isEmpty(message.blocks) &&
    message.blocks.every((block) => block.type === 'thinking' || block.type === 'tool-call')
  )
}

/**
 * 渲染窗口的导航契约：由 useChatTranscriptWindow 实现，ChatScrollNavigator 消费。
 * section = turn-input；运行内 guidance/reply 不创建新 section。
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
  getIsStreaming?: (message: ChatMessage) => boolean
  getRunMarker?: (message: ChatMessage) => Nullable<ConversationMessageRunMarker>
  getInlineNotice?: (message: ChatMessage) => Nullable<ChatInlineNoticeMeta>
  inlineNoticeRuntimeSource?: LooseOptional<ChatInlineNoticeRuntimeSource>
  showToolDetails?: boolean
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
  getRewindPlan?: (messageId: string) => Nullable<ConversationRewindPlan>
}

function ChatTranscriptInner({
  browserScreenshotDisplayMode = 'original',
  messages,
  sessionId,
  className,
  itemClassName,
  pricingCatalog = null,
  getQuestionMessage,
  getIsStreaming,
  getRunMarker,
  getInlineNotice,
  inlineNoticeRuntimeSource = null,
  showToolDetails = true,
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
  getRewindPlan,
}: ChatTranscriptProps): ReactElement {
  const slots = useConversationRenderSlots()
  const messagePresentations = useMemo(
    () =>
      buildChatTranscriptMessagePresentations(messages, {
        isCompletedAssistant: (message) =>
          !getIsStreaming?.(message) && getRunMarker?.(message)?.status === 'completed',
        hasRunMarker: (message) => !!getRunMarker?.(message),
      }),
    [getIsStreaming, getRunMarker, messages]
  )

  useLayoutEffect(() => {
    markFirstChatTranscriptCommit()
  }, [])

  const renderActivityMessages = (
    activityMessages: ChatMessage[],
    forceActivityFlat: boolean
  ): Nullable<ReactElement> => {
    if (isEmpty(activityMessages)) return null

    return (
      <div className="velar-transcript-run-activity" data-chat-run-activity="true">
        {activityMessages.map((message) => {
          const beforeMessage = renderBeforeMessage?.(message)
          const afterMessage = renderAfterMessage?.(message)

          return (
            <Fragment key={message.id}>
              {beforeMessage}
              {renderMessageItem(message, {
                forceActivityFlat,
                groupedActivityLayout: shouldInlineGroupedActivityMessage(
                  message,
                  forceActivityFlat
                )
                  ? 'inline'
                  : 'block',
              })}
              {afterMessage}
            </Fragment>
          )
        })}
      </div>
    )
  }

  const renderMessageItem = (
    message: ChatMessage,
    options: {
      forceActivityFlat?: boolean
      groupedActivityLayout?: 'inline' | 'block'
      presentation?: ChatTranscriptMessagePresentation
    } = {}
  ): ReactElement => {
    const inlineNotice = toNullable(getInlineNotice?.(message))
    const forceActivityFlat = !!options.forceActivityFlat
    const activityLeadingMessages = options.presentation?.activityLeadingMessages ?? []
    const activityTrailingMessages = options.presentation?.activityTrailingMessages ?? []
    const groupedRunIsStreaming = [
      message,
      ...activityLeadingMessages,
      ...activityTrailingMessages,
    ].some((activityMessage) => !!getIsStreaming?.(activityMessage))
    const groupedRunMarker = [
      ...activityLeadingMessages,
      message,
      ...activityTrailingMessages,
    ].reduce<Nullable<ConversationMessageRunMarker>>(
      (marker, activityMessage) => toNullable(getRunMarker?.(activityMessage)) ?? marker,
      null
    )
    const forceGroupedActivityFlat = shouldForceGroupedActivityFlat(
      !isEmpty(activityLeadingMessages) || !isEmpty(activityTrailingMessages)
    )
    const groupedActivityLeadingElement = renderActivityMessages(
      activityLeadingMessages,
      forceGroupedActivityFlat
    )
    const ownActivityLeadingElement = renderActivityLeadingElement?.(message)
    const activityLeadingElement =
      groupedActivityLeadingElement || ownActivityLeadingElement ? (
        <>
          {groupedActivityLeadingElement}
          {ownActivityLeadingElement}
        </>
      ) : null
    const activityTrailingElement = renderActivityMessages(
      activityTrailingMessages,
      forceGroupedActivityFlat
    )

    return (
      <div
        className={itemClassName}
        data-chat-message={message.id}
        data-chat-run-activity-layout={options.groupedActivityLayout}
      >
        {/* 消息级渲染兜底经 renderMessageBoundary slot 注入宿主 RenderErrorBoundary（自愈耦合留宿主）。 */}
        {slots.renderMessageBoundary({
          message,
          children: (
            <MessageBubble
              message={message}
              browserScreenshotDisplayMode={browserScreenshotDisplayMode}
              sessionId={sessionId}
              questionMessage={toNullable(getQuestionMessage?.(message))}
              isStreaming={forceActivityFlat || groupedRunIsStreaming}
              runMarker={forceActivityFlat ? null : groupedRunMarker}
              implicitlyCompletedRun={
                !forceActivityFlat && !!options.presentation?.implicitlyCompletedRun
              }
              inlineNotice={inlineNotice}
              inlineNoticeRuntimeSource={inlineNotice ? inlineNoticeRuntimeSource : null}
              showToolDetails={showToolDetails}
              planUpdateIndexByToolCallId={planUpdateIndexByToolCallId}
              activeProjectRoot={activeProjectRoot}
              projectRoots={projectRoots}
              canShowFileChangeSummary={forceActivityFlat ? false : canShowFileChangeSummary}
              billingModel={billingModel}
              pricingCatalog={pricingCatalog}
              runtimeCostContexts={getRuntimeCostContexts?.(message) ?? EmptyRuntimeCostContexts}
              goalCompletionSummary={
                forceActivityFlat ? null : toNullable(getGoalCompletionSummary?.(message))
              }
              activityLeadingElement={activityLeadingElement}
              activityTrailingElement={activityTrailingElement}
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
              getRewindPlan={getRewindPlan}
            />
          ),
        })}
      </div>
    )
  }

  return (
    <div className={className} data-chat-transcript={sessionId}>
      {messagePresentations.map((presentation) => {
        const { message } = presentation
        const beforeMessage = renderBeforeMessage?.(message)
        const afterMessage = renderAfterMessage?.(message)

        return (
          <Fragment key={message.id}>
            {beforeMessage}
            {renderMessageItem(message, { presentation })}
            {afterMessage}
          </Fragment>
        )
      })}
    </div>
  )
}

export const ChatTranscript = memo(ChatTranscriptInner)

ChatTranscript.displayName = 'ChatTranscript'
