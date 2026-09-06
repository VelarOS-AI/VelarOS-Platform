import type { ConversationTurnContextView } from '../projection'

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

function buildPricingIndex(catalog: ModelPricingCatalog): ReadonlyMap<string, ModelTokenPrice> {
  const index = new Map<string, ModelTokenPrice>()
  for (const entry of catalog.entries) {
    const price = {
      inputUsdPerMillion: entry.inputUsdPerMillion,
      outputUsdPerMillion: entry.outputUsdPerMillion,
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
    const outputTokens = usage.visibleOutputTokens ?? usage.outputTokens ?? 0

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

    addCostEstimate(estimate, calculateTokenCost(price, usage.inputTokens ?? 0, outputTokens))
    estimate.usageSource = usage.source
    estimate.confidence = usage.confidence
  }

  return estimate.turnCount > 0 || estimate.hasUnpricedUsage ? estimate : null
}

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
