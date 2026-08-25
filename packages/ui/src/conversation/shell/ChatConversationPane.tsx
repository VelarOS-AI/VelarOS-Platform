import {
  type CSSProperties,
  lazy,
  type ReactElement,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { SessionStickyDock, type SessionStickyDockItem, StyleUtils } from '@velaros-ai/ui'
import { Paragraph } from '@velaros-ai/ui/primitives/display/Paragraph'
import { ScrollArea } from '@velaros-ai/ui/primitives/layout/ScrollArea'
import { Stack } from '@velaros-ai/ui/primitives/layout/Stack'

import { useChatThinkingVisibility } from '../blocks/chatThinkingVisibility'
import { MessageBubble } from '../blocks/MessageBubble'
import { ChatAwaitingInputCard } from '../cards/ChatAwaitingInputCard'
import { ChatConfirmationCard } from '../cards/ChatConfirmationCard'
import type { FileChangeSummaryListEntry } from '../cards/FileChangeSummaryList'
import { useConversationI18n, useConversationTranslatorRuntime } from '../i18n'
import type {
  ConversationTurnContextView,
  ConversationView,
  ConversationWorkerThread,
} from '../projection'
import type { ConversationRewindPlan } from '../projection'
import {
  type BrowserScreenshotDisplayMode,
  useConversationRenderSlots,
} from '../render-slots'
import { getChatInlineNoticeMeta } from '../status/chatStatus'
import { getPlanToolBlockSignature, isPlanToolBlockComplete } from '../tool-render/plan/planToolBlock'

import { isChatInteractionRunActive, resolveChatInteractionState } from './chatInteractionState'
import { ChatScrollNavigator } from './ChatScrollNavigator'
import { ChatTranscript, type ChatTranscriptNavigationHandle } from './ChatTranscript'
import { resolveActiveTranscriptAssistantMessageId } from './chatTranscriptDerivedIndexes'
import { useConversationActionPort } from './conversationActionPort'
import { useAwaitingConfirmationUserActionCards } from './useAwaitingConfirmationUserActionCards'
import { useChatConversationScroll } from './useChatConversationScroll'
import { useChatConversationTranscriptModel } from './useChatConversationTranscriptModel'
import { useChatTranscriptWindow } from './useChatTranscriptWindow'
import { useQueuedLiveStatusText } from './useQueuedLiveStatusText'
import { groupWorkerThreadsByTranscriptAnchor } from './workerThreadTimeline.pure'

import styles from './ChatConversationPane.module.css'

import type {
  ActiveContextArtifact,
  ChatMessage,
  ProjectRootEntry,
  ToolCallBlock as ToolCallBlockType,
  UserActionCard as UserActionCardType,
  UserActionCardResult,
} from '#contracts'
import { isConversationTurnInputMessage } from '#contracts'
import { buildGoalDockViewModel } from '#internal/goalLifecycle'
import { isEmpty, isPresent, Log, optionalWhenLazy, toNullable, toOptional } from '#internal/runtime'

const cx = StyleUtils.bindCx(styles)
const log = Log.tag('chat-conversation-pane')
const EmptyQueuedMessages: ChatMessage[] = []
const EmptyRuntimeCostContexts: ConversationTurnContextView[] = []
const EmptyWorkerThreads: ConversationWorkerThread[] = []
const EmptyProjectRoots: ProjectRootEntry[] = []
const RuntimeInlineNoticeMessage = {
  id: 'runtime-inline-notice',
  role: 'assistant',
  blocks: [],
  timestamp: 0,
} satisfies ChatMessage

const LazyPlanToolRender = lazy(async () =>
  import('../tool-render/plan/PlanToolRender').then((module) => ({
    default: module.PlanToolRender,
  }))
)

export interface ChatConversationPaneProps {
  browserScreenshotDisplayMode?: BrowserScreenshotDisplayMode
  conversation: ConversationView
  /** 对话代际刷新键：仅用于 remount 消息区，避免连带卸载输入区（如分支面板）。 */
  conversationRefreshKey?: string | number
  composer: ReactNode
  followLocked: boolean
  preflightUserActionCard?: LooseOptional<UserActionCardType>
  scrollRef: React.RefObject<Nullable<HTMLDivElement>>
  /** 宿主收起了滚动导航栏；只有自带头部的宿主会传（开关归它的头部）。 */
  scrollNavigatorHidden?: boolean
  streamSlot?: ReactNode
  variant?: 'default' | 'side'
  onOpenBrowserLink?: (url: string) => void | Promise<void>
  onOpenFileChange?: (entry: FileChangeSummaryListEntry) => void | Promise<void>
  selectedWorkerThreadId?: LooseOptional<string>
  onOpenWorkerThread?: (threadId: string) => void
  onOpenProjectPath?: (path: string) => unknown
  onReviewFileChanges?: (entries: FileChangeSummaryListEntry[]) => void | Promise<void>
  onResolveConfirmation?: (
    approved: boolean,
    rejectionMessage?: LooseOptional<string>,
    options?: { userActionCardResults?: UserActionCardResult[] }
  ) => void
  onSubmitInput?: (answer: string) => void | Promise<void>
  onContinueGoal?: (input: string) => unknown | Promise<unknown>
  onRewindToMessage?: (messageId: string, options?: { restoreFiles?: boolean }) => Promise<void>
  /**
   * 打开回溯确认框那一刻由宿主同步算出的预览。
   *
   * **不给它，回溯按钮点下去就什么都不会发生**（确认框由预览是否存在驱动）。接入方要么两个都给，
   * 要么两个都不给（不给 onRewindToMessage 时按钮本身就不渲染）。
   */
  getRewindPlan?: (messageId: string) => Nullable<ConversationRewindPlan>
  onTranslateThinkingBlock?: (request: {
    messageId: string
    blockIndex: number
    text: string
  }) => Promise<void>
  onDismissConversationCard?: (itemId: string) => void
  /** @deprecated 旧宿主回调名；新代码使用 `onDismissConversationCard`。 */
  onDismissStickyDockItem?: (itemId: string) => void
  onFollowLockedChange: (locked: boolean) => void
  onResolvePreflightUserActionCard?: (result: UserActionCardResult) => void
}

function getLatestPlanToolBlock(messages: ChatMessage[]): Nullable<ToolCallBlockType> {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex]

    if (isConversationTurnInputMessage(message)) return null
    if (message.role !== 'assistant') {
      continue
    }

    for (let blockIndex = message.blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = message.blocks[blockIndex]

      if (block.type === 'tool-call' && block.toolName === 'plan:update') return block
    }
  }

  return null
}

