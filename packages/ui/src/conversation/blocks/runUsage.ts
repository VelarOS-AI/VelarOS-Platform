import type {
  ConversationRunUsage,
  ConversationRunUsageBucket,
  ConversationRunUsageOrigin,
  ConversationRunUsagePricing,
  ConversationSubAgentRunUsage,
} from '../projection'

import type { ChatMessage, StreamUsageTelemetryPayload } from '#contracts'
import {
  isEmpty,
  isFiniteNumber,
  isNonBlankString,
  isPresent,
  isRecord,
  isString,
} from '#internal/runtime'

type ToolCallBlock = Extract<ChatMessage['blocks'][number], { type: 'tool-call' }>

/** 一次计入的用量样本（一轮主 Agent 调用，或一次子 Agent 运行的汇总）。 */
interface RunUsageSample {
  origin: ConversationRunUsageOrigin
  provider: Nullable<string>
  model: string
  pricing: ConversationRunUsagePricing
  inputTokens: number
  cacheReadInputTokens: number
  cacheWriteInputTokens: number
  outputTokens: number
  reasoningTokens: number
  reportedCostUsd: number
}

/** 从子 Agent 结果信封里读到的一次运行。 */
interface SubAgentResultEnvelope {
  threadId: string
  status: Nullable<string>
  provider: Nullable<string>
  model: string
  usage: Nullable<ConversationSubAgentRunUsage>
}

const SubAgentResultOpenMarker = '<subagent-result type="application/json">'
const SubAgentResultCloseMarker = '</subagent-result>'
/**
 * 信封里没带用量时仍算「跑过」的状态：后台派发刚起跑（`running`，结果要等 job 读回），或跑完 / 软收尾
 * 却没回报。失败与中断不算——被熔断、超上限拒绝的派发同样是这两种状态，从信封上分不出是否真的调过模型。
 */
const SubAgentRanStatuses: ReadonlySet<string> = new Set(['running', 'completed', 'wind_down'])
const SubAgentEnvelopesByBlock = new WeakMap<ToolCallBlock, readonly SubAgentResultEnvelope[]>()

function readTokenCount(value: unknown): Nullable<number> {
  return isFiniteNumber(value) && value >= 0 ? value : null
}

function sumPresent(...values: Array<Nullable<number>>): Nullable<number> {
  const present = values.filter(isPresent)
  return isEmpty(present) ? null : present.reduce((total, value) => total + value, 0)
}

function normalizeProvider(value: unknown): Nullable<string> {
  return isNonBlankString(value) ? value.trim() : null
}

function normalizeModel(value: unknown): string {
  return isNonBlankString(value) ? value.trim() : ''
}

export function createConversationRunUsage(): ConversationRunUsage {
  return { buckets: [], unreportedSubAgentRuns: 0 }
}

function isSameBucket(bucket: ConversationRunUsageBucket, sample: RunUsageSample): boolean {
  return (
    bucket.origin === sample.origin &&
    bucket.provider === sample.provider &&
    bucket.model === sample.model &&
    bucket.pricing === sample.pricing
  )
}

function addRunUsageSample(
  usage: ConversationRunUsage,
  sample: RunUsageSample
): ConversationRunUsage {
  const index = usage.buckets.findIndex((bucket) => isSameBucket(bucket, sample))
  const current = index >= 0 ? usage.buckets[index] : undefined
  const next: ConversationRunUsageBucket = {
    origin: sample.origin,
    provider: sample.provider,
    model: sample.model,
    pricing: sample.pricing,
    calls: (current?.calls ?? 0) + 1,
    inputTokens: (current?.inputTokens ?? 0) + sample.inputTokens,
    cacheReadInputTokens: (current?.cacheReadInputTokens ?? 0) + sample.cacheReadInputTokens,
    cacheWriteInputTokens: (current?.cacheWriteInputTokens ?? 0) + sample.cacheWriteInputTokens,
    outputTokens: (current?.outputTokens ?? 0) + sample.outputTokens,
    reasoningTokens: (current?.reasoningTokens ?? 0) + sample.reasoningTokens,
    reportedCostUsd: (current?.reportedCostUsd ?? 0) + sample.reportedCostUsd,
  }

  return {
    ...usage,
    buckets:
      index >= 0
        ? usage.buckets.map((bucket, bucketIndex) => (bucketIndex === index ? next : bucket))
        : [...usage.buckets, next],
  }
}

/**
 * 构造一次样本。`inputTokens` 缺席时按 `totalTokens - outputTokens` 反推；缓存份额超过总输入
 * （供应方口径不一）时以份额之和为准，保证计价时不会把输入扣成负数。一个 token 数都没有、
 * 也没有回报成本的样本返回 null——那次调用算没回报用量。
 */
