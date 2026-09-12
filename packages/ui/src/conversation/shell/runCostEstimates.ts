import {
  areRunCostEstimatesEqual,
  estimateRunCost,
  type RunCostEstimate,
} from '../blocks/messageCostEstimate'
import {
  addConversationRunTranscriptSubAgentUsage,
  addConversationRunUsageTelemetry,
  createConversationRunUsage,
} from '../blocks/runUsage'
import type { ConversationMessageRunMarker, ConversationRunUsage } from '../projection'

import type {
  ChatMessage,
  ChatProviderId,
  ModelPricingCatalog,
  StreamUsageTelemetryPayload,
} from '#contracts'
import { isConversationTurnInputMessage } from '#contracts'
import { isArray, isEmpty, isFiniteNumber, isPresent } from '#internal/runtime'

export interface RunCostEstimatesInput {
  messages: readonly ChatMessage[]
  messageRunMarkerMap: ReadonlyMap<string, ConversationMessageRunMarker>
  usageTelemetry: readonly StreamUsageTelemetryPayload[]
  /** 会话的计费模型；为 null 表示宿主不估价（外部引擎自管计费、子线程面板）。 */
  billingModel: LooseOptional<{
    provider: ChatProviderId
    model: string
  }>
  pricingCatalog?: LooseOptional<ModelPricingCatalog>
}

interface RunUsageWindow {
  startedAt: Nullable<number>
  finishedAt: number
}

function isRuntimeTimestamp(value: LooseOptional<number>): value is number {
  return isFiniteNumber(value) && value >= 0
}

function maxTimestamp(values: ReadonlyArray<LooseOptional<number>>): Nullable<number> {
  const timestamps = values.filter(isRuntimeTimestamp)
  return isEmpty(timestamps) ? null : Math.max(...timestamps)
}

/**
 * 这次执行的用量时间窗：止于标记时刻（执行收尾），起于「执行开始 / 上一次执行收尾 / 触发它的
 * 用户消息」里最晚的那个。旧标记没有 `startedAt` 时，后两个下界保证前面几次执行的用量不会被
 * 算到这一次头上。
 */
function resolveRunUsageWindow(
  marker: ConversationMessageRunMarker,
  previousRunFinishedAt: Nullable<number>,
  turnInputAt: Nullable<number>
): RunUsageWindow {
  return {
    startedAt: maxTimestamp([marker.startedAt, previousRunFinishedAt, turnInputAt]),
    finishedAt: marker.timestamp,
  }
}

/** 宿主记在标记上的用量账；落盘恢复回来的形状不对时当没有，回落到从遥测推。 */
function readHostRunUsage(marker: ConversationMessageRunMarker): Nullable<ConversationRunUsage> {
  const usage = marker.usage
  return usage && isArray(usage.buckets) && isFiniteNumber(usage.unreportedSubAgentRuns)
    ? usage
    : null
}

function isTelemetryInWindow(
  entry: StreamUsageTelemetryPayload,
  window: RunUsageWindow
): boolean {
  if (!isRuntimeTimestamp(entry.timestamp)) return false
  if (isPresent(window.startedAt) && entry.timestamp < window.startedAt) return false

  return entry.timestamp <= window.finishedAt
}

/**
 * 标记上没有宿主记的用量账时，从会话遥测与这次执行的消息里推一份：主 Agent 每次模型调用的
 * `usage-telemetry` 按时间窗归属，子 Agent 的用量从这次执行的工具结果信封里收。
 */
function deriveRunUsage(
  runMessages: readonly ChatMessage[],
  usageTelemetry: readonly StreamUsageTelemetryPayload[],
  window: RunUsageWindow
): ConversationRunUsage {
  let usage = createConversationRunUsage()

  for (const entry of usageTelemetry) {
    if (isTelemetryInWindow(entry, window)) usage = addConversationRunUsageTelemetry(usage, entry)
  }

  return addConversationRunTranscriptSubAgentUsage(usage, runMessages)
}

/**
 * 每次执行（按运行标记切分）的约价，键是承载标记的助手消息 id。
 *
 * 一次执行的消息是上一条标记消息之后、到这条标记消息为止的全部消息；用量优先取标记上宿主记的
 * 用量账，没有时按 {@link deriveRunUsage} 推。主 Agent 用量未知（没回报、或主模型查不到价）的
 * 执行不进结果——宁可不显示金额，也不显示一个看似精确、实则只数了零头的数。
 */
export function buildRunCostEstimates(input: RunCostEstimatesInput): Map<string, RunCostEstimate> {
  const estimates = new Map<string, RunCostEstimate>()
  const billingModel = input.billingModel
  if (!billingModel || input.messageRunMarkerMap.size === 0) return estimates

  let runStartIndex = 0
  let previousRunFinishedAt: Nullable<number> = null
  let turnInputAt: Nullable<number> = null

  input.messages.forEach((message, index) => {
    if (isConversationTurnInputMessage(message)) turnInputAt = message.timestamp

    const marker = message.role === 'assistant' ? input.messageRunMarkerMap.get(message.id) : null
    if (!marker) return

    const window = resolveRunUsageWindow(marker, previousRunFinishedAt, turnInputAt)
    const usage =
      readHostRunUsage(marker) ??
      deriveRunUsage(input.messages.slice(runStartIndex, index + 1), input.usageTelemetry, window)
    const estimate = estimateRunCost({
      usage,
      provider: billingModel.provider,
      model: billingModel.model,
      pricingCatalog: input.pricingCatalog,
      expectedAgentCalls: marker.turnKind === 'totalTurns' ? marker.turnCount : null,
    })
    if (estimate) estimates.set(message.id, estimate)

    runStartIndex = index + 1
    previousRunFinishedAt = isRuntimeTimestamp(marker.timestamp)
      ? marker.timestamp
      : previousRunFinishedAt
  })

  return estimates
}

/**
 * 沿用上一份里数值相同的约价对象。会话每来一个 token 都会重算整张表；逐项换新对象会让每个带
 * 约价的气泡都跟着重画。
 */
export function reuseStableRunCostEstimates(
  previous: Nullable<ReadonlyMap<string, RunCostEstimate>>,
  next: Map<string, RunCostEstimate>
): Map<string, RunCostEstimate> {
  if (!previous) return next

  for (const [messageId, estimate] of next) {
    const previousEstimate = previous.get(messageId)
    if (previousEstimate && areRunCostEstimatesEqual(previousEstimate, estimate))
      next.set(messageId, previousEstimate)
  }

  return next
}
