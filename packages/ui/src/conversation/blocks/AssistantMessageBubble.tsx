import { type ReactElement, type ReactNode, useCallback, useMemo } from 'react'

import { StyleUtils } from '@velaros-ai/ui'

import type { FileChangeSummaryListEntry } from '../cards/FileChangeSummaryList'
import { useConversationI18n } from '../i18n'
import type { ConversationTurnContextView } from '../projection'
import {
  type BrowserScreenshotDisplayMode,
  useConversationRenderSlots,
} from '../render-slots'
import {
  type ChatInlineNoticeMeta,
  type ChatInlineNoticeRuntimeSource,
} from '../status/chatStatus'
import { getLatestPlanToolCallId } from '../tool-render/plan/planToolBlock'
import {
  buildToolRenderSegments,
  isToolActivitySummaryExcludedToolCall,
  type ToolActivitySummaryExclusionPredicate,
} from '../tool-render/toolCallRenderGrouping'

import { AssistantMessageFooter } from './AssistantMessageFooter'
import { AssistantMessageSegments } from './AssistantMessageSegments'
import {
  AssistantProviderArtifactGroup,
  hasVisibleAssistantProviderArtifacts,
} from './AssistantProviderArtifactGroup'
import { hasVisibleBrowserScreenshots } from './browserScreenshotPresence'
import { useChatThinkingVisibility } from './chatThinkingVisibility'
import { useConversationBlockHooks } from './conversationBlockHooks'
import { InlineRuntimeNotice } from './InlineRuntimeNotice'
import { MessageActionList } from './MessageActionList'
import {
  buildMessageRenderSegments,
  type ConversationMessageRunMarker,
  extractMessageText,
  getLastTextSegmentKey,
  getStreamingTextSegmentKey,
  getVisibleMessageBlocks,
  type GoalCompletionActivitySummary,
  hasVisibleSegmentContent,
  shouldShowAssistantGeneratedArtifacts,
} from './messageBubbleRenderModel'
import { estimateAssistantMessageCost } from './messageCostEstimate'
import {
  hasVisibleToolModelImages,
  ToolModelImageGroup,
} from './ToolModelImageGroup'

import styles from './MessageBubble.module.css'

import type {
  ChatMessage,
  ChatProviderId,
  ContentBlock,
  ModelPricingCatalog,
  ProjectRootEntry,
  ToolCallBlock as ToolCallBlockType,
  UserActionCardResult,
} from '#contracts'
import { isEmpty } from '#internal/runtime'

const cx = StyleUtils.bindCx(styles)
const EmptyProjectRoots: ProjectRootEntry[] = []
const EmptyRuntimeCostContexts: ConversationTurnContextView[] = []

function createPlanAwareToolActivityExclusionPredicate(
  latestMessagePlanToolCallId: Nullable<string>
): ToolActivitySummaryExclusionPredicate {
  return (block) => {
    const isExcluded = isToolActivitySummaryExcludedToolCall(block)

    if (block.toolName === 'plan:update')
      return latestMessagePlanToolCallId
        ? block.toolCallId === latestMessagePlanToolCallId
        : isExcluded

    return isExcluded
  }
}

