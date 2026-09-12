import { useMemo, useRef } from 'react'

import type { GoalCompletionActivitySummary } from '../blocks/messageBubbleRenderModel'
import type { RunCostEstimate } from '../blocks/messageCostEstimate'
import type { ConversationMessageRunMarker, ConversationRuntimeView } from '../projection'

import { buildChatTranscriptDerivedIndexes } from './chatTranscriptDerivedIndexes'
import { buildRunCostEstimates, reuseStableRunCostEstimates } from './runCostEstimates'

import type { ChatMessage, ChatProviderId, ModelPricingCatalog } from '#contracts'
import { isFiniteNumber, isNull, isPresent, toNullable } from '#internal/runtime'

type RuntimeUsageTelemetry = ConversationRuntimeView['usageTelemetry']
type RuntimeUsageTelemetryEntry = RuntimeUsageTelemetry[number]

interface GoalCompletionRunWindowInput {
  runMarker: ConversationMessageRunMarker
  lastRunStartedAt: Nullable<number>
  lastRunFinishedAt: Nullable<number>
}

interface GoalCompletionRunWindow {
  startedAt: Nullable<number>
  finishedAt: number
  durationMs: Nullable<number>
}

function isRuntimeTimestamp(value: LooseOptional<number>): value is number {
  return isFiniteNumber(value) && value >= 0
}

/**
 * 优先使用消息级执行时间。会话级时间只表示最近一次执行；完成后若立即追加任务，
 * 它会被下一次执行覆盖，不能再拿来反推上一条完成消息的耗时。
 */
export function resolveGoalCompletionRunWindow({
  runMarker,
  lastRunStartedAt,
  lastRunFinishedAt,
}: GoalCompletionRunWindowInput): GoalCompletionRunWindow {
  const finishedAt = runMarker.timestamp
  const markerStartedAt = isRuntimeTimestamp(runMarker.startedAt) ? runMarker.startedAt : null
  const runtimeStartedAt =
    isRuntimeTimestamp(lastRunStartedAt) && lastRunStartedAt <= finishedAt
      ? lastRunStartedAt
      : null
  const startedAt = markerStartedAt ?? runtimeStartedAt
  const markerDurationMs = isFiniteNumber(runMarker.durationMs)
    ? Math.max(0, runMarker.durationMs)
    : null
  const inferredDurationMs =
    isRuntimeTimestamp(startedAt) && finishedAt >= startedAt ? finishedAt - startedAt : null
  const runtimeFinishedAt =
    isRuntimeTimestamp(lastRunFinishedAt) && lastRunFinishedAt === finishedAt
      ? lastRunFinishedAt
      : finishedAt

  return {
    startedAt,
    finishedAt: isNull(markerDurationMs) ? runtimeFinishedAt : finishedAt,
    durationMs: markerDurationMs ?? inferredDurationMs,
  }
}

function filterUsageTelemetryByRunWindow(
  entries: RuntimeUsageTelemetry,
  startedAt: Nullable<number>,
  finishedAt: Nullable<number>
): RuntimeUsageTelemetry {
  if (!isRuntimeTimestamp(startedAt)) return entries

  return entries.filter((entry) => {
    if (!isRuntimeTimestamp(entry.timestamp)) return true
    if (entry.timestamp < startedAt) return false
    if (isRuntimeTimestamp(finishedAt) && entry.timestamp > finishedAt) return false

    return true
  })
}

function readUsageEntryTotalTokens(entry: RuntimeUsageTelemetryEntry): Nullable<number> {
  if (isFiniteNumber(entry.totalTokens)) return Math.max(0, entry.totalTokens)

  const inputTokens = isFiniteNumber(entry.inputTokens) ? entry.inputTokens : null
  const outputTokens = isFiniteNumber(entry.outputTokens) ? entry.outputTokens : null
  if (!isPresent(inputTokens) && !isPresent(outputTokens)) return null

  return Math.max(0, inputTokens ?? 0) + Math.max(0, outputTokens ?? 0)
}

function sumUsageTelemetryTotalTokens(entries: RuntimeUsageTelemetry): Nullable<number> {
  let total = 0
  let hasTokenUsage = false

  entries.forEach((entry) => {
    const entryTokens = readUsageEntryTotalTokens(entry)
    if (!isPresent(entryTokens)) return

    total += entryTokens
    hasTokenUsage = true
  })

  return hasTokenUsage ? total : null
}

interface UseChatConversationTranscriptModelOptions {
  messages: ChatMessage[]
  queuedMessages: ChatMessage[]
  messageRunMarkers: ConversationMessageRunMarker[]
  runtime: Pick<
    ConversationRuntimeView,
    'awaitingInputQuestion' | 'lastRunStartedAt' | 'lastRunFinishedAt' | 'usageTelemetry'
  >
  billingModel: LooseOptional<{
    provider: ChatProviderId
    model: string
  }>
  pricingCatalog?: LooseOptional<ModelPricingCatalog>
  shouldRenderAwaitingInputCard: boolean
}

