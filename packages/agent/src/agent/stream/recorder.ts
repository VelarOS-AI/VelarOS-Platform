import type { TextStreamPart, ToolSet } from 'ai'

import { isArray, isEmpty, isFiniteNumber, isObject,isPlainObject, isPresent, isString, toNullable } from '@velaros-ai/core'

import type {
  StreamDiagnostics,
  StreamDiagnosticsSummary,
  StreamFinishReasonDiagnostic,
  StreamRawChunkDiagnostic,
} from './types'

const ProviderCacheWriteInputTokenPaths = [
  ['providerMetadata', 'anthropic', 'cacheCreationInputTokens'],
  ['providerMetadata', 'vertex', 'cacheCreationInputTokens'],
  ['providerMetadata', 'bedrock', 'usage', 'cacheWriteInputTokens'],
  ['providerMetadata', 'venice', 'usage', 'cacheCreationInputTokens'],
] as const

function readProviderCacheWriteInputTokens(part: unknown): Nullable<number> {
  for (const path of ProviderCacheWriteInputTokenPaths) {
    const value = readNestedNumber(part, path)
    if (isPresent(value)) return value
  }
  return null
}

function readNestedNumber(value: unknown, path: readonly string[]): Nullable<number> {
  let current = value
  for (const key of path) {
    if (!current || !isObject(current)) return null
    current = (current as Record<string, unknown>)[key]
  }
  return isFiniteNumber(current) ? current : null
}

const MaxRawDiagnosticSamples = 8
const SilentProviderFinishReasons = new Set(['stop', 'tool_calls'])
const AbnormalProviderFinishReasonMessages: Record<string, string> = {
  length: 'Provider response may be truncated because the model hit the max output token limit.',
  content_filter: 'Provider response may be blocked or truncated by content filtering.',
  repetition_truncation: 'Provider response may be truncated because the model repetition guard stopped generation.',
}
const ProviderFinishReasonAliases: Record<string, string> = {
  max_completion_tokens: 'length',
  max_output_tokens: 'length',
  max_tokens: 'length',
  token_limit: 'length',
}
// 不在 Silent/Abnormal 两表内的未知 finish 原因不再静默丢弃(曾致截断事故完全无痕、事后不可诊断)。
const UnknownProviderFinishReasonMessage =
  'Provider reported an unrecognized finish reason; the response may have ended abnormally.'

type StreamActivityDiagnostics = Pick<
  StreamDiagnostics,
  | 'totalChunks'
  | 'partTypes'
  | 'textDeltaChars'
  | 'reasoningDeltaChars'
  | 'rawVisibleChars'
  | 'rawReasoningChars'
  | 'toolCallCount'
>

type StreamFinishDiagnostics = Pick<StreamDiagnostics, 'finishReasons' | 'rawFinishReasons'>

type StreamUsageDiagnostics = Pick<
  StreamDiagnostics,
  | 'inputTokens'
  | 'outputTokens'
  | 'visibleOutputTokens'
  | 'totalTokens'
  | 'reasoningTokens'
  | 'cachedInputTokens'
  | 'cacheReadInputTokens'
  | 'cacheWriteInputTokens'
  | 'costUsd'
>

class StreamDiagnosticRecorder {
  public createStreamDiagnostics(): StreamDiagnostics {
    return {
      ...this.createStreamActivityDiagnostics(),
      ...this.createStreamFinishDiagnostics(),
      ...this.createStreamUsageDiagnostics(),
      rawSamples: [],
    }
  }

  private createStreamActivityDiagnostics(): StreamActivityDiagnostics {
    return {
      totalChunks: 0,
      partTypes: {},
      textDeltaChars: 0,
      reasoningDeltaChars: 0,
      rawVisibleChars: 0,
      rawReasoningChars: 0,
      toolCallCount: 0,
    }
  }

  private createStreamFinishDiagnostics(): StreamFinishDiagnostics {
    return {
      finishReasons: [],
      rawFinishReasons: [],
    }
  }

  private createStreamUsageDiagnostics(): StreamUsageDiagnostics {
    return {
      inputTokens: null,
      outputTokens: null,
      visibleOutputTokens: null,
      totalTokens: null,
      reasoningTokens: null,
      cachedInputTokens: null,
      cacheReadInputTokens: null,
      cacheWriteInputTokens: null,
      costUsd: null,
    }
  }

