import type { ConversationRunUsage, ConversationTurnContextView } from '../projection'

import { formatExactNumber } from './numberFormat'

import type {
  AppLocale,
  ChatContextUsageAccountingConfidence,
  ChatContextUsageAccountingSource,
  ChatMessage,
  ChatProviderId,
  ModelPricingCatalog,
  StreamUsageTelemetryPayload,
} from '#contracts'
import { estimateContextUsage } from '#internal/contextUsage'
import { isBlank, isEmpty, isFiniteNumber, isPresent } from '#internal/runtime'

interface ModelTokenPrice {
  inputUsdPerMillion: number
  outputUsdPerMillion: number
  /** 价格目录没给缓存价时为 null：缓存 token 按输入价计。 */
  cacheReadUsdPerMillion: Nullable<number>
  cacheWriteUsdPerMillion: Nullable<number>
}

/** 一批调用的 token：`inputTokens` 为全部输入（含缓存读 / 写），`outputTokens` 为全部输出（含推理）。 */
interface UsageTokenCounts {
  inputTokens: number
  cacheReadInputTokens: number
  cacheWriteInputTokens: number
  outputTokens: number
}

interface UsageTokenCost {
  usd: number
  /** 有缓存 token 却没有对应缓存价，这部分按输入价计了。 */
  cachedInputPricedAtInputRate: boolean
}

export interface ResolvedCostModel {
  provider: ChatProviderId
  model: string
}

export interface MessageCostEstimate {
  usd: number
  inputTokens: number
  outputTokens: number
}

export interface SessionCostEstimate extends MessageCostEstimate {
  turnCount: number
  isRuntimeBacked: boolean
  usageSource: ChatContextUsageAccountingSource
  confidence: ChatContextUsageAccountingConfidence
  hasUnpricedUsage: boolean
}

/**
 * `complete`：执行里的调用都回报了用量、也都有价；`partial`：有调用没回报用量（轮次比用量记录多、
 * 子 Agent 结果没带用量）或模型查不到价格，真实成本高于 `usd`。
 */
export type RunCostCoverage = 'complete' | 'partial'

/** 一次执行（主 Agent 全部模型调用 + 子 Agent 运行）的约价；token 字段均为全部调用之和。 */
export interface RunCostEstimate extends MessageCostEstimate {
  cacheReadInputTokens: number
  cacheWriteInputTokens: number
  /** 输出里的推理 token（已含在 `outputTokens` 里，按输出价计）。 */
  reasoningTokens: number
  /** 计入的主 Agent 模型调用数。 */
  agentCalls: number
  /** 计入的子 Agent 运行数。 */
  subAgentRuns: number
  coverage: RunCostCoverage
  /** 缓存 token 因价格目录缺缓存价而按输入价计了：这部分偏高，是上界。 */
  cachedInputPricedAtInputRate: boolean
}

const ProviderModelPricePrefixes: Partial<Record<ChatProviderId, string>> = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  deepseek: 'deepseek',
  xai: 'x-ai',
  qwen: 'qwen',
  moonshot: 'moonshotai',
  zhipu: 'z-ai',
  mistral: 'mistralai',
  minimax: 'minimax',
}

const PricingIndexCache = new WeakMap<ModelPricingCatalog, ReadonlyMap<string, ModelTokenPrice>>()

function normalizeModelId(model: string): string {
  return model.trim().toLowerCase().replace(/^~/u, '')
}

function stripGatewayModelPrefixes(model: string): string {
  return model
    .replace(/^(?:us|eu|apac|global)\./u, '')
    .replace(/^(?:anthropic|openai|deepseek|google|vertex|bedrock)\./u, '')
}

