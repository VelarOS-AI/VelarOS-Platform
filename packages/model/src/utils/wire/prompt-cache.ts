import type { LanguageModelV3CallOptions } from '@ai-sdk/provider'

import { isArray, isEmpty, isPlainObject, isPresent, isString } from '@velaros-ai/core'

/**
 * 提示词缓存断点的**内部协议**与出线翻译。
 *
 * 导览（§5.3b ①算法协议 / ⑤跨层接缝）——上游（智能体或宿主）只会说一句"这里是缓存断点"，
 * 各家服务商的线上写法却完全不同。本文件是这套内部标记与线上字段之间的**唯一翻译层**。
 *
 * **协议**：内部标记全部住在 `providerOptions.velaros` 命名空间下，只有两个键——
 * `promptCacheBreakpoint`（消息级断点）与 `promptCacheKey`（会话级缓存键）。写标记是 agent 的活，
 * 本包只负责出线前把它们翻译掉。
 *
 * **不变量（改这里先确认这两条还成立）**：
 * 1. `velaros` 命名空间**绝不能出线**。`applyPromptCacheCallOptions` 在 `doGenerate` 或
 *    `doStream` 前把它整个剥掉并翻译成 `anthropic.cacheControl` 或 `openai.promptCacheKey`；
 *    漏剥会让服务商收到未知字段并拒绝整次请求。
 * 2. **调用方显式写的线上字段永远赢**。`hasExplicitProviderPromptCacheKey` /
 *    `hasProviderWireCacheControl` 命中时本层不覆盖也不追加——这是"产品默认值不得压过显式意图"。
 */
const VelarosProviderOptionsKey = 'velaros'
const PromptCacheBreakpointKey = 'promptCacheBreakpoint'
const PromptCacheKeyField = 'promptCacheKey'
const AnthropicProviderKey = 'anthropic'
const OpenAiProviderKey = 'openai'
const CacheControlField = 'cacheControl'

/** 出线前把内部缓存标记整体翻译成各家的线上字段。 */
export function applyPromptCacheCallOptions(
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

/** 顶层选项：剥掉 velaros 命名空间，把会话缓存键翻译成 `openai.promptCacheKey`。 */
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

/** 逐条消息翻译；一条都没变时原样返回，别让上游白白复制一遍 prompt。 */
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

/** 单条消息：剥掉 velaros 断点标记，需要时补上 `anthropic.cacheControl`。 */
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

/** 这条消息上有没有断点：内部标记或已经写好的线上字段都算。 */
function hasProviderPromptCacheBreakpoint(providerOptions: unknown): boolean {
  if (!isPlainObject(providerOptions)) return false

  const velarosOptions = providerOptions[VelarosProviderOptionsKey]
  if (
    isPlainObject(velarosOptions) &&
    isPresent(velarosOptions[PromptCacheBreakpointKey])
  ) return true

  return hasProviderWireCacheControl(providerOptions)
}

/** 调用方是不是已经自己写了 `anthropic.cacheControl`。 */
function hasProviderWireCacheControl(providerOptions: unknown): boolean {
  if (!isPlainObject(providerOptions)) return false

  const providerWireOptions = providerOptions[AnthropicProviderKey]
  return isPlainObject(providerWireOptions) &&
    isPresent(providerWireOptions[CacheControlField])
}

/** 调用方是不是已经自己写了 `openai.promptCacheKey`。 */
function hasExplicitProviderPromptCacheKey(providerOptions: unknown): boolean {
  if (!isPlainObject(providerOptions)) return false

  const providerWireOptions = providerOptions[OpenAiProviderKey]
  if (!isPlainObject(providerWireOptions)) return isPresent(providerWireOptions)

  const promptCacheKey = providerWireOptions[PromptCacheKeyField]
  return isString(promptCacheKey) && !isEmpty(promptCacheKey.trim())
}

/** 去掉消息上的 velaros 断点标记；velaros 命名空间空了就整个删掉。 */
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

/** 读出 velaros 命名空间里的会话缓存键；空白值按缺席处理。 */
function readVelarosPromptCacheKey(providerOptions: Record<string, unknown>): LooseOptional<string> {
  const velarosOptions = providerOptions[VelarosProviderOptionsKey]
  if (!isPlainObject(velarosOptions)) return undefined

  const promptCacheKey = velarosOptions[PromptCacheKeyField]
  if (!isString(promptCacheKey)) return undefined

  const trimmed = promptCacheKey.trim()
  return isEmpty(trimmed) ? undefined : trimmed
}

/** 往某个厂商的命名空间里合并几个字段，已有的同名字段保留。 */
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

/** 复制一份去掉某个键的记录。 */
function omitRecordKey(record: Record<string, unknown>, omittedKey: string): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== omittedKey)
  )
}
