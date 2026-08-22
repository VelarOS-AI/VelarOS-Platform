import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamResult,
} from '@ai-sdk/provider'
import type { LanguageModel, ModelMessage } from 'ai'

import { isArray, isEmpty,isPlainObject, isPresent, isString } from '@velaros-ai/core'

import type { ModelRequestOptions } from './ModelContracts'

/**
 * 提示词缓存断点的**内部协议**与出线翻译。
 *
 * 导览（§5.3b ①算法协议 / ⑤跨层接缝）——上游（智能体或宿主）只会说一句“这里是缓存断点”，
 * 各家服务商的线上写法却完全不同。本文件是这套内部标记与线上字段之间的**唯一翻译层**。
 *
 * **协议**：内部标记全部住在 `providerOptions.velaros` 命名空间下，只有两个键——
 * `promptCacheBreakpoint`（消息级断点）与 `promptCacheKey`（会话级缓存键）。
 *
 * **不变量（改这里先确认这三条还成立）**：
 * 1. `velaros` 命名空间**绝不能出线**。`applyPromptCacheCallOptions` 在
 *    `doGenerate` 或 `doStream` 前把它整个剥掉并翻译成 `anthropic.cacheControl` 或
 *    `openai.promptCacheKey`；漏剥会让服务商收到未知字段并拒绝整次请求。
 * 2. **同一轮只有最后一条用户消息带断点**。`markLatestUserMessagePromptCacheBreakpoint`
 *    先清掉历史用户消息上的陈旧断点再打新的——Anthropic 的断点数量有硬上限，
 *    残留旧断点会让新断点被拒，缓存命中率反而归零。
 * 3. **调用方显式写的线上字段永远赢**。`hasExplicitProviderPromptCacheKey` /
 *    `hasProviderWireCacheControl` 命中时本层不覆盖也不追加——这是"产品默认值不得压过显式意图"。
 *
 * **为什么包装一层语言模型而不在装配处改选项**：断点必须跟随每一次 `doGenerate` 或 `doStream`，
 * 而选项逐轮构造；包装模型能让翻译落在唯一必经之路上，装配处漏接线也不会静默失效。
 *
 * **会话缓存键**：`resolveSessionPromptCacheKey` 使用 `FNV-1a` 哈希与可读前缀。哈希只用于稳定分桶，
 * 不承担安全语义；会话标识不应原样出线，所以更换算法只影响命中率，不影响正确性。
 */
const SessionPromptCacheKeyHashSeed = 0x811c9dc5
const SessionPromptCacheKeyHashPrime = 0x01000193
const SessionPromptCacheKeyPrefixMaxChars = 48

const VelarosProviderOptionsKey = 'velaros'
const PromptCacheBreakpointKey = 'promptCacheBreakpoint'
const PromptCacheKeyField = 'promptCacheKey'
const AnthropicProviderKey = 'anthropic'
const OpenAiProviderKey = 'openai'
const CacheControlField = 'cacheControl'

type CoreProviderOptions = ModelRequestOptions['providerOptions']
type ModelMessageProviderOptions = NonNullable<ModelMessage['providerOptions']>

function createPromptCacheSystemMessage(content: string): ModelMessage {
  return {
    role: 'system',
    content,
    providerOptions: mergePromptCacheBreakpointProviderOptions(undefined),
  }
}

function markLatestUserMessagePromptCacheBreakpoint(
  messages: readonly ModelMessage[]
): ModelMessage[] {
  const latestUserIndex = findLatestUserMessageIndex(messages)
  if (latestUserIndex < 0) return [...messages]

  const next = messages.map((message, index) =>
    index === latestUserIndex ? message : removeStaleUserPromptCacheBoundary(message)
  )

  const target = next[latestUserIndex]
  if (!target) return next

  const providerOptions = target.providerOptions
  if (hasProviderPromptCacheBreakpoint(providerOptions)) return next

  next[latestUserIndex] = {
    ...target,
    providerOptions: mergePromptCacheBreakpointProviderOptions(providerOptions),
  }
  return next
}

function findLatestUserMessageIndex(messages: readonly ModelMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return index
  }

  return -1
}

function removeStaleUserPromptCacheBoundary(message: ModelMessage): ModelMessage {
  if (message.role !== 'user') return message

  const providerOptions = message.providerOptions
  if (!isPlainObject(providerOptions)) return message

  const nextProviderOptions = removePromptCacheBoundaryProviderOptions(providerOptions)
  if (nextProviderOptions === providerOptions) return message

  const nextMessage = { ...message } as ModelMessage
  if (isPlainObject(nextProviderOptions) && !isEmpty(Object.keys(nextProviderOptions))) {
    nextMessage.providerOptions = nextProviderOptions as ModelMessageProviderOptions
  } else {
    delete nextMessage.providerOptions
  }
  return nextMessage
}

function resolveSessionPromptCacheKey(sessionId: LooseOptional<string>): LooseOptional<string> {
  const trimmed = sessionId?.trim()
  if (!trimmed || trimmed === 'unknown-session') return undefined

  const safePrefix = trimmed
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SessionPromptCacheKeyPrefixMaxChars)
  const prefix = safePrefix || 'session'
  return `session-${prefix}-${hashPromptCacheKey(trimmed)}`
}