function createRunUsageSample(input: {
  origin: ConversationRunUsageOrigin
  provider: unknown
  model: unknown
  inputTokens: unknown
  outputTokens: unknown
  totalTokens: unknown
  visibleOutputTokens?: unknown
  reasoningTokens: unknown
  cacheReadInputTokens: unknown
  cacheWriteInputTokens: unknown
  costUsd: unknown
}): Nullable<RunUsageSample> {
  const reasoningTokens = readTokenCount(input.reasoningTokens)
  const outputTokens =
    readTokenCount(input.outputTokens) ??
    sumPresent(readTokenCount(input.visibleOutputTokens), reasoningTokens)
  const totalTokens = readTokenCount(input.totalTokens)
  const reportedInputTokens =
    readTokenCount(input.inputTokens) ??
    (isPresent(totalTokens) ? Math.max(0, totalTokens - (outputTokens ?? 0)) : null)
  const cacheReadInputTokens = readTokenCount(input.cacheReadInputTokens) ?? 0
  const cacheWriteInputTokens = readTokenCount(input.cacheWriteInputTokens) ?? 0
  const costUsd = readTokenCount(input.costUsd)

  if (!isPresent(reportedInputTokens) && !isPresent(outputTokens) && !isPresent(costUsd))
    return null

  return {
    origin: input.origin,
    provider: normalizeProvider(input.provider),
    model: normalizeModel(input.model),
    pricing: isPresent(costUsd) ? 'reported' : 'catalog',
    inputTokens: Math.max(
      reportedInputTokens ?? 0,
      cacheReadInputTokens + cacheWriteInputTokens
    ),
    cacheReadInputTokens,
    cacheWriteInputTokens,
    outputTokens: outputTokens ?? 0,
    reasoningTokens: reasoningTokens ?? 0,
    reportedCostUsd: costUsd ?? 0,
  }
}

/**
 * 主 Agent 一次模型调用的 `usage-telemetry` 记进账。
 *
 * 输出按 `outputTokens`（含推理）计——推理 token 按输出价计费，只数可见输出会让推理模型的约价
 * 系统性偏低。没有任何 token 与成本回报的遥测原样返回：那一轮算没回报用量，约价据此标成下限。
 */
export function addConversationRunUsageTelemetry(
  usage: ConversationRunUsage,
  telemetry: StreamUsageTelemetryPayload
): ConversationRunUsage {
  const sample = createRunUsageSample({
    origin: 'agent',
    provider: telemetry.provider,
    model: telemetry.model,
    inputTokens: telemetry.inputTokens,
    outputTokens: telemetry.outputTokens,
    totalTokens: telemetry.totalTokens,
    visibleOutputTokens: telemetry.visibleOutputTokens,
    reasoningTokens: telemetry.reasoningTokens,
    cacheReadInputTokens: telemetry.cacheReadInputTokens ?? telemetry.cachedInputTokens,
    cacheWriteInputTokens: telemetry.cacheWriteInputTokens,
    costUsd: telemetry.costUsd,
  })

  return sample ? addRunUsageSample(usage, sample) : usage
}

/**
 * 子 Agent 一次运行的用量汇总记进账（派发结果信封或 worker 线程终态事件里的 `result.usage`）。
 * 没带用量的运行只记数，约价据此标成下限。
 */
export function addConversationRunSubAgentUsage(
  usage: ConversationRunUsage,
  run: {
    provider?: LooseOptional<string>
    model?: LooseOptional<string>
    usage?: LooseOptional<ConversationSubAgentRunUsage>
  }
): ConversationRunUsage {
  const reported = run.usage
  const sample = reported
    ? createRunUsageSample({
        origin: 'sub-agent',
        provider: run.provider,
        model: run.model,
        inputTokens: reported.inputTokens,
        outputTokens: reported.outputTokens,
        totalTokens: reported.totalTokens,
        reasoningTokens: reported.reasoningTokens,
        cacheReadInputTokens: reported.cacheReadInputTokens,
        cacheWriteInputTokens: reported.cacheWriteInputTokens,
        costUsd: reported.costUsd,
      })
    : null

  return sample
    ? addRunUsageSample(usage, sample)
    : { ...usage, unreportedSubAgentRuns: usage.unreportedSubAgentRuns + 1 }
}

function readSubAgentRunUsage(value: unknown): Nullable<ConversationSubAgentRunUsage> {
  if (!isRecord(value)) return null

  return {
    inputTokens: readTokenCount(value.inputTokens),
    outputTokens: readTokenCount(value.outputTokens),
    totalTokens: readTokenCount(value.totalTokens),
    cacheReadInputTokens: readTokenCount(value.cacheReadInputTokens),
    cacheWriteInputTokens: readTokenCount(value.cacheWriteInputTokens),
    reasoningTokens: readTokenCount(value.reasoningTokens),
    costUsd: readTokenCount(value.costUsd),
  }
}

