import type { TextStreamPart, ToolSet } from 'ai'

import { isArray, isEmpty, isFiniteNumber,isPlainObject, isPresent, isString, toNullable } from '@velaros-ai/core'

import type { StreamActivityDiagnostics, StreamDiagnostics, StreamDiagnosticsSummary, StreamFinishDiagnostics, StreamFinishReasonDiagnostic, StreamRawChunkDiagnostic, StreamUsageDiagnostics } from '../../types/loop.js'
import { AgentTuning } from '../tuning'


const ProviderCacheWriteInputTokenPaths = [
  ['providerMetadata', 'anthropic', 'cacheCreationInputTokens'],
  ['providerMetadata', 'vertex', 'cacheCreationInputTokens'],
  ['providerMetadata', 'bedrock', 'usage', 'cacheWriteInputTokens'],
  ['providerMetadata', 'venice', 'usage', 'cacheCreationInputTokens'],
] as const

/** 按各 provider 的 metadata 路径挨个找「写缓存」的输入 token 数，第一条命中即返回，全都没有返回 null。 */
function readProviderCacheWriteInputTokens(part: unknown): Nullable<number> {
  for (const path of ProviderCacheWriteInputTokenPaths) {
    const value = readNestedNumber(part, path)
    if (isPresent(value)) return value
  }
  return null
}

/** 顺着一串键名往下取值，中途遇到非普通对象就返回 null；末端不是有限数也返回 null。 */
function readNestedNumber(value: unknown, path: readonly string[]): Nullable<number> {
  let current = value
  for (const key of path) {
    if (!current || !isPlainObject(current)) return null
    current = (current)[key]
  }
  return readNumber(current)
}

/** 原始流诊断最多采样几片，值在 `AgentTuning.stream.maxRawDiagnosticSamples`。 */
const MaxRawDiagnosticSamples = AgentTuning.stream.maxRawDiagnosticSamples
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

/** 开一条流的诊断账本：活动、收尾、用量三段清零，raw 样本表置空。 */
function createStreamDiagnostics(): StreamDiagnostics {
  return {
    ...createStreamActivityDiagnostics(),
    ...createStreamFinishDiagnostics(),
    ...createStreamUsageDiagnostics(),
    rawSamples: [],
  }
}