function getAnthropicClaudeAliases(model: string): string[] {
  const aliases = new Set<string>()
  const [, tail = model] = model.includes('/') ? model.split(/\/(.+)/u) : ['', model]
  const normalizedTail = stripGatewayModelPrefixes(tail)
  let canonicalTail = normalizedTail
  for (const family of ['claude-sonnet', 'claude-opus', 'claude-haiku']) {
    const prefix = `${family}-`
    if (!normalizedTail.startsWith(prefix)) continue
    let majorEnd = prefix.length
    while (/\d/u.test(normalizedTail[majorEnd] ?? '')) majorEnd += 1
    if (majorEnd === prefix.length || normalizedTail[majorEnd] !== '-') break
    let minorEnd = majorEnd + 1
    while (/\d/u.test(normalizedTail[minorEnd] ?? '')) minorEnd += 1
    const major = normalizedTail.slice(prefix.length, majorEnd)
    const minor = normalizedTail.slice(majorEnd + 1, minorEnd)
    if (minor) {
      const suffix = normalizedTail.slice(minorEnd)
      canonicalTail = `${family}-${major}.${minor}${suffix}`
    }
    break
  }

  if (canonicalTail !== normalizedTail) {
    aliases.add(canonicalTail)
    aliases.add(`anthropic/${canonicalTail}`)
  }

  return [...aliases]
}

function getModelLookupCandidates(provider: ChatProviderId, model: string): string[] {
  const normalizedModel = normalizeModelId(model)
  if (!normalizedModel) return []

  const candidates = new Set([normalizedModel])
  getAnthropicClaudeAliases(normalizedModel).forEach((candidate) => candidates.add(candidate))
  const lastSlashIndex = normalizedModel.lastIndexOf('/')
  const pricePrefix = ProviderModelPricePrefixes[provider]

  if (pricePrefix && lastSlashIndex < 0) {
    candidates.add(`${pricePrefix}/${normalizedModel}`)
  }

  if (lastSlashIndex >= 0 && lastSlashIndex < normalizedModel.length - 1) {
    const modelTail = normalizedModel.slice(lastSlashIndex + 1)
    candidates.add(modelTail)
    getAnthropicClaudeAliases(modelTail).forEach((candidate) => candidates.add(candidate))
  }

  return [...candidates]
}

function readOptionalPrice(value: LooseOptional<number>): Nullable<number> {
  return isFiniteNumber(value) && value >= 0 ? value : null
}

function buildPricingIndex(catalog: ModelPricingCatalog): ReadonlyMap<string, ModelTokenPrice> {
  const index = new Map<string, ModelTokenPrice>()
  for (const entry of catalog.entries) {
    const price: ModelTokenPrice = {
      inputUsdPerMillion: entry.inputUsdPerMillion,
      outputUsdPerMillion: entry.outputUsdPerMillion,
      cacheReadUsdPerMillion: readOptionalPrice(entry.cacheReadUsdPerMillion),
      cacheWriteUsdPerMillion: readOptionalPrice(entry.cacheWriteUsdPerMillion),
    }
    const provider = normalizeModelId(entry.provider)
    const identifiers = [entry.model, ...entry.aliases]
    for (const identifier of identifiers) {
      const normalized = normalizeModelId(identifier)
      if (!normalized) continue
      index.set(normalized, price)
      if (provider && !normalized.includes('/')) index.set(`${provider}/${normalized}`, price)
    }
  }
  return index
}

function resolveModelPrice(
  catalog: LooseOptional<ModelPricingCatalog>,
  provider: ChatProviderId,
  model: string
): Nullable<ModelTokenPrice> {
  if (!catalog) return null
  let index = PricingIndexCache.get(catalog)
  if (!index) {
    index = buildPricingIndex(catalog)
    PricingIndexCache.set(catalog, index)
  }

  for (const candidate of getModelLookupCandidates(provider, model)) {
    const price = index.get(candidate)
    if (price) return price
  }

  return null
}

function calculateTokenCost(
  price: ModelTokenPrice,
  inputTokens: number,
  outputTokens: number
): MessageCostEstimate {
  return {
    usd:
      (inputTokens / 1_000_000) * price.inputUsdPerMillion +
      (outputTokens / 1_000_000) * price.outputUsdPerMillion,
    inputTokens,
    outputTokens,
  }
}

/**
 * 按 token 类别计价：缓存读 / 写从总输入里扣出来按各自单价算，其余输入按输入价，输出（含推理）
 * 按输出价。目录没给缓存价时缓存 token 按输入价计——宁可偏高也不把不知道的折扣当成已知，并如实
 * 标出这一点。
 */