function readSubAgentResultEnvelope(value: unknown): Nullable<SubAgentResultEnvelope> {
  if (!isRecord(value) || !isNonBlankString(value.thread_id)) return null

  const modelTrace = isRecord(value.model_trace) ? value.model_trace : {}

  return {
    threadId: value.thread_id.trim(),
    status: isString(value.status) ? value.status : null,
    provider: normalizeProvider(modelTrace.providerId),
    model: normalizeModel(modelTrace.model),
    usage: readSubAgentRunUsage(value.usage),
  }
}

/** 工具结果里的全部子 Agent 结果信封（派发结果、job 读回的后台结果）；损坏的信封跳过。 */
function parseSubAgentResultEnvelopes(text: string): SubAgentResultEnvelope[] {
  const envelopes: SubAgentResultEnvelope[] = []
  let cursor = 0

  while (cursor < text.length) {
    const open = text.indexOf(SubAgentResultOpenMarker, cursor)
    if (open < 0) break

    const bodyStart = open + SubAgentResultOpenMarker.length
    const close = text.indexOf(SubAgentResultCloseMarker, bodyStart)
    if (close < 0) break

    cursor = close + SubAgentResultCloseMarker.length
    const body = text.slice(bodyStart, close).trim()
    if (!body) continue

    try {
      const envelope = readSubAgentResultEnvelope(JSON.parse(body))
      if (envelope) envelopes.push(envelope)
    } catch {
      // arch-guard:silent-catch-ok 被截断或损坏的历史信封不是故障；这次运行按没回报用量处理。
    }
  }

  return envelopes
}

function readToolCallSubAgentEnvelopes(block: ToolCallBlock): readonly SubAgentResultEnvelope[] {
  const cached = SubAgentEnvelopesByBlock.get(block)
  if (cached) return cached

  const envelopes =
    isString(block.result) && block.result.includes(SubAgentResultOpenMarker)
      ? parseSubAgentResultEnvelopes(block.result)
      : []
  SubAgentEnvelopesByBlock.set(block, envelopes)
  return envelopes
}

function readSubAgentUsageSignature(usage: ConversationSubAgentRunUsage): string {
  return [
    usage.inputTokens,
    usage.outputTokens,
    usage.totalTokens,
    usage.cacheReadInputTokens,
    usage.cacheWriteInputTokens,
    usage.costUsd,
  ].join('|')
}

/**
 * 从一次执行的消息里收子 Agent 的用量，记进账。
 *
 * 子 Agent 每轮的 `usage-telemetry` 不上浮到父会话（worker 总线静默），它的用量只在结果信封里：
 * 同步派发的工具结果直接带着；后台派发先回一个 `running` 信封，终态结果要等 `job:wait` /
 * `job:read_output` 读回。按线程 id 汇总：同一次运行被读到两遍（派发结果 + job 读回）用量相同，
 * 按用量签名去重；同一线程续跑的另一次激活用量不同，各记一次。线程只见过 `running` 信封、
 * 终态没被读回时记成「没回报用量」。
 */
export function addConversationRunTranscriptSubAgentUsage(
  usage: ConversationRunUsage,
  messages: readonly ChatMessage[]
): ConversationRunUsage {
  const threads = new Map<
    string,
    { ran: boolean; runs: Map<string, SubAgentResultEnvelope> }
  >()

  for (const message of messages) {
    if (message.role !== 'assistant') continue

    for (const block of message.blocks) {
      if (block.type !== 'tool-call') continue

      for (const envelope of readToolCallSubAgentEnvelopes(block)) {
        const thread = threads.get(envelope.threadId) ?? { ran: false, runs: new Map() }
        if (envelope.status && SubAgentRanStatuses.has(envelope.status)) thread.ran = true
        if (envelope.usage) {
          const signature = readSubAgentUsageSignature(envelope.usage)
          if (!thread.runs.has(signature)) thread.runs.set(signature, envelope)
        }
        threads.set(envelope.threadId, thread)
      }
    }
  }

  let next = usage
  for (const thread of threads.values()) {
    if (thread.runs.size === 0) {
      if (thread.ran) next = addConversationRunSubAgentUsage(next, {})
      continue
    }

    for (const envelope of thread.runs.values()) {
      next = addConversationRunSubAgentUsage(next, {
        provider: envelope.provider,
        model: envelope.model,
        usage: envelope.usage,
      })
    }
  }

  return next
}