function mergeSessionPromptCacheProviderOptions(
  modelRequestOptions: LooseOptional<ModelRequestOptions>,
  sessionId: LooseOptional<string>
): CoreProviderOptions {
  const providerOptions = modelRequestOptions?.providerOptions
  const promptCacheKey = resolveSessionPromptCacheKey(sessionId)
  if (!promptCacheKey) return providerOptions
  if (hasExplicitProviderPromptCacheKey(providerOptions)) return providerOptions

  const velarosOptions = providerOptions?.[VelarosProviderOptionsKey]
  if (isPresent(velarosOptions) && !isPlainObject(velarosOptions)) return providerOptions

  return {
    ...(providerOptions ?? {}),
    [VelarosProviderOptionsKey]: {
      ...((velarosOptions ?? {}) as Record<string, unknown>),
      [PromptCacheKeyField]: promptCacheKey,
    },
  }
}

function applyPromptCacheProviderOptions(model: LanguageModel): LanguageModel {
  if (isString(model) || model.specificationVersion !== 'v3') return model

  return new PromptCacheLanguageModel(model)
}

function applyPromptCacheCallOptions(
  options: LanguageModelV3CallOptions
): LanguageModelV3CallOptions {
  const providerOptions = applyTopLevelPromptCacheProviderOptions(options.providerOptions)
  const prompt = applyPromptPromptCacheProviderOptions(options.prompt)
  if (providerOptions === options.providerOptions && prompt === options.prompt) return options

  return {
    ...options,
    providerOptions,
    prompt,
  }
}

class PromptCacheLanguageModel implements LanguageModelV3 {
  constructor(private readonly model: LanguageModelV3) {}

  public get specificationVersion(): 'v3' {
    return this.model.specificationVersion
  }

  public get provider(): string {
    return this.model.provider
  }

  public get modelId(): string {
    return this.model.modelId
  }

  public get supportedUrls(): LanguageModelV3['supportedUrls'] {
    return this.model.supportedUrls
  }

  public doGenerate(
    options: LanguageModelV3CallOptions
  ): PromiseLike<LanguageModelV3GenerateResult> {
    return this.model.doGenerate(applyPromptCacheCallOptions(options))
  }

  public doStream(options: LanguageModelV3CallOptions): PromiseLike<LanguageModelV3StreamResult> {
    return this.model.doStream(applyPromptCacheCallOptions(options))
  }
}

function applyTopLevelPromptCacheProviderOptions(
  providerOptions: LanguageModelV3CallOptions['providerOptions']
): LanguageModelV3CallOptions['providerOptions'] {
  if (!isPlainObject(providerOptions)) return providerOptions

  const promptCacheKey = readVelarosPromptCacheKey(providerOptions)
  const strippedOptions = omitRecordKey(providerOptions, VelarosProviderOptionsKey)
  let nextOptions = !isEmpty(Object.keys(strippedOptions))
    ? strippedOptions
    : undefined

  if (promptCacheKey && !hasExplicitProviderPromptCacheKey(providerOptions)) {
    nextOptions = mergeProviderOptionRecord(nextOptions, OpenAiProviderKey, {
      [PromptCacheKeyField]: promptCacheKey,
    })
  }

  return nextOptions as LanguageModelV3CallOptions['providerOptions']
}

function applyPromptPromptCacheProviderOptions(
  prompt: LanguageModelV3CallOptions['prompt']
): LanguageModelV3CallOptions['prompt'] {
  if (!isArray(prompt)) return prompt

  let changed = false
  const nextPrompt = prompt.map((message) => {
    const nextMessage = applyMessagePromptCacheProviderOptions(message)
    changed ||= nextMessage !== message
    return nextMessage
  })

  return changed ? nextPrompt as LanguageModelV3CallOptions['prompt'] : prompt
}

function applyMessagePromptCacheProviderOptions(message: unknown): unknown {
  if (!isPlainObject(message)) return message

  const providerOptions = message.providerOptions
  if (!isPlainObject(providerOptions)) return message

  const hasBreakpoint = hasProviderPromptCacheBreakpoint(providerOptions)
  const strippedOptions = removeVelarosPromptCacheBoundaryProviderOptions(providerOptions)
  let nextProviderOptions = !isEmpty(Object.keys(strippedOptions))
    ? strippedOptions
    : undefined

  if (hasBreakpoint && !hasProviderWireCacheControl(providerOptions)) {
    nextProviderOptions = mergeProviderOptionRecord(nextProviderOptions, AnthropicProviderKey, {
      [CacheControlField]: { type: 'ephemeral' },
    })
  }

  if (nextProviderOptions === providerOptions) return message

  return {
    ...message,
    providerOptions: nextProviderOptions,
  }
}

function hasProviderPromptCacheBreakpoint(providerOptions: unknown): boolean {
  if (!isPlainObject(providerOptions)) return false

  const velarosOptions = providerOptions[VelarosProviderOptionsKey]
  if (
    isPlainObject(velarosOptions) &&
    isPresent(velarosOptions[PromptCacheBreakpointKey])
  ) return true

  return hasProviderWireCacheControl(providerOptions)
}