function priceUsageTokens(price: ModelTokenPrice, tokens: UsageTokenCounts): UsageTokenCost {
  const cacheReadTokens = Math.max(0, tokens.cacheReadInputTokens)
  const cacheWriteTokens = Math.max(0, tokens.cacheWriteInputTokens)
  const inputTokens = Math.max(tokens.inputTokens, cacheReadTokens + cacheWriteTokens)
  const uncachedInputTokens = inputTokens - cacheReadTokens - cacheWriteTokens
  const cacheReadRate = price.cacheReadUsdPerMillion ?? price.inputUsdPerMillion
  const cacheWriteRate = price.cacheWriteUsdPerMillion ?? price.inputUsdPerMillion

  return {
    usd:
      (uncachedInputTokens * price.inputUsdPerMillion +
        cacheReadTokens * cacheReadRate +
        cacheWriteTokens * cacheWriteRate +
        Math.max(0, tokens.outputTokens) * price.outputUsdPerMillion) /
      1_000_000,
    cachedInputPricedAtInputRate:
      (cacheReadTokens > 0 && !isPresent(price.cacheReadUsdPerMillion)) ||
      (cacheWriteTokens > 0 && !isPresent(price.cacheWriteUsdPerMillion)),
  }
}

/** 遥测里的全部输出 token：`outputTokens` 已含推理；缺席时用可见输出 + 推理拼回来。 */
function readTelemetryOutputTokens(usage: StreamUsageTelemetryPayload): number {
  if (isFiniteNumber(usage.outputTokens)) return Math.max(0, usage.outputTokens)

  const visibleOutputTokens = isFiniteNumber(usage.visibleOutputTokens)
    ? Math.max(0, usage.visibleOutputTokens)
    : 0
  const reasoningTokens = isFiniteNumber(usage.reasoningTokens)
    ? Math.max(0, usage.reasoningTokens)
    : 0
  return visibleOutputTokens + reasoningTokens
}

function estimateTextTokens(model: string, role: 'user' | 'assistant', text: string): number {
  if (isBlank(text.trim())) return 0

  return estimateContextUsage(model, '', [{ role, content: text }]).estimatedTokens
}

function extractChatMessageText(message: ChatMessage): string {
  const textBlocks: string[] = []

  for (const block of message.blocks) {
    if (block.type !== 'text') continue

    const text = block.text.trimEnd()
    if (isBlank(text)) continue

    textBlocks.push(text)
  }

  return textBlocks.join('\n\n').trim()
}

function createEmptySessionCostEstimate(isRuntimeBacked: boolean): SessionCostEstimate {
  return {
    usd: 0,
    inputTokens: 0,
    outputTokens: 0,
    turnCount: 0,
    isRuntimeBacked,
    usageSource: isRuntimeBacked ? 'provider' : 'local-estimate',
    confidence: isRuntimeBacked ? 'high' : 'low',
    hasUnpricedUsage: false,
  }
}

function addCostEstimate(accumulator: SessionCostEstimate, estimate: MessageCostEstimate): void {
  accumulator.usd += estimate.usd
  accumulator.inputTokens += estimate.inputTokens
  accumulator.outputTokens += estimate.outputTokens
  accumulator.turnCount += 1
}

export function resolveLatestRuntimeCostModel(input: {
  provider: ChatProviderId
  model: string
  turnContexts: ConversationTurnContextView[]
}): Nullable<ResolvedCostModel> {
  let latest: Nullable<ResolvedCostModel & { timestamp: number; turn: number }> = null

  for (const context of input.turnContexts) {
    const runtimeModel = context.roleRuntimeModel
    const provider = runtimeModel?.provider ?? input.provider
    const model = (runtimeModel?.model ?? input.model).trim()
    if (!model) continue
    if (
      latest &&
      (context.turn < latest.turn ||
        (context.turn === latest.turn && context.timestamp <= latest.timestamp))
    )
      continue

    latest = {
      provider,
      model,
      timestamp: context.timestamp,
      turn: context.turn,
    }
  }

  return latest ? { provider: latest.provider, model: latest.model } : null
}