export function ChatConversationPane({
  browserScreenshotDisplayMode = 'original',
  conversation,
  conversationRefreshKey,
  composer,
  followLocked,
  preflightUserActionCard,
  scrollRef,
  streamSlot,
  scrollNavigatorHidden = false,
  variant = 'default',
  onOpenBrowserLink,
  onOpenFileChange,
  selectedWorkerThreadId = null,
  onOpenWorkerThread,
  onOpenProjectPath,
  onReviewFileChanges,
  onResolveConfirmation,
  onSubmitInput,
  onContinueGoal,
  onRewindToMessage,
  getRewindPlan,
  onTranslateThinkingBlock,
  onDismissConversationCard,
  onDismissStickyDockItem,
  onFollowLockedChange,
  onResolvePreflightUserActionCard,
}: ChatConversationPaneProps): ReactElement {
  const showThinkingProcess = useChatThinkingVisibility()
  const { locale, t } = useConversationI18n()
  const translatorRuntime = useConversationTranslatorRuntime()
  const slots = useConversationRenderSlots()
  const actionPort = useConversationActionPort()
  const inputDockRef = useRef<HTMLElement>(null)
  const [inputDockHeight, setInputDockHeight] = useState(0)
  const {
    sessionId,
    messages,
    queuedMessages = EmptyQueuedMessages,
    messageRunMarkers,
    turnContexts = EmptyRuntimeCostContexts,
    workerThreads = EmptyWorkerThreads,
    runtime,
    isStreaming,
    streamingAssistantMessageId,
    hasStreamingThinkingBlock,
    liveTraceSummary,
    runningLabel,
    supportsProjectFiles,
    activeProjectRoot,
    projectRoots = EmptyProjectRoots,
    billingModel = null,
    pricingCatalog = null,
    hasOlderMessages = false,
    isLoadingOlderMessages = false,
    onLoadOlderMessages,
  } = conversation

  // 单一交互状态：等待交互优先于流式标记（isStreaming 残留不再被当作运行中）。
  const interactionState = resolveChatInteractionState(isStreaming, runtime.status)
  const isRunActive = isChatInteractionRunActive(interactionState)
  const [goalLifecycleArtifact, setGoalLifecycleArtifact] =
    useState<Nullable<ActiveContextArtifact>>(null)
  const [goalLifecycleBusy, setGoalLifecycleBusy] = useState(false)

  useLayoutEffect(() => {
    const inputDock = inputDockRef.current
    if (!inputDock) return

    const syncInputDockHeight = (): void => {
      const nextHeight = Math.ceil(inputDock.getBoundingClientRect().height)
      setInputDockHeight((currentHeight) =>
        currentHeight === nextHeight ? currentHeight : nextHeight
      )
    }

    syncInputDockHeight()

    const ResizeObserverConstructor = globalThis.ResizeObserver
    if (!ResizeObserverConstructor) {
      globalThis.addEventListener('resize', syncInputDockHeight)
      return () => globalThis.removeEventListener('resize', syncInputDockHeight)
    }

    const observer = new ResizeObserverConstructor(syncInputDockHeight)
    observer.observe(inputDock)
    return () => observer.disconnect()
  }, [])

  const liveStatusResetKey = [sessionId, runtime.lastRunStartedAt ?? ''].join(':')
  const displayedLiveTraceSummary = useQueuedLiveStatusText(
    liveTraceSummary,
    isRunActive,
    liveStatusResetKey
  )
  const visibleLiveTraceSummary = showThinkingProcess ? displayedLiveTraceSummary : null
  const visibleRuntimeSummary = visibleLiveTraceSummary

  const isAwaitingInput = interactionState === 'awaiting-input'
  const isAwaitingConfirmation = interactionState === 'awaiting-confirmation'
  const shouldRenderAwaitingInputCard = isAwaitingInput && !!onSubmitInput
  const { activeUserActionCards, activeUserActionCardIds, resolveUserActionCard } =
    useAwaitingConfirmationUserActionCards({
      runtime,
      isAwaitingConfirmation,
      onResolveConfirmation,
    })
  const shouldRenderAwaitingConfirmationCard =
    isAwaitingConfirmation && !!onResolveConfirmation && isEmpty(activeUserActionCards)
  const shouldHideInlineNoticeForAwaitingInteraction =
    shouldRenderAwaitingInputCard ||
    shouldRenderAwaitingConfirmationCard ||
    !isEmpty(activeUserActionCardIds)
  const transcriptActiveUserActionCardIds = activeUserActionCardIds

  const refreshGoalLifecycle = useCallback(async (): Promise<void> => {
    try {
      const result = await actionPort.getGoalLifecycle(sessionId)
      if (result.ok) {
        setGoalLifecycleArtifact(result.goal)
      }
    } catch (error) {
      log.warn('读取目标生命周期状态失败', { error, sessionId })
    }
  }, [actionPort, sessionId])

  useEffect(() => {
    let active = true
    void actionPort
      .getGoalLifecycle(sessionId)
      .then((result) => {
        if (active && result.ok) {
          setGoalLifecycleArtifact(result.goal)
        }
      })
      .catch((error) => {
        if (active) {
          log.warn('刷新目标生命周期状态失败', { error, sessionId })
        }
      })

    return () => {
      active = false
    }
  }, [actionPort, sessionId, messages.length, runtime.lastRunFinishedAt, runtime.status])

  const goalDockModel = useMemo(
    () => (goalLifecycleArtifact ? buildGoalDockViewModel(goalLifecycleArtifact) : null),
    [goalLifecycleArtifact]
  )

  const handleGoalLifecycleAction = useCallback(
    async (action: Parameters<typeof actionPort.updateGoalLifecycle>[1]): Promise<boolean> => {
      if (goalLifecycleBusy) return false
      setGoalLifecycleBusy(true)
      try {
        const result = await actionPort.updateGoalLifecycle(sessionId, action)
        if (result.ok) {
          setGoalLifecycleArtifact(action === 'remove' ? null : result.goal)
          return true
        }
        await refreshGoalLifecycle()
        return false
      } catch (error) {
        log.warn('更新目标生命周期状态失败', { action, error, sessionId })
        await refreshGoalLifecycle()
        return false
      } finally {
        setGoalLifecycleBusy(false)
      }
    },
    [actionPort, goalLifecycleBusy, refreshGoalLifecycle, sessionId]
  )

  const handleContinueGoal = useCallback(async (): Promise<void> => {
    const resumed = await handleGoalLifecycleAction('resume')
    if (!resumed) return

    const guidance = t('chat.goalDockContinueGuidance')
    if (!isRunActive) {
      await onContinueGoal?.(guidance)
      return
    }

    try {
      await actionPort.provideExecutionGuidance(sessionId, guidance)
    } catch (error) {
      log.warn('发送目标继续引导失败', { error, sessionId })
      await refreshGoalLifecycle()
    }
  }, [actionPort, handleGoalLifecycleAction, isRunActive, onContinueGoal, refreshGoalLifecycle, sessionId, t])

  const canRewindToMessage = interactionState === 'idle'
  const presentationRuntime = runtime
  const inlineNotice = shouldHideInlineNoticeForAwaitingInteraction
    ? null
    : getChatInlineNoticeMeta(presentationRuntime, locale, {
        liveTraceSummary: toOptional(visibleRuntimeSummary),
      }, translatorRuntime)
  const inlineNoticeRuntimeSource = useMemo(() => {
    if (inlineNotice?.tone !== 'running' || presentationRuntime.status !== 'running') return null

    return isPresent(visibleRuntimeSummary)
      ? { runtime: presentationRuntime, liveTraceSummary: visibleRuntimeSummary }
      : { runtime: presentationRuntime }
  }, [inlineNotice?.tone, presentationRuntime, visibleRuntimeSummary])
  const {
    messageRunMarkerMap,
    latestAssistantMessageId,
    runtimeCostContextMap,
    planUpdateIndexByToolCallId,
    assistantQuestionMap,
    goalCompletionSummaryByMessageId,
    visibleMessages,
  } = useChatConversationTranscriptModel({
    messages,
    queuedMessages,
    messageRunMarkers,
    turnContexts,
    runtime,
    billingModel,
    pricingCatalog,
    shouldRenderAwaitingInputCard,
  })
  const isTranscriptRunActive = isRunActive
  const activeAssistantMessageId = resolveActiveTranscriptAssistantMessageId({
    isRunActive: isTranscriptRunActive,
    streamingAssistantMessageId,
    latestAssistantMessageId,
    latestAssistantRunMarker: latestAssistantMessageId
      ? messageRunMarkerMap.get(latestAssistantMessageId)
      : null,
  })
  const transcriptNavigationRef = useRef<Nullable<ChatTranscriptNavigationHandle>>(null)
  const { windowMessages, isWindowAtLoadedTop } = useChatTranscriptWindow({
    messages: visibleMessages,
    sessionId,
    scrollRef,
    transcriptNavigationRef,
    pinnedMessageId: activeAssistantMessageId,
    hasOlderMessages,
    onLoadOlderMessages,
  })
  const { loadMoreSentinelRef } = useChatConversationScroll({
    sessionId,
    conversationRefreshKey,
    hasOlderMessages,
    isLoadingOlderMessages,
    onLoadOlderMessages,
    enableOlderMessageSentinel: isWindowAtLoadedTop,
  })
  const activeDockPlanBlock = useMemo(() => {
    const latestPlanBlock = getLatestPlanToolBlock(messages)

    return latestPlanBlock && !isPlanToolBlockComplete(latestPlanBlock) ? latestPlanBlock : null
  }, [messages])
  const activeDockPlanItemId = optionalWhenLazy(
    activeDockPlanBlock,
    () => `plan-update:${activeDockPlanBlock!.toolCallId}`
  )
  const goalLifecycleDockItemId = optionalWhenLazy(
    goalDockModel,
    () => `goal-lifecycle:${goalDockModel!.id}:${goalDockModel!.status}`
  )
  const activeDockPlanRevealKey = optionalWhenLazy(activeDockPlanBlock, () =>
    getPlanToolBlockSignature(activeDockPlanBlock!)
  )
  const goalLifecycleRevealKey = optionalWhenLazy(goalDockModel, () =>
    [
      goalDockModel!.id,
      goalDockModel!.status,
      goalDockModel!.updatedAt,
      goalDockModel!.blockedAuditTurns,
    ].join(':')
  )
  const goalLifecycleCollapseKey = optionalWhenLazy(
    goalLifecycleArtifact && !goalDockModel,
    () =>
      [
        goalLifecycleArtifact!.id,
        goalLifecycleArtifact!.status,
        goalLifecycleArtifact!.metadata?.goalStatus,
        goalLifecycleArtifact!.updatedAt,
      ].join(':')
  )
  const activeDockStatusSpotlightItemIds = useMemo(
    () => [goalLifecycleDockItemId, activeDockPlanItemId].filter(isPresent),
    [activeDockPlanItemId, goalLifecycleDockItemId]
  )
  const inlineNoticeMessageId = activeAssistantMessageId ?? latestAssistantMessageId
  const conversationCards = useMemo(
    () => runtime.conversationCards ?? runtime.stickyDockItems ?? [],
    [runtime.conversationCards, runtime.stickyDockItems]
  )
  const dismissConversationCard = onDismissConversationCard ?? onDismissStickyDockItem
  const inlineConversationCards = useMemo<ReactElement[]>(() => {
    const cards: ReactElement[] = []

    for (const item of conversationCards) {
      const onDismiss = optionalWhenLazy(
        dismissConversationCard,
        () => () => dismissConversationCard!(item.id)
      )

      if (item.kind === 'handoff-suggestion') {
        const content = slots.conversationCardContent({
          kind: 'handoff-suggestion',
          card: item.card,
          sessionId,
          onResolve: (resolution) =>
            actionPort.resolveHandoffSuggestion({
              sessionId,
              cardId: item.card.id,
              // 只有"确认转交"这个正向动作算批准；拒绝/跳过/关闭一律进冷却。
              approved: resolution.approved && resolution.actionKind === 'acknowledge',
            }),
          onOpenArtifact: onOpenProjectPath,
        })
        if (content)
          cards.push(
            <div key={item.id} className={styles.inlineConversationCard}>
              {content}
            </div>
          )
        continue
      }

      if (item.kind === 'project-auto-approval') {
        const content = slots.conversationCardContent({
          kind: 'project-auto-approval',
          notice: item.notice,
          onDismiss,
        })
        if (content)
          cards.push(
            <div key={item.id} className={styles.inlineConversationCard}>
              {content}
            </div>
          )
      }
    }

    if (preflightUserActionCard) {
      const content = slots.conversationCardContent({
        kind: 'preflight-action',
        card: preflightUserActionCard,
        sessionId,
        onOpenArtifact: onOpenProjectPath,
        onResolve: (resolution) =>
          onResolvePreflightUserActionCard?.({
            cardId: preflightUserActionCard.id,
            ...resolution,
          }),
      })
      if (content)
        cards.push(
          <div
            key={`preflight-action:${preflightUserActionCard.id}`}
            className={styles.inlineConversationCard}
          >
            {content}
          </div>
        )
    }

    return cards
  }, [
    actionPort,
    conversationCards,
    dismissConversationCard,
    onOpenProjectPath,
    onResolvePreflightUserActionCard,
    preflightUserActionCard,
    sessionId,
    slots,
  ])
  const stickyDockItems = useMemo<SessionStickyDockItem[]>(() => {
    const dockItems: SessionStickyDockItem[] = []

    if (goalDockModel && goalLifecycleDockItemId) {
      dockItems.push({
        id: goalLifecycleDockItemId,
        createdAt: goalDockModel.updatedAt,
        content: slots.conversationCardContent({
          kind: 'goal-lifecycle',
          model: goalDockModel,
          busy: goalLifecycleBusy,
          onAction: handleGoalLifecycleAction,
          onContinue: handleContinueGoal,
        }),
      })
    }

    if (activeDockPlanBlock && activeDockPlanItemId) {
      dockItems.push({
        id: activeDockPlanItemId,
        createdAt: activeDockPlanBlock.finishedAt ?? activeDockPlanBlock.startedAt,
        content: (
          <Suspense fallback={null}>
            <LazyPlanToolRender block={activeDockPlanBlock} compact variant="plain" />
          </Suspense>
        ),
      })
    }

    return dockItems
  }, [
    activeDockPlanBlock,
    activeDockPlanItemId,
    goalDockModel,
    goalLifecycleBusy,
    goalLifecycleDockItemId,
    handleContinueGoal,
    handleGoalLifecycleAction,
    slots,
  ])
  const getTranscriptQuestionMessage = useCallback(
    (message: ChatMessage) => toNullable(assistantQuestionMap.get(message.id)),
    [assistantQuestionMap]
  )
  const getTranscriptIsStreaming = useCallback(
    (message: ChatMessage) => isTranscriptRunActive && message.id === activeAssistantMessageId,
    [activeAssistantMessageId, isTranscriptRunActive]
  )
  const getTranscriptRunMarker = useCallback(
    (message: ChatMessage) => toNullable(messageRunMarkerMap.get(message.id)),
    [messageRunMarkerMap]
  )
  const getTranscriptInlineNotice = useCallback(
    (message: ChatMessage) => (message.id === inlineNoticeMessageId ? inlineNotice : null),
    [inlineNotice, inlineNoticeMessageId]
  )
  const getTranscriptRuntimeCostContexts = useCallback(
    (message: ChatMessage) => runtimeCostContextMap.get(message.id) ?? EmptyRuntimeCostContexts,
    [runtimeCostContextMap]
  )
  const getTranscriptGoalCompletionSummary = useCallback(
    (message: ChatMessage) => toNullable(goalCompletionSummaryByMessageId.get(message.id)),
    [goalCompletionSummaryByMessageId]
  )
  const workerThreadPlacement = useMemo(
    () => groupWorkerThreadsByTranscriptAnchor(visibleMessages, workerThreads),
    [visibleMessages, workerThreads]
  )
  const renderWorkerThreadPanel = useCallback(
    (threads: ConversationWorkerThread[]) =>
      slots.workerThreadPanel({
        threads,
        sessionId,
        variant,
        selectedThreadId: selectedWorkerThreadId,
        onOpenThread: onOpenWorkerThread,
      }),
    [onOpenWorkerThread, selectedWorkerThreadId, sessionId, slots, variant]
  )
  const renderWorkerThreadsAfterMessage = useCallback(
    (message: ChatMessage) => {
      const threads = workerThreadPlacement.afterMessageId.get(message.id)

      return threads && !isEmpty(threads) ? renderWorkerThreadPanel(threads) : null
    },
    [renderWorkerThreadPanel, workerThreadPlacement]
  )
  const renderWorkerThreadsAfterToolCall = useCallback(
    (block: ToolCallBlockType) => {
      const threads = workerThreadPlacement.afterToolCallId.get(block.toolCallId)

      return threads && !isEmpty(threads) ? renderWorkerThreadPanel(threads) : null
    },
    [renderWorkerThreadPanel, workerThreadPlacement]
  )
  return (
    <section
      className={cx('chatPane', variant === 'side' && 'chatPaneSide')}
      data-tour-id="chat-conversation"
      style={{ '--chat-input-dock-height': `${inputDockHeight}px` } as CSSProperties}
    >
      <div key={conversationRefreshKey} className={styles.conversationBody}>
        <ScrollArea
          ref={scrollRef}
          className={styles.messageList}
          data-tour-id="chat-output"
          aria-label={t('chat.messagesRegionAriaLabel')}
        >
          <Stack
            className={cx('messageListInner', variant === 'side' && 'messageListInnerSide')}
            gap="lg"
          >
            {/* 向上翻页哨兵：窗口已在已加载顶端时，满屏前即触发从磁盘加载更旧消息 */}
            {hasOlderMessages && isWindowAtLoadedTop && (
              <div ref={loadMoreSentinelRef} className={styles.loadMoreSentinel}>
                {isLoadingOlderMessages ? '...' : null}
              </div>
            )}
            <SessionStickyDock
              variant={variant}
              items={stickyDockItems}
              barLabel={t('sessionStickyDock.barLabel')}
              autoRevealKey={goalLifecycleRevealKey ?? activeDockPlanRevealKey}
              autoCollapseKey={goalLifecycleCollapseKey}
              spotlightItemIds={activeDockStatusSpotlightItemIds}
            />
            {!isEmpty(workerThreadPlacement.beforeTranscript)
              ? renderWorkerThreadPanel(workerThreadPlacement.beforeTranscript)
              : null}
            <ChatTranscript
              messages={windowMessages}
              browserScreenshotDisplayMode={browserScreenshotDisplayMode}
              sessionId={sessionId}
              className={styles.messageSequence}
              pricingCatalog={pricingCatalog}
              getQuestionMessage={getTranscriptQuestionMessage}
              getIsStreaming={getTranscriptIsStreaming}
              getRunMarker={getTranscriptRunMarker}
              getInlineNotice={getTranscriptInlineNotice}
              inlineNoticeRuntimeSource={inlineNoticeRuntimeSource}
              showToolDetails
              planUpdateIndexByToolCallId={planUpdateIndexByToolCallId}
              activeProjectRoot={activeProjectRoot}
              projectRoots={projectRoots}
              canShowFileChangeSummary={supportsProjectFiles}
              billingModel={billingModel}
              getRuntimeCostContexts={getTranscriptRuntimeCostContexts}
              getGoalCompletionSummary={getTranscriptGoalCompletionSummary}
              renderAfterMessage={renderWorkerThreadsAfterMessage}
              renderAfterToolCall={renderWorkerThreadsAfterToolCall}
              onOpenBrowserLink={onOpenBrowserLink}
              onOpenFileChange={onOpenFileChange}
              onOpenProjectPath={onOpenProjectPath}
              onReviewFileChanges={onReviewFileChanges}
              activeUserActionCardIds={transcriptActiveUserActionCardIds}
              onResolveUserActionCard={resolveUserActionCard}
              onRewindToMessage={onRewindToMessage}
              onTranslateThinkingBlock={onTranslateThinkingBlock}
              canRewindToMessage={canRewindToMessage}
              getRewindPlan={getRewindPlan}
            />
            {inlineConversationCards}
            {!!streamSlot && <div className={styles.streamSlot}>{streamSlot}</div>}
            {!inlineNoticeMessageId && inlineNotice && (
              <MessageBubble
                message={RuntimeInlineNoticeMessage}
                sessionId={sessionId}
                browserScreenshotDisplayMode={browserScreenshotDisplayMode}
                inlineNotice={inlineNotice}
                inlineNoticeRuntimeSource={inlineNoticeRuntimeSource}
                showToolDetails
                planUpdateIndexByToolCallId={planUpdateIndexByToolCallId}
                activeProjectRoot={activeProjectRoot}
                projectRoots={projectRoots}
                canShowFileChangeSummary={supportsProjectFiles}
                billingModel={billingModel}
                pricingCatalog={pricingCatalog}
                runtimeCostContexts={EmptyRuntimeCostContexts}
                onOpenBrowserLink={onOpenBrowserLink}
                onOpenFileChange={onOpenFileChange}
                onOpenProjectPath={onOpenProjectPath}
                onReviewFileChanges={onReviewFileChanges}
                activeUserActionCardIds={transcriptActiveUserActionCardIds}
                onResolveUserActionCard={resolveUserActionCard}
                onTranslateThinkingBlock={onTranslateThinkingBlock}
              />
            )}
            {shouldRenderAwaitingInputCard && (
              <ChatAwaitingInputCard
                question={runtime.awaitingInputQuestion}
                onSubmit={onSubmitInput}
              />
            )}
            {shouldRenderAwaitingConfirmationCard && (
              <ChatConfirmationCard
                message={runtime.awaitingConfirmationMessage}
                detail={runtime.awaitingConfirmationDetail}
                onApprove={() => onResolveConfirmation(true)}
                onReject={(rejectionMessage) => onResolveConfirmation(false, rejectionMessage)}
              />
            )}
            {isStreaming &&
              (!showThinkingProcess || !hasStreamingThinkingBlock) &&
              !inlineNotice && (
                <div className={styles.thinkingRow}>
                  <div className={styles.thinkingText}>
                    <span className={styles.thinkingDot} />
                    <Paragraph spacing="none">{visibleRuntimeSummary ?? runningLabel}</Paragraph>
                  </div>
                </div>
              )}
          </Stack>
        </ScrollArea>

        <ChatScrollNavigator
          hidden={scrollNavigatorHidden}
          followLocked={followLocked}
          onFollowLockedChange={onFollowLockedChange}
          scrollRef={scrollRef}
          transcriptNavigationRef={transcriptNavigationRef}
        />
      </div>

      <section
        ref={inputDockRef}
        className={styles.inputDock}
        aria-label={t('chat.composerRegionAriaLabel')}
      >
        <div className={cx('inputDockInner', variant === 'side' && 'inputDockInnerSide')}>
          <div className={styles.inputDockSurface}>{composer}</div>
        </div>
      </section>
    </section>
  )
}