  public recordStreamPartDiagnostics(diagnostics: StreamDiagnostics, part: TextStreamPart<ToolSet>): void {
    diagnostics.totalChunks += 1
    diagnostics.partTypes[part.type] = (diagnostics.partTypes[part.type] ?? 0) + 1

    if (part.type === 'text-delta') {
      diagnostics.textDeltaChars += part.text.length
      return
    }

    if (part.type === 'reasoning-delta') {
      diagnostics.reasoningDeltaChars += part.text.length
      return
    }

    if (part.type === 'finish') {
      this.recordFinishDiagnostics(diagnostics, part)
      return
    }

    if (part.type === 'finish-step') {
      this.recordFinishDiagnostics(diagnostics, part)
      return
    }

    if (part.type === 'raw') {
      this.recordRawChunkDiagnostic(diagnostics, part.rawValue)
    }
  }

  public buildNonDisplayableResponseMessage(
    diagnostics: StreamDiagnostics,
    locale: 'zh-CN' | 'en-US' = 'zh-CN'
  ): string {
    const finishReason = toNullable(diagnostics.finishReasons[0] ?? diagnostics.rawFinishReasons[0])
    const zhRetryHint =
      finishReason === 'length'
        ? '模型服务返回了空内容响应，并报告输出到达长度限制。请稍后重试，或适当提高输出 token 上限。'
        : '模型服务返回了成功结束的空内容响应。可能是上游 provider / 网关返回了空 completion，或内容过滤没有透出错误。请稍后重试，或切换模型。'

    if (locale === 'en-US') return finishReason === 'length'
        ? 'The model service returned an empty response and reported a length limit. Try again shortly or raise the output token limit.'
        : 'The model service returned a successful but empty response. This may be an upstream provider or gateway empty-completion issue, or content filtering that did not surface an error. Try again shortly or switch models.'

    return zhRetryHint
  }

  public summarizeStreamDiagnostics(diagnostics: StreamDiagnostics): StreamDiagnosticsSummary {
    const rawSamples = diagnostics.rawSamples.map((sample) => ({
      ...sample,
      keys: sample.keys.slice(0, 12),
      deltaKeys: sample.deltaKeys.slice(0, 12),
      contentBlockKeys: sample.contentBlockKeys.slice(0, 12),
      messageKeys: sample.messageKeys.slice(0, 12),
      messageContentTypes: sample.messageContentTypes.slice(0, 12),
      itemKeys: sample.itemKeys.slice(0, 12),
    }))

    return {
      ...diagnostics,
      rawSamples,
      rawSampleSummaries: rawSamples.map((sample) => this.formatRawDiagnosticSample(sample)),
    }
  }

  public buildAbnormalFinishReasonDiagnostic(
    diagnostics: StreamDiagnostics
  ): Nullable<StreamFinishReasonDiagnostic> {
    const finishReason = this.findAbnormalFinishReason(diagnostics)
    if (!finishReason) return null

    const normalizedFinishReason = normalizeFinishReason(finishReason)
    return {
      code: 'provider-finish-reason',
      message:
        AbnormalProviderFinishReasonMessages[normalizedFinishReason] ??
        UnknownProviderFinishReasonMessage,
      details: {
        finishReason,
        normalizedFinishReason,
        finishReasons: [...diagnostics.finishReasons],
        rawFinishReasons: [...diagnostics.rawFinishReasons],
      },
    }
  }

