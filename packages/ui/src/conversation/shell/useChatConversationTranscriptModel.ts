import { useMemo } from 'react'

import type { GoalCompletionActivitySummary } from '../blocks/messageBubbleRenderModel'
import { estimateSessionCost } from '../blocks/messageCostEstimate'
import type {
  ConversationMessageRunMarker,
  ConversationRuntimeView,
  ConversationTurnContextView,
} from '../projection'

import { buildChatTranscriptDerivedIndexes } from './chatTranscriptDerivedIndexes'

import type { ChatMessage, ChatProviderId, ModelPricingCatalog } from '#contracts'
import {
  isEmpty,
  isFiniteNumber,
  isNumber,
  isPositiveNumber,
  isPresent,
  isTrue,
  toNullable,
} from '#internal/runtime'

type RuntimeUsageTelemetry = ConversationRuntimeView['usageTelemetry']
type RuntimeUsageTelemetryEntry = RuntimeUsageTelemetry[number]

function isRuntimeTimestamp(value: LooseOptional<number>): value is number {
  return isFiniteNumber(value) && value >= 0
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

function sumUsageTelemetryReportedCostUsd(entries: RuntimeUsageTelemetry): Nullable<number> {
  let total = 0
  let hasReportedCost = false

  entries.forEach((entry) => {
    if (!isFiniteNumber(entry.costUsd)) return

    total += Math.max(0, entry.costUsd)
    hasReportedCost = true
  })

  return hasReportedCost ? total : null
}

function getRuntimeCostContextsForTurn(
  turnContexts: ConversationTurnContextView[],
  maxTurn: Nullable<number>
): ConversationTurnContextView[] {
  if (!isPresent(maxTurn)) return turnContexts

  for (let index = 0; index < turnContexts.length; index += 1) {
    const context = turnContexts[index]
    if (context && context.turn > maxTurn)
      return turnContexts.filter((item) => item.turn <= maxTurn)
  }

  return turnContexts
}

interface UseChatConversationTranscriptModelOptions {
  messages: ChatMessage[]
  queuedMessages: ChatMessage[]
  messageRunMarkers: ConversationMessageRunMarker[]
  turnContexts: ConversationTurnContextView[]
  runtime: Pick<
    ConversationRuntimeView,
    | 'awaitingInputQuestion'
    | 'completedTurns'
    | 'activeTurn'
    | 'lastRunStartedAt'
    | 'lastRunFinishedAt'
    | 'usageTelemetry'
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
  latestCompletedAssistantMessageId: Nullable<string>
  runtimeCostContextMap: Map<string, ConversationTurnContextView[]>
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
  turnContexts,
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
    latestCompletedAssistantMessage,
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
  const runtimeCostContextMap = useMemo(() => {
    const nextMap = new Map<string, ConversationTurnContextView[]>()

    if (!latestAssistantMessage || isEmpty(turnContexts)) return nextMap

    const marker = messageRunMarkerMap.get(latestAssistantMessage.id)
    const maxTurn =
      isNumber(marker?.turnCount) && Number.isFinite(marker.turnCount)
        ? marker.turnCount
        : isPositiveNumber(runtime.completedTurns)
          ? runtime.completedTurns
          : isPositiveNumber(runtime.activeTurn)
            ? runtime.activeTurn
            : null
    const latestRunContexts = getRuntimeCostContextsForTurn(turnContexts, maxTurn)

    if (!isEmpty(latestRunContexts)) {
      nextMap.set(latestAssistantMessage.id, latestRunContexts)
    }

    return nextMap
  }, [
    latestAssistantMessage,
    messageRunMarkerMap,
    runtime.activeTurn,
    runtime.completedTurns,
    turnContexts,
  ])
  const goalCompletionSummaryByMessageId = useMemo(() => {
    const nextMap = new Map<string, GoalCompletionActivitySummary>()
    if (!latestCompletedAssistantMessageId) return nextMap

    const runMarker = messageRunMarkerMap.get(latestCompletedAssistantMessageId)
    if (runMarker?.status !== 'completed' || !isTrue(runMarker.goalMode)) return nextMap

    const finishedAt = runtime.lastRunFinishedAt ?? runMarker.timestamp
    const durationMs =
      isRuntimeTimestamp(runtime.lastRunStartedAt) && isRuntimeTimestamp(finishedAt)
        ? Math.max(0, finishedAt - runtime.lastRunStartedAt)
        : null
    const runUsageTelemetry = filterUsageTelemetryByRunWindow(
      runtime.usageTelemetry,
      runtime.lastRunStartedAt,
      finishedAt
    )
    const assistantMessage = latestCompletedAssistantMessage
    const questionMessage = assistantQuestionMap.get(latestCompletedAssistantMessageId)
    const costEstimate = billingModel
      ? estimateSessionCost({
          provider: billingModel.provider,
          model: billingModel.model,
          pricingCatalog,
          messages: [questionMessage, assistantMessage].filter(isPresent),
          turnContexts: runtimeCostContextMap.get(latestCompletedAssistantMessageId) ?? [],
          usageTelemetry: runUsageTelemetry,
        })
      : null
    const totalTokens =
      sumUsageTelemetryTotalTokens(runUsageTelemetry) ??
      (costEstimate ? costEstimate.inputTokens + costEstimate.outputTokens : null)
    const costUsd = costEstimate?.hasUnpricedUsage
      ? null
      : (costEstimate?.usd ?? sumUsageTelemetryReportedCostUsd(runUsageTelemetry))

    if (!isPresent(durationMs) && !isPresent(totalTokens) && !isPresent(costUsd)) return nextMap

    nextMap.set(latestCompletedAssistantMessageId, {
      durationMs,
      totalTokens,
      costUsd,
    })
    return nextMap
  }, [
    assistantQuestionMap,
    billingModel,
    latestCompletedAssistantMessage,
    latestCompletedAssistantMessageId,
    messageRunMarkerMap,
    pricingCatalog,
    runtime.lastRunFinishedAt,
    runtime.lastRunStartedAt,
    runtime.usageTelemetry,
    runtimeCostContextMap,
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
    latestCompletedAssistantMessageId,
    runtimeCostContextMap,
    planUpdateIndexByToolCallId,
    assistantQuestionMap,
    goalCompletionSummaryByMessageId,
    activeAwaitingInputMessageId,
    visibleMessages,
  }
}