/** 活动段的初值：分片总数、各类型计数与各类字符数全部从零起算。 */
function createStreamActivityDiagnostics(): StreamActivityDiagnostics {
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

/** 收尾段的初值：归一化与原始两份 finishReason 名单都置空。 */
function createStreamFinishDiagnostics(): StreamFinishDiagnostics {
  return {
    finishReasons: [],
    rawFinishReasons: [],
  }
}

/** 用量段的初值：所有 token 与费用口径都置 null，表示「上游没给」。 */
function createStreamUsageDiagnostics(): StreamUsageDiagnostics {
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

/** 逐分片记账：计数分片类型，正文/思考累加字符数，收尾分片记 finishReason 与用量，raw 分片留样本。就地改账本。 */
function recordStreamPartDiagnostics(diagnostics: StreamDiagnostics, part: TextStreamPart<ToolSet>): void {
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
    recordFinishDiagnostics(diagnostics, part)
    return
  }

  if (part.type === 'finish-step') {
    recordFinishDiagnostics(diagnostics, part)
    return
  }

  if (part.type === 'raw') {
    recordRawChunkDiagnostic(diagnostics, part.rawValue)
  }
}

/** 整条流收完却没有任何可展示输出时，按 finishReason 给一段解释性兜底文案（长度截断与普通空响应分开说）。 */
function buildNonDisplayableResponseMessage(
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

/** 把账本压成可进日志的摘要：raw 样本的各类键名各截前若干项，再给每条样本配一行扁平文本。 */
function summarizeStreamDiagnostics(diagnostics: StreamDiagnostics): StreamDiagnosticsSummary {
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
    rawSampleSummaries: rawSamples.map((sample) => formatRawDiagnosticSample(sample)),
  }
}

/** 结束原因异常时产出一条可进回合账本的诊断（已知异常给专属文案，未知原因给通用文案）；正常收尾返回 null。 */
function buildAbnormalFinishReasonDiagnostic(
  diagnostics: StreamDiagnostics
): Nullable<StreamFinishReasonDiagnostic> {
  const finishReason = findAbnormalFinishReason(diagnostics)
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

/** 收尾分片的记账：去重收下两份 finishReason，并把 usage 里的各项 token 与费用按「取大」并进账本。 */
function recordFinishDiagnostics(
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
  diagnostics.inputTokens = maxNullableNumber(
    diagnostics.inputTokens,
    readNestedNumber(usage, ['inputTokens']) ??
      readNestedNumber(usage, ['promptTokens'])
  )
  diagnostics.outputTokens = maxNullableNumber(
    diagnostics.outputTokens,
    readNestedNumber(usage, ['outputTokens']) ??
      readNestedNumber(usage, ['completionTokens'])
  )
  diagnostics.totalTokens = maxNullableNumber(
    diagnostics.totalTokens,
    readNestedNumber(usage, ['totalTokens'])
  )
  // 键名对齐 ai@6 LanguageModelUsage:细分键是单数 Token(inputTokenDetails/outputTokenDetails)。
  // usage 由 asLanguageModelUsage 严格构造,表外键永不出现;顶层 reasoningTokens/cachedInputTokens 是废弃兼容位。
  diagnostics.reasoningTokens = maxNullableNumber(
    diagnostics.reasoningTokens,
    readNestedNumber(usage, ['outputTokenDetails', 'reasoningTokens']) ??
      readNestedNumber(usage, ['reasoningTokens'])
  )
  diagnostics.visibleOutputTokens = deriveVisibleOutputTokens(
    diagnostics.outputTokens,
    diagnostics.reasoningTokens
  )
  const cacheReadInputTokens =
    readNestedNumber(usage, ['inputTokenDetails', 'cacheReadTokens']) ??
    readNestedNumber(usage, ['cachedInputTokens'])
  diagnostics.cacheReadInputTokens = maxNullableNumber(
    toNullable(diagnostics.cacheReadInputTokens),
    cacheReadInputTokens
  )
  diagnostics.cachedInputTokens = maxNullableNumber(
    diagnostics.cachedInputTokens,
    cacheReadInputTokens
  )
  diagnostics.cacheWriteInputTokens = maxNullableNumber(
    toNullable(diagnostics.cacheWriteInputTokens),
    readNestedNumber(usage, ['inputTokenDetails', 'cacheWriteTokens']) ??
      readProviderCacheWriteInputTokens(part)
  )
  diagnostics.costUsd = maxNullableNumber(
    diagnostics.costUsd,
    readNestedNumber(usage, ['costUsd']) ??
      readNestedNumber(usage, ['costUSD']) ??
      readNestedNumber(usage, ['totalCostUsd']) ??
      readNestedNumber(part, ['providerMetadata', 'usage', 'costUsd']) ??
      readNestedNumber(part, ['providerMetadata', 'usage', 'costUSD']) ??
      readNestedNumber(part, ['providerMetadata', 'usage', 'totalCostUsd'])
  )
}

/** 在两份 finishReason 名单里挑出该上报的那个：先找已知异常，再退回第一个非静默原因；都正常返回 null。 */
function findAbnormalFinishReason(diagnostics: StreamDiagnostics): Nullable<string> {
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

/** 留一条 raw 分片的形状样本（类型、各层键名、usage 数字）；样本满了就不再记，只看形状不存内容。 */
function recordRawChunkDiagnostic(diagnostics: StreamDiagnostics, rawValue: unknown): void {
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
    keys: safeObjectKeys(record),
    choiceCount: isArray(record.choices) ? record.choices.length : null,
    deltaType: isString(delta?.type) ? delta.type : null,
    deltaKeys: delta ? safeObjectKeys(delta) : [],
    contentBlockType: isString(contentBlock?.type) ? contentBlock.type : null,
    contentBlockKeys: contentBlock ? safeObjectKeys(contentBlock) : [],
    messageStopReason: isString(message?.stop_reason) ? message.stop_reason : null,
    messageModel: isString(message?.model) ? message.model : null,
    messageContentCount: isArray(messageContent) ? messageContent.length : null,
    messageUsageInputTokens: readNumber(messageUsage?.input_tokens),
    messageUsageOutputTokens: readNumber(messageUsage?.output_tokens),
    messageKeys: message ? safeObjectKeys(message) : [],
    messageContentTypes: readContentTypes(messageContent),
    itemType: isString(item?.type) ? item.type : null,
    itemKeys: item ? safeObjectKeys(item) : [],
  })
}

/** 把一条 raw 样本压成一行 `键=值` 文本，空字段直接省略，供日志一眼看形状。 */
function formatRawDiagnosticSample(sample: StreamRawChunkDiagnostic): string {
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

/** 只收有限数，其余（含 NaN、Infinity、非数字）一律归 null。 */
function readNumber(value: unknown): Nullable<number> {
  return isFiniteNumber(value) ? value : null
}

/** 两个可空数字取大：有一边缺就用另一边，都缺返回 null。用来把多次收尾上报合成一份账。 */
function maxNullableNumber(left: Nullable<number>, right: Nullable<number>): Nullable<number> {
  if (!isPresent(left)) return right

  if (!isPresent(right)) return left

  return Math.max(left, right)
}

/** 从输出 token 里扣掉思考 token 得到「可见输出」；没有输出数返回 null，没有思考数就原样返回，结果不为负。 */
function deriveVisibleOutputTokens(
  outputTokens: Nullable<number>,
  reasoningTokens: Nullable<number>
): Nullable<number> {
  if (!isFiniteNumber(outputTokens)) return null
  if (!isFiniteNumber(reasoningTokens)) return outputTokens

  return Math.max(outputTokens - reasoningTokens, 0)
}

/** 取一段 message.content 里每一项的 type 名单；不是数组或没有 type 的项直接跳过。 */
function readContentTypes(value: unknown): string[] {
  if (!isArray(value)) return []

  return value
    .map((item) => {
      if (!isPlainObject(item)) return null

      const type = (item).type
      return isString(type) ? type : null
    })
    .filter((type): type is string => !!type)
}

/** 取对象的键名并排序，保证同形状的分片在日志里给出同一行文本。 */
function safeObjectKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).sort()
}

/** 把 provider 的 finish 原因归一：去空白、转小写、连字符换下划线，再按别名表折到标准名。 */
function normalizeFinishReason(reason: string): string {
  const normalized = reason.trim().toLowerCase().replace(/-/g, '_')
  return ProviderFinishReasonAliases[normalized] ?? normalized
}

export {
  buildAbnormalFinishReasonDiagnostic,
  buildNonDisplayableResponseMessage,
  createStreamDiagnostics,
  recordStreamPartDiagnostics,
  summarizeStreamDiagnostics,
}