function estimateVisibleSessionCost(input: {
  provider: ChatProviderId
  model: string
  messages: ChatMessage[]
  pricingCatalog?: LooseOptional<ModelPricingCatalog>
}): Nullable<SessionCostEstimate> {
  const model = input.model.trim()
  const price = resolveModelPrice(input.pricingCatalog, input.provider, model)

  if (!price) return null

  const estimate = createEmptySessionCostEstimate(false)
  let latestQuestion = ''

  for (const message of input.messages) {
    const text = extractChatMessageText(message)

    if (message.role === 'user') {
      latestQuestion = text
      continue
    }

    if (message.role !== 'assistant' || isBlank(text)) continue

    const inputTokens = estimateTextTokens(model, 'user', latestQuestion)
    const outputTokens = estimateTextTokens(model, 'assistant', text)
    addCostEstimate(estimate, calculateTokenCost(price, inputTokens, outputTokens))
  }

  return estimate.turnCount > 0 ? estimate : null
}

function estimateRuntimeTelemetryCost(input: {
  provider: ChatProviderId
  model: string
  pricingCatalog?: LooseOptional<ModelPricingCatalog>
  usageTelemetry: StreamUsageTelemetryPayload[]
  turnContexts?: LooseOptional<ConversationTurnContextView[]>
}): Nullable<SessionCostEstimate> {
  if (isEmpty(input.usageTelemetry)) return null

  const runtimeCostModel =
    input.turnContexts && !isEmpty(input.turnContexts)
      ? resolveLatestRuntimeCostModel({
          provider: input.provider,
          model: input.model,
          turnContexts: input.turnContexts,
        })
      : null
  const estimate = createEmptySessionCostEstimate(true)

  for (const usage of input.usageTelemetry) {
    // 推理 token 按输出价计费：计价与展示都用含推理的全部输出，不能只数可见输出。
    const outputTokens = readTelemetryOutputTokens(usage)

    if (isFiniteNumber(usage.costUsd)) {
      addCostEstimate(estimate, {
        usd: Math.max(0, usage.costUsd),
        inputTokens: usage.inputTokens ?? 0,
        outputTokens,
      })
      estimate.usageSource = usage.source
      estimate.confidence = usage.confidence
      continue
    }

    const provider = usage.provider ?? runtimeCostModel?.provider ?? input.provider
    const model = (usage.model || runtimeCostModel?.model || input.model).trim()
    const price = resolveModelPrice(input.pricingCatalog, provider, model)
    if (!isPresent(usage.inputTokens) && !isPresent(usage.outputTokens)) continue
    if (!price) {
      estimate.hasUnpricedUsage = true
      continue
    }

    const inputTokens = usage.inputTokens ?? 0
    addCostEstimate(estimate, {
      usd: priceUsageTokens(price, {
        inputTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens ?? usage.cachedInputTokens ?? 0,
        cacheWriteInputTokens: usage.cacheWriteInputTokens ?? 0,
        outputTokens,
      }).usd,
      inputTokens,
      outputTokens,
    })
    estimate.usageSource = usage.source
    estimate.confidence = usage.confidence
  }

  return estimate.turnCount > 0 || estimate.hasUnpricedUsage ? estimate : null
}

/**
 * 一次执行的约价：按执行用量账逐桶计价。
 *
 * 网关回报了成本的桶直接用回报值；其余桶按「桶里的服务商 / 模型」查价格目录，桶里缺的回落到
 * `provider` / `model`（会话的计费模型——子 Agent 默认沿用主模型）。主 Agent 没有任何计得了价的
 * 调用（没回报用量，或主模型查不到价格）时返回 null：约价未知，调用方不应显示金额——只剩子 Agent
 * 那一点零头的金额会被读成整轮成本。`expectedAgentCalls`（执行标记的总轮数）多于记到的主 Agent
 * 调用数时标成 `partial`。
 */