export function AssistantMessageBubble({
  browserScreenshotDisplayMode = 'original',
  message,
  sessionId,
  questionMessage = null,
  isStreaming = false,
  runMarker = null,
  inlineNotice = null,
  inlineNoticeRuntimeSource = null,
  showToolDetails = true,
  planUpdateIndexByToolCallId,
  activeProjectRoot = null,
  projectRoots = EmptyProjectRoots,
  canShowFileChangeSummary = true,
  billingModel = null,
  pricingCatalog = null,
  runtimeCostContexts = EmptyRuntimeCostContexts,
  goalCompletionSummary = null,
  activityLeadingElement = null,
  activityTrailingElement = null,
  renderAfterToolCall,
  onOpenBrowserLink,
  onOpenFileChange,
  onOpenProjectPath,
  onReviewFileChanges,
  activeUserActionCardIds,
  onResolveUserActionCard,
  onTranslateThinkingBlock,
}: {
  browserScreenshotDisplayMode?: BrowserScreenshotDisplayMode
  message: ChatMessage
  sessionId: string
  questionMessage?: LooseOptional<ChatMessage>
  isStreaming?: boolean
  runMarker?: LooseOptional<ConversationMessageRunMarker>
  inlineNotice?: LooseOptional<ChatInlineNoticeMeta>
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
  pricingCatalog?: LooseOptional<ModelPricingCatalog>
  runtimeCostContexts?: ConversationTurnContextView[]
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
  onTranslateThinkingBlock?: (request: {
    messageId: string
    blockIndex: number
    text: string
  }) => Promise<void>
}): Nullable<ReactElement> {
  const { t, locale } = useConversationI18n()
  const showThinkingProcess = useChatThinkingVisibility()
  const { useMessageActionView } = useConversationBlockHooks()
  const copyText = useMemo(() => extractMessageText(message), [message])
  const blockIndexByRef = useMemo(() => {
    const nextBlockIndexByRef = new Map<ContentBlock, number>()

    for (let index = 0; index < message.blocks.length; index += 1) {
      const block = message.blocks[index]
      if (block) nextBlockIndexByRef.set(block, index)
    }

    return nextBlockIndexByRef
  }, [message.blocks])
  const getBlockIndex = useCallback(
    (block: ContentBlock) => blockIndexByRef.get(block),
    [blockIndexByRef]
  )
  const questionText = useMemo(
    () => (questionMessage ? extractMessageText(questionMessage) : ''),
    [questionMessage]
  )
  const answerCostEstimate = useMemo(
    () =>
      billingModel
        ? estimateAssistantMessageCost({
            provider: billingModel.provider,
            model: billingModel.model,
            pricingCatalog,
            question: questionText,
            answer: copyText,
            turnContexts: runtimeCostContexts,
          })
        : null,
    [
      billingModel?.model,
      billingModel?.provider,
      copyText,
      pricingCatalog,
      questionText,
      runtimeCostContexts,
    ]
  )
  const {
    actionRows,
    formatPathForDisplay: formatMessagePathForDisplay,
    hasActionItems,
    openPathInLight,
  } = useMessageActionView({
    activeProjectRoot,
    message,
    onOpenProjectPath,
    sessionId,
    projectRoots,
  })
  const {
    messageRenderSegments,
    visibleBlocks,
    hasVisibleToolBlocks,
    hasRenderableContent,
    lastTextSegmentKey,
    streamingTextSegmentKey,
  } = useMemo(() => {
    const visibleBlocks = getVisibleMessageBlocks(message, showToolDetails, {
      activeUserActionCardIds,
      showThinkingProcess,
    })
    const isPlanAwareToolActivityExcluded = createPlanAwareToolActivityExclusionPredicate(
      getLatestPlanToolCallId(message.blocks)
    )
    const nextRenderableSegments = buildToolRenderSegments(visibleBlocks, undefined, {
      isToolActivitySummaryExcludedToolCall: isPlanAwareToolActivityExcluded,
    })

    return {
      messageRenderSegments: buildMessageRenderSegments(nextRenderableSegments, {
        isToolActivitySummaryExcludedToolCall: isPlanAwareToolActivityExcluded,
      }),
      visibleBlocks,
      hasVisibleToolBlocks: visibleBlocks.some((block) => block.type === 'tool-call'),
      hasRenderableContent: nextRenderableSegments.some(hasVisibleSegmentContent),
      lastTextSegmentKey: getLastTextSegmentKey(nextRenderableSegments),
      streamingTextSegmentKey: getStreamingTextSegmentKey(nextRenderableSegments),
    }
  }, [
    activeUserActionCardIds,
    message,
    showThinkingProcess,
    showToolDetails,
  ])
  const hasBrowserScreenshotGroup = useMemo(
    () => hasVisibleBrowserScreenshots(visibleBlocks),
    [visibleBlocks]
  )
  const hasToolModelImageGroup = useMemo(
    () => hasVisibleToolModelImages(visibleBlocks),
    [visibleBlocks]
  )
  const hasProviderArtifactGroup = useMemo(
    () => hasVisibleAssistantProviderArtifacts(visibleBlocks),
    [visibleBlocks]
  )
  const slots = useConversationRenderSlots()
  const messageArtifactActivityTrailingElement = useMemo(() => {
    const elements: ReactElement[] = []

    if (hasBrowserScreenshotGroup) {
      const browserScreenshotElement = slots.browserScreenshotGroup({
        blocks: visibleBlocks,
        displayMode: browserScreenshotDisplayMode,
        sessionId,
      })
      if (browserScreenshotElement) elements.push(browserScreenshotElement)
    }

    if (hasToolModelImageGroup) {
      elements.push(<ToolModelImageGroup key="tool-model-images" blocks={visibleBlocks} />)
    }

    if (hasProviderArtifactGroup) {
      elements.push(
        <AssistantProviderArtifactGroup
          key="assistant-provider-artifacts"
          blocks={visibleBlocks}
          onOpenBrowserLink={onOpenBrowserLink}
        />
      )
    }

    return isEmpty(elements) ? null : <>{elements}</>
  }, [
    browserScreenshotDisplayMode,
    hasBrowserScreenshotGroup,
    hasProviderArtifactGroup,
    hasToolModelImageGroup,
    onOpenBrowserLink,
    sessionId,
    slots,
    visibleBlocks,
  ])
  const showInlineNotice =
    !!inlineNotice && (!hasRenderableContent || inlineNotice.tone === 'running')
  const showGeneratedArtifacts = shouldShowAssistantGeneratedArtifacts({
    isStreaming,
    runMarker,
  })
  const generatedActivityTrailingElement = showGeneratedArtifacts
    ? messageArtifactActivityTrailingElement
    : null
  const combinedActivityTrailingElement =
    activityTrailingElement || generatedActivityTrailingElement ? (
      <>
        {activityTrailingElement}
        {generatedActivityTrailingElement}
      </>
    ) : null
  const hasGroupedRunActivity = !!activityLeadingElement || !!activityTrailingElement
  const hasVisibleActionItems = hasActionItems && showGeneratedArtifacts

  if (
    !hasRenderableContent &&
    !hasVisibleActionItems &&
    !showInlineNotice &&
    !activityLeadingElement &&
    !combinedActivityTrailingElement
  )
    return null

  return (
    <div
      className={cx('root', 'assistant', hasVisibleToolBlocks && 'assistantWithTools')}
      data-message-id={message.id}
      data-message-role={message.role}
    >
      <div className={cx('assistantRow', hasVisibleToolBlocks && 'assistantRowWithTools')}>
        <div className={cx('assistantBubble', hasVisibleToolBlocks && 'assistantBubbleWithTools')}>
          <AssistantMessageSegments
            messageRenderSegments={messageRenderSegments}
            isStreaming={isStreaming}
            messageId={message.id}
            lastTextSegmentKey={lastTextSegmentKey}
            streamingTextSegmentKey={streamingTextSegmentKey}
            sessionId={sessionId}
            runMarker={runMarker}
            planUpdateIndexByToolCallId={planUpdateIndexByToolCallId}
            getBlockIndex={getBlockIndex}
            formatPathForDisplay={formatMessagePathForDisplay}
            onOpenBrowserLink={onOpenBrowserLink}
            onOpenProjectPath={openPathInLight}
            activeUserActionCardIds={activeUserActionCardIds}
            onResolveUserActionCard={onResolveUserActionCard}
            onTranslateThinkingBlock={onTranslateThinkingBlock}
            goalCompletionSummary={goalCompletionSummary}
            questionMessage={questionMessage}
            activityLeadingElement={activityLeadingElement}
            activityTrailingElement={combinedActivityTrailingElement}
            hasGroupedRunActivity={hasGroupedRunActivity}
            renderAfterToolCall={renderAfterToolCall}
          />

          {canShowFileChangeSummary &&
            showGeneratedArtifacts &&
            slots.messageFileChangeSummary({
              message,
              runMarker,
              sessionId,
              formatPathForDisplay: formatMessagePathForDisplay,
              onOpenEntry: onOpenFileChange,
              onReviewEntries: onReviewFileChanges,
            })}

          {hasActionItems && showGeneratedArtifacts && (
            <MessageActionList rows={actionRows} revealLabel={t('chat.openContainingFolder')} />
          )}

          {showInlineNotice && (
            <InlineRuntimeNotice
              notice={inlineNotice}
              runtimeSource={inlineNoticeRuntimeSource}
              sessionId={sessionId}
            />
          )}
        </div>
        {showGeneratedArtifacts && (
          <AssistantMessageFooter
            message={message}
            answerText={copyText}
            answerCostEstimate={answerCostEstimate}
            copyLabel={t('chat.copyAnswer')}
            copiedLabel={t('chat.codeBlockCopied')}
            locale={locale}
          />
        )}
      </div>
    </div>
  )
}