function hasProviderWireCacheControl(providerOptions: unknown): boolean {
  if (!isPlainObject(providerOptions)) return false

  const providerWireOptions = providerOptions[AnthropicProviderKey]
  return isPlainObject(providerWireOptions) &&
    isPresent(providerWireOptions[CacheControlField])
}

function hasExplicitProviderPromptCacheKey(providerOptions: unknown): boolean {
  if (!isPlainObject(providerOptions)) return false

  const providerWireOptions = providerOptions[OpenAiProviderKey]
  if (!isPlainObject(providerWireOptions)) return isPresent(providerWireOptions)

  const promptCacheKey = providerWireOptions[PromptCacheKeyField]
  return isString(promptCacheKey) && !isEmpty(promptCacheKey.trim())
}

function mergePromptCacheBreakpointProviderOptions(
  providerOptions: unknown
): ModelMessageProviderOptions {
  const base = isPlainObject(providerOptions) ? providerOptions : {}
  const velarosOptions = base[VelarosProviderOptionsKey]
  if (isPresent(velarosOptions) && !isPlainObject(velarosOptions)) return base as ModelMessageProviderOptions

  return {
    ...base,
    [VelarosProviderOptionsKey]: {
      ...((velarosOptions ?? {}) as Record<string, unknown>),
      [PromptCacheBreakpointKey]: { type: 'ephemeral' },
    },
  } as ModelMessageProviderOptions
}

function removePromptCacheBoundaryProviderOptions(
  providerOptions: Record<string, unknown>
): Record<string, unknown> {
  let changed = false
  const nextProviderOptions: Record<string, unknown> = { ...providerOptions }

  const velarosOptions = providerOptions[VelarosProviderOptionsKey]
  if (isPlainObject(velarosOptions) && PromptCacheBreakpointKey in velarosOptions) {
    changed = true
    const nextVelarosOptions = omitRecordKey(velarosOptions, PromptCacheBreakpointKey)
    if (!isEmpty(Object.keys(nextVelarosOptions))) {
      nextProviderOptions[VelarosProviderOptionsKey] = nextVelarosOptions
    } else {
      delete nextProviderOptions[VelarosProviderOptionsKey]
    }
  }

  const providerWireOptions = providerOptions[AnthropicProviderKey]
  if (isPlainObject(providerWireOptions) && CacheControlField in providerWireOptions) {
    changed = true
    const nextWireOptions = omitRecordKey(providerWireOptions, CacheControlField)
    if (!isEmpty(Object.keys(nextWireOptions))) {
      nextProviderOptions[AnthropicProviderKey] = nextWireOptions
    } else {
      delete nextProviderOptions[AnthropicProviderKey]
    }
  }

  return changed ? nextProviderOptions : providerOptions
}

function removeVelarosPromptCacheBoundaryProviderOptions(
  providerOptions: Record<string, unknown>
): Record<string, unknown> {
  const velarosOptions = providerOptions[VelarosProviderOptionsKey]
  if (!isPlainObject(velarosOptions) || !(PromptCacheBreakpointKey in velarosOptions)) return providerOptions

  const nextProviderOptions: Record<string, unknown> = { ...providerOptions }
  const nextVelarosOptions = omitRecordKey(velarosOptions, PromptCacheBreakpointKey)
  if (!isEmpty(Object.keys(nextVelarosOptions))) {
    nextProviderOptions[VelarosProviderOptionsKey] = nextVelarosOptions
  } else {
    delete nextProviderOptions[VelarosProviderOptionsKey]
  }

  return nextProviderOptions
}

function readVelarosPromptCacheKey(providerOptions: Record<string, unknown>): LooseOptional<string> {
  const velarosOptions = providerOptions[VelarosProviderOptionsKey]
  if (!isPlainObject(velarosOptions)) return undefined

  const promptCacheKey = velarosOptions[PromptCacheKeyField]
  if (!isString(promptCacheKey)) return undefined

  const trimmed = promptCacheKey.trim()
  return isEmpty(trimmed) ? undefined : trimmed
}

function mergeProviderOptionRecord(
  existing: Optional<Record<string, unknown>>,
  providerKey: string,
  value: Record<string, unknown>
): Record<string, unknown> {
  const current = existing?.[providerKey]
  return {
    ...(existing ?? {}),
    [providerKey]: isPlainObject(current) ? { ...current, ...value } : value,
  }
}

function omitRecordKey(record: Record<string, unknown>, omittedKey: string): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== omittedKey)
  )
}

function hashPromptCacheKey(value: string): string {
  let hash = SessionPromptCacheKeyHashSeed
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, SessionPromptCacheKeyHashPrime) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export {
  applyPromptCacheCallOptions,
  applyPromptCacheProviderOptions,
  createPromptCacheSystemMessage,
  markLatestUserMessagePromptCacheBreakpoint,
  mergeSessionPromptCacheProviderOptions,
  resolveSessionPromptCacheKey,
}