export function estimateRunCost(input: {
  usage: ConversationRunUsage
  provider: ChatProviderId
  model: string
  pricingCatalog?: LooseOptional<ModelPricingCatalog>
  expectedAgentCalls?: LooseOptional<number>
}): Nullable<RunCostEstimate> {
  const estimate: RunCostEstimate = {
    usd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    reasoningTokens: 0,
    agentCalls: 0,
    subAgentRuns: 0,
    coverage: input.usage.unreportedSubAgentRuns > 0 ? 'partial' : 'complete',
    cachedInputPricedAtInputRate: false,
  }
  let pricedAgentCalls = 0

  for (const bucket of input.usage.buckets) {
    estimate.inputTokens += bucket.inputTokens
    estimate.outputTokens += bucket.outputTokens
    estimate.cacheReadInputTokens += bucket.cacheReadInputTokens
    estimate.cacheWriteInputTokens += bucket.cacheWriteInputTokens
    estimate.reasoningTokens += bucket.reasoningTokens
    if (bucket.origin === 'agent') estimate.agentCalls += bucket.calls
    else estimate.subAgentRuns += bucket.calls

    if (bucket.pricing === 'reported') {
      estimate.usd += Math.max(0, bucket.reportedCostUsd)
      if (bucket.origin === 'agent') pricedAgentCalls += bucket.calls
      continue
    }

    const price = resolveModelPrice(
      input.pricingCatalog,
      bucket.provider ?? input.provider,
      bucket.model || input.model
    )
    if (!price) {
      estimate.coverage = 'partial'
      continue
    }

    const cost = priceUsageTokens(price, bucket)
    estimate.usd += cost.usd
    estimate.cachedInputPricedAtInputRate ||= cost.cachedInputPricedAtInputRate
    if (bucket.origin === 'agent') pricedAgentCalls += bucket.calls
  }

  if (pricedAgentCalls === 0) return null
  if (isFiniteNumber(input.expectedAgentCalls) && input.expectedAgentCalls > estimate.agentCalls)
    estimate.coverage = 'partial'

  return estimate
}

/** 约价逐字段相等：会话每来一个 token 都会重算，数值没变就沿用旧对象，气泡不跟着重画。 */
export function areRunCostEstimatesEqual(
  prev: LooseOptional<RunCostEstimate>,
  next: LooseOptional<RunCostEstimate>
): boolean {
  if (prev === next) return true
  if (!prev || !next) return false

  return (
    prev.usd === next.usd &&
    prev.inputTokens === next.inputTokens &&
    prev.outputTokens === next.outputTokens &&
    prev.cacheReadInputTokens === next.cacheReadInputTokens &&
    prev.cacheWriteInputTokens === next.cacheWriteInputTokens &&
    prev.reasoningTokens === next.reasoningTokens &&
    prev.agentCalls === next.agentCalls &&
    prev.subAgentRuns === next.subAgentRuns &&
    prev.coverage === next.coverage &&
    prev.cachedInputPricedAtInputRate === next.cachedInputPricedAtInputRate
  )
}

/**
 * 只按可见问答文字估的价：不含每轮重发的上下文、工具参数与结果、推理 token、中间轮次和子 Agent，
 * 对 Agent 执行会低估几个数量级。
 *
 * @deprecated 回答末尾的约价改由执行用量账计价（`estimateRunCost`）；这里只为已发布宿主保留。
 */
export function estimateMessageCost(input: {
  provider: ChatProviderId
  model: string
  pricingCatalog?: LooseOptional<ModelPricingCatalog>
  question: string
  answer: string
}): Nullable<MessageCostEstimate> {
  const answer = input.answer.trim()
  if (isBlank(answer)) return null

  const model = input.model.trim()
  const price = resolveModelPrice(input.pricingCatalog, input.provider, model)
  if (!price) return null

  const inputTokens = estimateTextTokens(model, 'user', input.question)
  const outputTokens = estimateTextTokens(model, 'assistant', answer)
  return calculateTokenCost(price, inputTokens, outputTokens)
}

