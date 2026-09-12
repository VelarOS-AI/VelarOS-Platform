import { Fragment, memo, type ReactElement, type ReactNode, useLayoutEffect, useMemo } from 'react'
import { useMemoizedFn } from 'ahooks'

import { MessageBubble } from '../blocks/MessageBubble'
import { type GoalCompletionActivitySummary } from '../blocks/messageBubbleRenderModel'
import type { RunCostEstimate } from '../blocks/messageCostEstimate'
import type { FileChangeSummaryListEntry } from '../cards/FileChangeSummaryList'
import type {
  ConversationMessageRunMarker,
  ConversationTurnContextView,
} from '../projection'
import type { ConversationRewindPlan } from '../projection'
import { type SectionMetric } from '../react-hooks/scrollBehavior'
import type { BrowserScreenshotDisplayMode } from '../render-slots'
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

/**
 * 宿主回调固定成稳定引用再交给消息气泡。气泡按引用判等，宿主每次渲染新建一个回调（内联箭头、
 * 组件里的普通函数）就会让整段对话随每个 token 重画；这里只保留「传没传」的变化（没传时气泡
 * 不画对应入口），调用时总是转给宿主最新的那一个。
 */
function useStableHostCallback<Args extends unknown[], Result>(
  callback?: (...args: Args) => Result
): Optional<(...args: Args) => Result> {
  const stable = useMemoizedFn((...args: Args): Result => callback!(...args))
  return callback ? stable : undefined
}

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
  /** @deprecated 约价改由 `getRunCostEstimate` 提供（按执行用量账计价）；保留只为已发布宿主。 */
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
  /** @deprecated 约价改由 `getRunCostEstimate` 提供（按执行用量账计价）；保留只为已发布宿主。 */
  billingModel?: LooseOptional<{
    provider: ChatProviderId
    model: string
  }>
  /** @deprecated 约价不再按回合上下文反推运行时模型；保留只为已发布宿主。 */
  getRuntimeCostContexts?: (message: ChatMessage) => ConversationTurnContextView[]
  /**
   * 一次执行的约价（主 Agent 全部模型调用 + 子 Agent 运行），挂在承载运行标记的助手消息上；
   * 不传或返回 null 时回答末尾不显示金额。
   */
  getRunCostEstimate?: (message: ChatMessage) => Nullable<RunCostEstimate>
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
  getRunCostEstimate,
  getGoalCompletionSummary,
  renderActivityLeadingElement,
  renderBeforeMessage,
  renderAfterMessage,
  renderAfterToolCall,
  onOpenBrowserLink: onOpenBrowserLinkProp,
  onOpenFileChange: onOpenFileChangeProp,
  onOpenProjectPath: onOpenProjectPathProp,
  onReviewFileChanges: onReviewFileChangesProp,
  activeUserActionCardIds,
  onResolveUserActionCard: onResolveUserActionCardProp,
  onRewindToMessage: onRewindToMessageProp,
  onTranslateThinkingBlock: onTranslateThinkingBlockProp,
  canRewindToMessage,
  getRewindPlan: getRewindPlanProp,
}: ChatTranscriptProps): ReactElement {
  const onOpenBrowserLink = useStableHostCallback(onOpenBrowserLinkProp)
  const onOpenFileChange = useStableHostCallback(onOpenFileChangeProp)
  const onOpenProjectPath = useStableHostCallback(onOpenProjectPathProp)
  const onReviewFileChanges = useStableHostCallback(onReviewFileChangesProp)
  const onResolveUserActionCard = useStableHostCallback(onResolveUserActionCardProp)
  const onRewindToMessage = useStableHostCallback(onRewindToMessageProp)
  const onTranslateThinkingBlock = useStableHostCallback(onTranslateThinkingBlockProp)
  const getRewindPlan = useStableHostCallback(getRewindPlanProp)
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
    // 约价跟运行标记走：同一轮被引导切开时，标记与约价都在承载整轮的那条消息上。
    const groupedRunCostEstimate = [
      ...activityLeadingMessages,
      message,
      ...activityTrailingMessages,
    ].reduce<Nullable<RunCostEstimate>>(
      (estimate, activityMessage) => toNullable(getRunCostEstimate?.(activityMessage)) ?? estimate,
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
        {/* 消息级渲染兜底（宿主 RenderErrorBoundary）在 MessageBubble 里面、memo 之内：气泡不变时连边界一起跳过。 */}
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
          runCostEstimate={forceActivityFlat ? null : groupedRunCostEstimate}
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