export interface UseChatConversationTranscriptModelReturn {
  messageRunMarkerMap: Map<string, ConversationMessageRunMarker>
  latestAssistantMessageId: Nullable<string>
  hasTurnInputAfterLatestAssistant: boolean
  latestCompletedAssistantMessageId: Nullable<string>
  /** 每次执行的约价，键是承载运行标记的助手消息 id（见 {@link buildRunCostEstimates}）。 */
  runCostEstimateByMessageId: ReadonlyMap<string, RunCostEstimate>
  planUpdateIndexByToolCallId: Map<string, number>
  assistantQuestionMap: Map<string, ChatMessage>
  goalCompletionSummaryByMessageId: Map<string, GoalCompletionActivitySummary>
  activeAwaitingInputMessageId: Nullable<string>
  visibleMessages: ChatMessage[]
}

/** 对话 transcript 渲染所需的派生索引与可见消息列表。 */
export function useChatConversationTranscriptModel({
  messages,
  queuedMessages,
  messageRunMarkers,
  runtime,
  billingModel,
  pricingCatalog,
  shouldRenderAwaitingInputCard,
}: UseChatConversationTranscriptModelOptions): UseChatConversationTranscriptModelReturn {
  const messageRunMarkerMap = useMemo(() => {
    const nextMessageRunMarkerMap = new Map<string, ConversationMessageRunMarker>()

    for (const marker of messageRunMarkers) {
      nextMessageRunMarkerMap.set(marker.messageId, marker)
    }

    return nextMessageRunMarkerMap
  }, [messageRunMarkers])
  const {
    latestAssistantMessage,
    hasTurnInputAfterLatestAssistant,
    latestCompletedAssistantMessageId,
    planUpdateIndexByToolCallId,
    assistantQuestionMap,
    activeAwaitingInputMessageId,
  } = useMemo(
    () =>
      buildChatTranscriptDerivedIndexes({
        messages,
        messageRunMarkerMap,
        shouldRenderAwaitingInputCard,
        awaitingInputQuestion: runtime.awaitingInputQuestion,
      }),
    [messageRunMarkerMap, messages, runtime.awaitingInputQuestion, shouldRenderAwaitingInputCard]
  )
  const previousRunCostEstimatesRef = useRef<Nullable<ReadonlyMap<string, RunCostEstimate>>>(null)
  const runCostEstimateByMessageId = useMemo(() => {
    const estimates = reuseStableRunCostEstimates(
      previousRunCostEstimatesRef.current,
      buildRunCostEstimates({
        messages,
        messageRunMarkerMap,
        usageTelemetry: runtime.usageTelemetry,
        billingModel,
        pricingCatalog,
      })
    )
    previousRunCostEstimatesRef.current = estimates
    return estimates
  }, [billingModel, messageRunMarkerMap, messages, pricingCatalog, runtime.usageTelemetry])
  const goalCompletionSummaryByMessageId = useMemo(() => {
    const nextMap = new Map<string, GoalCompletionActivitySummary>()
    if (!latestCompletedAssistantMessageId) return nextMap

    const runMarker = messageRunMarkerMap.get(latestCompletedAssistantMessageId)
    if (runMarker?.status !== 'completed' || runMarker.goalStatus !== 'complete') return nextMap

    const runWindow = resolveGoalCompletionRunWindow({
      runMarker,
      lastRunStartedAt: runtime.lastRunStartedAt,
      lastRunFinishedAt: runtime.lastRunFinishedAt,
    })
    const { durationMs, finishedAt, startedAt } = runWindow
    // 成本与 token 与回答末尾的约价同源：整次执行（全部轮次 + 子 Agent）。约价未知时只报遥测
    // 里的 token 数，不再用可见问答文字凑一个金额。
    const runCost = runCostEstimateByMessageId.get(latestCompletedAssistantMessageId)
    const totalTokens = runCost
      ? runCost.inputTokens + runCost.outputTokens
      : sumUsageTelemetryTotalTokens(
          filterUsageTelemetryByRunWindow(runtime.usageTelemetry, startedAt, finishedAt)
        )
    const costUsd = toNullable(runCost?.usd)

    if (!isPresent(durationMs) && !isPresent(totalTokens) && !isPresent(costUsd)) return nextMap

    nextMap.set(latestCompletedAssistantMessageId, {
      durationMs,
      totalTokens,
      costUsd,
      costIsLowerBound: runCost?.coverage === 'partial',
    })
    return nextMap
  }, [
    latestCompletedAssistantMessageId,
    messageRunMarkerMap,
    runCostEstimateByMessageId,
    runtime.lastRunFinishedAt,
    runtime.lastRunStartedAt,
    runtime.usageTelemetry,
  ])
  const visibleMessages = useMemo(() => {
    const baseMessages = activeAwaitingInputMessageId
      ? messages.filter((message) => message.id !== activeAwaitingInputMessageId)
      : messages

    return queuedMessages.length ? [...baseMessages, ...queuedMessages] : baseMessages
  }, [activeAwaitingInputMessageId, messages, queuedMessages])

  return {
    messageRunMarkerMap,
    latestAssistantMessageId: toNullable(latestAssistantMessage?.id),
    hasTurnInputAfterLatestAssistant,
    latestCompletedAssistantMessageId,
    runCostEstimateByMessageId,
    planUpdateIndexByToolCallId,
    assistantQuestionMap,
    goalCompletionSummaryByMessageId,
    activeAwaitingInputMessageId,
    visibleMessages,
  }
}