/** @deprecated 同 {@link estimateMessageCost}：只按可见问答文字估，回答末尾的约价已改用 `estimateRunCost`。 */
export function estimateAssistantMessageCost(input: {
  provider: ChatProviderId
  model: string
  pricingCatalog?: LooseOptional<ModelPricingCatalog>
  question: string
  answer: string
  turnContexts?: ConversationTurnContextView[]
}): Nullable<MessageCostEstimate> {
  const answer = input.answer.trim()
  if (isBlank(answer)) return null

  const runtimeCostModel =
    input.turnContexts && !isEmpty(input.turnContexts)
      ? resolveLatestRuntimeCostModel({
          provider: input.provider,
          model: input.model,
          turnContexts: input.turnContexts,
        })
      : null

  return estimateMessageCost({
    ...input,
    provider: runtimeCostModel?.provider ?? input.provider,
    model: runtimeCostModel?.model ?? input.model,
  })
}

export function estimateSessionCost(input: {
  provider: ChatProviderId
  model: string
  messages: ChatMessage[]
  pricingCatalog?: LooseOptional<ModelPricingCatalog>
  turnContexts?: ConversationTurnContextView[]
  usageTelemetry?: StreamUsageTelemetryPayload[]
}): Nullable<SessionCostEstimate> {
  const runtimeEstimate = estimateRuntimeTelemetryCost({
    provider: input.provider,
    model: input.model,
    pricingCatalog: input.pricingCatalog,
    turnContexts: input.turnContexts,
    usageTelemetry: input.usageTelemetry ?? [],
  })
  if (runtimeEstimate) return runtimeEstimate

  const runtimeCostModel =
    input.turnContexts && !isEmpty(input.turnContexts)
      ? resolveLatestRuntimeCostModel({
          provider: input.provider,
          model: input.model,
          turnContexts: input.turnContexts,
        })
      : null

  return estimateVisibleSessionCost({
    ...input,
    provider: runtimeCostModel?.provider ?? input.provider,
    model: runtimeCostModel?.model ?? input.model,
  })
}

export function formatMessageCostEstimate(_locale: AppLocale, usd: number): string {
  const amount = Math.max(0, usd)

  if (amount <= 0) return '$0'
  if (amount < 0.0001) return '<$0.0001'
  if (amount < 0.01) return `$${amount.toFixed(4).replace(/0+$/u, '').replace(/\.$/u, '')}`
  if (amount < 1) return `$${amount.toFixed(3).replace(/0+$/u, '').replace(/\.$/u, '')}`
  return `$${amount.toFixed(2)}`
}

/** 回答末尾的金额：约价只是下限（`partial`）时加「≥」，不把少算的数当成整轮成本。 */
export function formatRunCostEstimateLabel(locale: AppLocale, estimate: RunCostEstimate): string {
  const amount = formatMessageCostEstimate(locale, estimate.usd)
  return estimate.coverage === 'partial' ? `≥${amount}` : amount
}

/** 金额悬停说明：这次执行计入了什么、各类 token 多少、哪些地方偏高或偏低。 */
export function describeRunCostEstimate(locale: AppLocale, estimate: RunCostEstimate): string {
  const count = (value: number): string => formatExactNumber(locale, value)
  const calls = [`${count(estimate.agentCalls)} model calls`]
  if (estimate.subAgentRuns > 0) calls.push(`${count(estimate.subAgentRuns)} sub-agent runs`)

  const input =
    estimate.cacheReadInputTokens > 0
      ? `${count(estimate.inputTokens)} input tokens (${count(estimate.cacheReadInputTokens)} cached)`
      : `${count(estimate.inputTokens)} input tokens`
  const output =
    estimate.reasoningTokens > 0
      ? `${count(estimate.outputTokens)} output tokens (${count(estimate.reasoningTokens)} reasoning)`
      : `${count(estimate.outputTokens)} output tokens`
  const lines = [calls.join(' · '), `${input} · ${output}`]

  if (estimate.cachedInputPricedAtInputRate)
    lines.push('Cached input priced at the full input rate: the price list has no cache price.')
  if (estimate.coverage === 'partial')
    lines.push('Lower bound: some calls reported no usage or have no known price.')

  return lines.join('\n')
}