  private recordFinishDiagnostics(
    diagnostics: StreamDiagnostics,
    part: Extract<TextStreamPart<ToolSet>, { type: 'finish' | 'finish-step' }>
  ): void {
    if (isString(part.finishReason) &&
      !diagnostics.finishReasons.includes(part.finishReason)
    ) {
      diagnostics.finishReasons.push(part.finishReason)
    }

    if (isString(part.rawFinishReason) &&
      !diagnostics.rawFinishReasons.includes(part.rawFinishReason)
    ) {
      diagnostics.rawFinishReasons.push(part.rawFinishReason)
    }

    const usage = part.type === 'finish' ? part.totalUsage : part.usage
    diagnostics.inputTokens = this.maxNullableNumber(
      diagnostics.inputTokens,
      this.readNestedNumber(usage, ['inputTokens']) ??
        this.readNestedNumber(usage, ['promptTokens'])
    )
    diagnostics.outputTokens = this.maxNullableNumber(
      diagnostics.outputTokens,
      this.readNestedNumber(usage, ['outputTokens']) ??
        this.readNestedNumber(usage, ['completionTokens'])
    )
    diagnostics.totalTokens = this.maxNullableNumber(
      diagnostics.totalTokens,
      this.readNestedNumber(usage, ['totalTokens'])
    )
    // 键名对齐 ai@6 LanguageModelUsage:细分键是单数 Token(inputTokenDetails/outputTokenDetails)。
    // usage 由 asLanguageModelUsage 严格构造,表外键永不出现;顶层 reasoningTokens/cachedInputTokens 是废弃兼容位。
    diagnostics.reasoningTokens = this.maxNullableNumber(
      diagnostics.reasoningTokens,
      this.readNestedNumber(usage, ['outputTokenDetails', 'reasoningTokens']) ??
        this.readNestedNumber(usage, ['reasoningTokens'])
    )
    diagnostics.visibleOutputTokens = this.deriveVisibleOutputTokens(
      diagnostics.outputTokens,
      diagnostics.reasoningTokens
    )
    const cacheReadInputTokens =
      this.readNestedNumber(usage, ['inputTokenDetails', 'cacheReadTokens']) ??
      this.readNestedNumber(usage, ['cachedInputTokens'])
    diagnostics.cacheReadInputTokens = this.maxNullableNumber(
      toNullable(diagnostics.cacheReadInputTokens),
      cacheReadInputTokens
    )
    diagnostics.cachedInputTokens = this.maxNullableNumber(
      diagnostics.cachedInputTokens,
      cacheReadInputTokens
    )
    diagnostics.cacheWriteInputTokens = this.maxNullableNumber(
      toNullable(diagnostics.cacheWriteInputTokens),
      this.readNestedNumber(usage, ['inputTokenDetails', 'cacheWriteTokens']) ??
        readProviderCacheWriteInputTokens(part)
    )
    diagnostics.costUsd = this.maxNullableNumber(
      diagnostics.costUsd,
      this.readNestedNumber(usage, ['costUsd']) ??
        this.readNestedNumber(usage, ['costUSD']) ??
        this.readNestedNumber(usage, ['totalCostUsd']) ??
        this.readNestedNumber(part, ['providerMetadata', 'usage', 'costUsd']) ??
        this.readNestedNumber(part, ['providerMetadata', 'usage', 'costUSD']) ??
        this.readNestedNumber(part, ['providerMetadata', 'usage', 'totalCostUsd'])
    )
  }

  private findAbnormalFinishReason(diagnostics: StreamDiagnostics): Nullable<string> {
    const reasons = [...diagnostics.finishReasons, ...diagnostics.rawFinishReasons]
    // AI SDK 有时把 provider 的 max_tokens 归一成 other；先找已知异常，避免这个低信息别名
    // 抢在 raw finish reason 前面，让真正的长度截断逃过自动恢复。
    for (const reason of reasons) {
      if (normalizeFinishReason(reason) in AbnormalProviderFinishReasonMessages) return reason
    }

    // 非 Silent 一律上报(已知异常给专属文案,未知原因给通用文案)——未知原因静默丢弃过一次
    // 截断事故的全部痕迹。恢复判据另有白名单(OutputTruncationRecovery),不会因此误触发续写。
    for (const reason of reasons) {
      if (SilentProviderFinishReasons.has(normalizeFinishReason(reason))) continue
      return reason
    }

    return null
  }

  private recordRawChunkDiagnostic(diagnostics: StreamDiagnostics, rawValue: unknown): void {
    if (diagnostics.rawSamples.length >= MaxRawDiagnosticSamples) return

    if (!isPlainObject(rawValue)) {
      diagnostics.rawSamples.push({
        type: null,
        keys: [],
        choiceCount: null,
        deltaType: null,
        deltaKeys: [],
        contentBlockType: null,
        contentBlockKeys: [],
        messageStopReason: null,
        messageModel: null,
        messageContentCount: null,
        messageUsageInputTokens: null,
        messageUsageOutputTokens: null,
        messageKeys: [],
        messageContentTypes: [],
        itemType: null,
        itemKeys: [],
      })
      return
    }

    const record = rawValue as Record<string, unknown>
    const choices: unknown[] = isArray(record.choices) ? record.choices : []
    const firstChoice = choices.find(isPlainObject) as Record<string, unknown> | undefined
    const delta =
      isPlainObject(firstChoice?.delta)
        ? firstChoice.delta
        : isPlainObject(record.delta)
          ? record.delta
          : null
    const contentBlock = isPlainObject(record.content_block)
      ? record.content_block
      : null
    const message =
      isPlainObject(firstChoice?.message)
        ? firstChoice.message
        : isPlainObject(record.message)
          ? record.message
          : null
    const item = isPlainObject(record.item)
      ? record.item
      : null
    const messageUsage = message?.usage && isPlainObject(message.usage)
      ? message.usage
      : null
    const messageContent = message?.content

    diagnostics.rawSamples.push({
      type: isString(record.type) ? record.type : null,
      keys: this.safeObjectKeys(record),
      choiceCount: isArray(record.choices) ? record.choices.length : null,
      deltaType: isString(delta?.type) ? delta.type : null,
      deltaKeys: delta ? this.safeObjectKeys(delta) : [],
      contentBlockType: isString(contentBlock?.type) ? contentBlock.type : null,
      contentBlockKeys: contentBlock ? this.safeObjectKeys(contentBlock) : [],
      messageStopReason: isString(message?.stop_reason) ? message.stop_reason : null,
      messageModel: isString(message?.model) ? message.model : null,
      messageContentCount: isArray(messageContent) ? messageContent.length : null,
      messageUsageInputTokens: this.readNumber(messageUsage?.input_tokens),
      messageUsageOutputTokens: this.readNumber(messageUsage?.output_tokens),
      messageKeys: message ? this.safeObjectKeys(message) : [],
      messageContentTypes: this.readContentTypes(messageContent),
      itemType: isString(item?.type) ? item.type : null,
      itemKeys: item ? this.safeObjectKeys(item) : [],
    })
  }

  private formatRawDiagnosticSample(sample: StreamRawChunkDiagnostic): string {
    return [
      `type=${sample.type ?? 'n/a'}`,
      `keys=${sample.keys.join('|') || 'n/a'}`,
      !isPresent(sample.choiceCount) ? null : `choices=${sample.choiceCount}`,
      sample.deltaType ? `deltaType=${sample.deltaType}` : null,
      !isEmpty(sample.deltaKeys) ? `deltaKeys=${sample.deltaKeys.join('|')}` : null,
      sample.contentBlockType ? `contentBlockType=${sample.contentBlockType}` : null,
      !isEmpty(sample.contentBlockKeys)
        ? `contentBlockKeys=${sample.contentBlockKeys.join('|')}`
        : null,
      sample.messageStopReason ? `messageStopReason=${sample.messageStopReason}` : null,
      sample.messageModel ? `messageModel=${sample.messageModel}` : null,
      !isPresent(sample.messageContentCount)
        ? null
        : `messageContentCount=${sample.messageContentCount}`,
      !isPresent(sample.messageUsageInputTokens)
        ? null
        : `messageUsageInputTokens=${sample.messageUsageInputTokens}`,
      !isPresent(sample.messageUsageOutputTokens)
        ? null
        : `messageUsageOutputTokens=${sample.messageUsageOutputTokens}`,
      !isEmpty(sample.messageKeys) ? `messageKeys=${sample.messageKeys.join('|')}` : null,
      !isEmpty(sample.messageContentTypes)
        ? `messageContentTypes=${sample.messageContentTypes.join('|')}`
        : null,
      sample.itemType ? `itemType=${sample.itemType}` : null,
      !isEmpty(sample.itemKeys) ? `itemKeys=${sample.itemKeys.join('|')}` : null,
    ]
      .filter((part): part is string => !!part)
      .join(' ')
  }

  private readNumber(value: unknown): Nullable<number> {
    return isFiniteNumber(value) ? value : null
  }

  private readNestedNumber(value: unknown, path: string[]): Nullable<number> {
    let current = value
    for (const key of path) {
      if (!isPlainObject(current)) return null
      current = current[key]
    }

    return this.readNumber(current)
  }

  private maxNullableNumber(left: Nullable<number>, right: Nullable<number>): Nullable<number> {
    if (!isPresent(left)) return right

    if (!isPresent(right)) return left

    return Math.max(left, right)
  }

  private deriveVisibleOutputTokens(
    outputTokens: Nullable<number>,
    reasoningTokens: Nullable<number>
  ): Nullable<number> {
    if (!isFiniteNumber(outputTokens)) return null
    if (!isFiniteNumber(reasoningTokens)) return outputTokens

    return Math.max(outputTokens - reasoningTokens, 0)
  }

  private readContentTypes(value: unknown): string[] {
    if (!isArray(value)) return []

    return value
      .map((item) => {
        if (!isPlainObject(item)) return null

        const type = (item).type
        return isString(type) ? type : null
      })
      .filter((type): type is string => !!type)
  }

  private safeObjectKeys(value: Record<string, unknown>): string[] {
    return Object.keys(value).sort()
  }
}

function normalizeFinishReason(reason: string): string {
  const normalized = reason.trim().toLowerCase().replace(/-/g, '_')
  return ProviderFinishReasonAliases[normalized] ?? normalized
}

export { StreamDiagnosticRecorder }
export { StreamDiagnosticRecorder as AgentStreamDiagnosticRecorder }
