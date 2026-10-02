import type { LanguageModelV3CallOptions, SharedV3ProviderOptions } from '@ai-sdk/provider'
import type { ModelMessage } from 'ai'

import {
  isArray,
  isEmpty,
  isFalse,
  isNonBlankString,
  isPlainObject,
  isPresent,
  isString,
  isTrue,
  isUndefined,
  optionalWhen,
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { ModelHistoryMessage } from '@velaros-ai/kernel'

import type { PromptCacheWireOptions } from '../../types/adapters'

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
 * **不变量（改这里先确认这三条还成立）**：
 * 1. `velaros` 命名空间**绝不能出线**。`applyPromptCacheCallOptions` 在 `doGenerate` 或
 *    `doStream` 前把它整个剥掉并翻译成各线路的 cacheControl、promptCacheBreakpoint 或 promptCacheKey；
 *    漏剥会让服务商收到未知字段并拒绝整次请求。
 * 2. **调用方显式写的线上字段永远赢**。`hasExplicitProviderPromptCacheKey` /
 *    `hasProviderWireCacheControl` 命中时本层不覆盖也不追加——这是"产品默认值不得压过显式意图"。
 *    宿主明确禁用 OpenAI 断点时，手写断点按配置冲突拒绝，不静默改写。
 * 3. **会话缓存键只发给认它的线路**。同样走 OpenAI SDK 的兼容线路未必认 `prompt_cache_key`：
 *    Groq 回 400、Mistral 回 422，整次请求作废。所以适配器用 `PromptCacheWireOptions.sessionKey`
 *    声明认不认，不认的只剥掉内部标记。
 */
const VelarosProviderOptionsKey = 'velaros'
const PromptCacheBreakpointKey = 'promptCacheBreakpoint'
const PromptCacheKeyField = 'promptCacheKey'
const AnthropicProviderKey = 'anthropic'
const OpenAiProviderKey = 'openai'
const CacheControlField = 'cacheControl'

/** 中立消息上的缓存断点写成内部标记，出线前由 `applyPromptCacheCallOptions` 翻译。 */
export function markPromptCacheBreakpoints(
  messages: readonly ModelHistoryMessage[]
): ModelMessage[] {
  return messages.map(({ cacheBreakpoint, ...source }) => {
    const message =
      source.role === 'assistant' ? { role: source.role, content: source.content } : source
    return cacheBreakpoint
      ? {
          ...message,
          providerOptions: { [VelarosProviderOptionsKey]: { [PromptCacheBreakpointKey]: true } },
        }
      : message
  })
}

/** 中立请求的会话缓存键写成内部标记，并入调用方已有的供应商选项。 */
export function withPromptCacheKey(
  providerOptions: Optional<SharedV3ProviderOptions>,
  cacheKey: Optional<string>
): Optional<SharedV3ProviderOptions> {
  if (!cacheKey) return providerOptions
  return { ...providerOptions, [VelarosProviderOptionsKey]: { [PromptCacheKeyField]: cacheKey } }
}

/** 出线前把内部缓存标记整体翻译成各家的线上字段；会话缓存键只在线路认它时出线。 */
export function applyPromptCacheCallOptions(
  options: LanguageModelV3CallOptions,
  wire: PromptCacheWireOptions
): LanguageModelV3CallOptions {
  const providerOptions = applyTopLevelPromptCacheProviderOptions(options.providerOptions, wire)
  const prompt = applyPromptPromptCacheProviderOptions(options, wire)
  if (providerOptions === options.providerOptions && prompt === options.prompt) return options

  return {
    ...options,
    providerOptions,
    prompt,
  }
}

/** 顶层选项：剥掉 velaros 命名空间，线路认的话把会话缓存键翻译成 `openai.promptCacheKey`。 */
function applyTopLevelPromptCacheProviderOptions(
  providerOptions: LanguageModelV3CallOptions['providerOptions'],
  wire: PromptCacheWireOptions
): LanguageModelV3CallOptions['providerOptions'] {
  if (!isPlainObject(providerOptions)) return providerOptions

  const promptCacheKey = readVelarosPromptCacheKey(providerOptions)
  const strippedOptions = omitRecordKey(providerOptions, VelarosProviderOptionsKey)
  let nextOptions = !isEmpty(Object.keys(strippedOptions)) ? strippedOptions : undefined

  if (wire.sessionKey && promptCacheKey && !hasExplicitProviderPromptCacheKey(providerOptions)) {
    nextOptions = mergeProviderOptionRecord(nextOptions, OpenAiProviderKey, {
      [PromptCacheKeyField]: promptCacheKey,
    })
  }

  return nextOptions as LanguageModelV3CallOptions['providerOptions']
}

/** 逐条消息翻译；一条都没变时原样返回，别让上游白白复制一遍 prompt。 */
function applyPromptPromptCacheProviderOptions(
  options: LanguageModelV3CallOptions,
  wire: PromptCacheWireOptions
): LanguageModelV3CallOptions['prompt'] {
  const prompt = options.prompt
  if (!isArray(prompt)) return prompt
  const anthropicBoundaries = selectAnthropicBoundaries(options, wire)

  // 默认隐式缓存占一处写入槽；先保留调用方显式断点，再按余量选最近的内部断点。
  // 上游可分别标记已退役结果结尾的稳定前缀和历史末尾；当前帧不自动增加断点。
  const existing = prompt.reduce(
    (count, message) =>
      count +
      (isArray(message.content)
        ? message.content.filter((part) => hasOpenAiBreakpoint(part.providerOptions)).length
        : Number(hasOpenAiBreakpoint(message.providerOptions))),
    0
  )
  if (isFalse(wire.openaiBreakpoints) && existing > 0)
    throw new AppError(
      'VALIDATION',
      '当前供应商配置禁用 OpenAI 显式缓存断点，与调用方显式断点冲突。'
    )
  const boundaries = new Set(
    wire.openaiBreakpoints && existing < 3
      ? prompt
          .flatMap((message, index) =>
            hasProviderPromptCacheBreakpoint(message.providerOptions) &&
            canAddOpenAiBreakpoint(message)
              ? [index]
              : []
          )
          .slice(-(3 - existing))
      : []
  )
  let changed = false
  const nextPrompt = prompt.map((message, index) => {
    const translated = applyMessagePromptCacheProviderOptions(
      message,
      wire,
      anthropicBoundaries?.has(index)
    )
    const nextMessage = boundaries.has(index) ? withOpenAiBreakpoint(translated) : translated
    changed ||= nextMessage !== message
    return nextMessage
  })

  return changed ? (nextPrompt as LanguageModelV3CallOptions['prompt']) : prompt
}

/** 单条消息：剥掉 velaros 断点标记，需要时补上 `anthropic.cacheControl`。 */
function applyMessagePromptCacheProviderOptions(
  message: unknown,
  wire: PromptCacheWireOptions,
  anthropicBoundary?: boolean
): unknown {
  if (!isPlainObject(message)) return message

  const providerOptions = message.providerOptions
  if (!isPlainObject(providerOptions)) return message

  const hasBreakpoint = hasProviderPromptCacheBreakpoint(providerOptions)
  const strippedOptions = omitRecordKey(providerOptions, VelarosProviderOptionsKey)
  let nextProviderOptions = !isEmpty(Object.keys(strippedOptions)) ? strippedOptions : undefined

  if (
    hasBreakpoint &&
    !wire.openaiBreakpoints &&
    (isUndefined(wire.anthropicBreakpointLimit) || anthropicBoundary) &&
    !hasProviderWireCacheControl(providerOptions)
  ) {
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

/** SDK 对 user/assistant 读取内容块选项，对 system 读取消息选项；两者都保留显式意图。 */
function withOpenAiBreakpoint(message: unknown): unknown {
  if (!isPlainObject(message)) return message
  const options = (existing: unknown) =>
    hasOpenAiBreakpoint(existing)
      ? existing
      : mergeProviderOptionRecord(optionalWhen(isPlainObject, existing), OpenAiProviderKey, {
          promptCacheBreakpoint: { mode: 'explicit' },
        })
  if (message.role === 'system')
    return { ...message, providerOptions: options(message.providerOptions) }
  if (!isArray(message.content)) return message
  const index = message.content.reduce<number>(
    (last, part, i) => (isPlainObject(part) && part.type === 'text' ? i : last),
    -1
  )
  if (index < 0) return message
  return {
    ...message,
    content: message.content.map((part, i) =>
      i === index && isPlainObject(part)
        ? { ...part, providerOptions: options(part.providerOptions) }
        : part
    ),
  }
}

/** 已有断点或没有文本落点的消息不再消耗自动选择余量。 */
function canAddOpenAiBreakpoint(message: LanguageModelV3CallOptions['prompt'][number]): boolean {
  if (message.role === 'system') return !hasOpenAiBreakpoint(message.providerOptions)
  if (!isArray(message.content)) return false
  for (let index = message.content.length - 1; index >= 0; index--) {
    const part = message.content[index]
    if (part?.type === 'text') return !hasOpenAiBreakpoint(part.providerOptions)
  }
  return false
}

/** 原生线路先保留显式落点；不足时让调用方处理，不能交给 SDK 从前向后静默截掉。 */
function selectAnthropicBoundaries(
  options: LanguageModelV3CallOptions,
  wire: PromptCacheWireOptions
): Optional<Set<number>> {
  const limit = wire.anthropicBreakpointLimit
  if (isUndefined(limit)) return undefined
  if (!Number.isSafeInteger(limit) || limit < 1 || wire.openaiBreakpoints)
    throw new AppError('VALIDATION', 'Anthropic 原生缓存断点预算无效或与 OpenAI 线路冲突。')
  // 顶层自动缓存也共用原生断点槽，SDK 的块级 validator 不会替它预留。
  const automatic = readAnthropicCacheControl(options.providerOptions, false)
  let existing = Number(!isUndefined(automatic))
  let lastLongBoundary = -1
  const order = anthropicPromptOrder(options.prompt)
  for (const tool of options.tools ?? [])
    if (tool.type === 'function' && !isUndefined(readAnthropicCacheControl(tool.providerOptions)))
      existing++
  for (const [rank, index] of order.entries()) {
    const message = options.prompt[index]!
    const controls = anthropicMessageCacheControls(message)
    existing += controls.length
    if (controls.some(isLongAnthropicCacheControl)) lastLongBoundary = rank
  }
  // 不把内部默认 5m 点插在调用方 1h 点之前，也不擅自升级成更贵的 1h 写入。
  if (isLongAnthropicCacheControl(automatic)) lastLongBoundary = options.prompt.length
  if (existing > limit)
    throw new AppError(
      'LIMIT',
      `调用方声明 ${existing} 个有效 Anthropic 缓存断点，超过本线路 ${limit} 个的预算。`
    )
  const available = limit - existing
  const candidates = order.flatMap((index, rank) => {
    const message = options.prompt[index]!
    return hasProviderPromptCacheBreakpoint(message.providerOptions) &&
      rank >= lastLongBoundary &&
      canAddAnthropicBreakpoint(message)
      ? [index]
      : []
  })
  // 一个槽先保留最新接受前缀；有两个及以上槽则兼顾稳定开头与最新边界。
  return new Set(
    available < 1
      ? []
      : candidates.length <= available
        ? candidates
        : available === 1
          ? candidates.slice(-1)
          : [candidates[0]!, ...candidates.slice(-(available - 1))]
  )
}

/** SDK 提升首个可提升 system 块，其余 system 块在对话中保留；TTL 判断跟随实际前缀序。 */
function anthropicPromptOrder(prompt: LanguageModelV3CallOptions['prompt']): number[] {
  const system = new Set<number>()
  let hoisted = false
  for (let index = 0; index < prompt.length; index++) {
    if (prompt[index]?.role !== 'system') continue
    const start = index
    let changes = false
    while (index < prompt.length && prompt[index]?.role === 'system') {
      const options = prompt[index]?.providerOptions?.[AnthropicProviderKey]
      changes ||=
        isPlainObject(options) && isArray(options.toolChanges) && !isEmpty(options.toolChanges)
      index++
    }
    if (start === 0 || (!hoisted && !changes)) {
      for (let current = start; current < index; current++) system.add(current)
      hoisted = true
    }
    index--
  }
  return [...system, ...prompt.flatMap((_, index) => (system.has(index) ? [] : [index]))]
}

/** SDK 对同一块按 part、tool output、最后块 message 依次取值，只计算实际有效落点。 */
function anthropicMessageCacheControls(
  message: LanguageModelV3CallOptions['prompt'][number]
): unknown[] {
  const messageControl = readAnthropicCacheControl(message.providerOptions)
  if (message.role === 'system') {
    if (!isUndefined(messageControl) && !message.content.trim()) invalidAnthropicBreakpoint()
    return isUndefined(messageControl) ? [] : [messageControl]
  }
  if (!isUndefined(messageControl) && isEmpty(message.content)) invalidAnthropicBreakpoint()
  const controls: unknown[] = []
  for (const [index, part] of message.content.entries()) {
    const control =
      readAnthropicCacheControl(part.providerOptions) ??
      (message.role === 'tool' && part.type === 'tool-result'
        ? readAnthropicOutputCacheControl(part.output)
        : undefined) ??
      (index === message.content.length - 1 ? messageControl : undefined)
    if (isUndefined(control)) continue
    if (!canCacheAnthropicPart(message.role, part)) invalidAnthropicBreakpoint()
    controls.push(control)
  }
  return controls
}

/** 内部标记只补到可缓存末块；已有 part/output/message 显式落点的不再重复占槽。 */
function canAddAnthropicBreakpoint(message: LanguageModelV3CallOptions['prompt'][number]): boolean {
  if (message.role === 'system')
    return (
      Boolean(message.content.trim()) &&
      isUndefined(readAnthropicCacheControl(message.providerOptions))
    )
  const last = message.content.at(-1)
  return (
    Boolean(last) &&
    canCacheAnthropicPart(message.role, last) &&
    isUndefined(readAnthropicCacheControl(last?.providerOptions)) &&
    !(
      message.role === 'tool' &&
      last?.type === 'tool-result' &&
      !isUndefined(readAnthropicOutputCacheControl(last.output))
    ) &&
    isUndefined(readAnthropicCacheControl(message.providerOptions))
  )
}

/** 与原生块合同一致：思考、批准回执和 assistant 文件没有直接缓存落点。 */
function canCacheAnthropicPart(role: string, part: unknown): boolean {
  if (!isPlainObject(part)) return false
  if (part.type === 'text') return isNonBlankString(part.text)
  if (part.type === 'file')
    return (
      role === 'user' &&
      isString(part.mediaType) &&
      (part.mediaType.startsWith('image/') ||
        ['application/pdf', 'text/plain'].includes(part.mediaType))
    )
  return part.type === 'tool-call' || part.type === 'tool-result'
}

/** SDK 对工具结果使用直接 output 选项，否则取 content 内第一处选项。 */
function readAnthropicOutputCacheControl(output: unknown): unknown {
  if (!isPlainObject(output)) return undefined
  if ('providerOptions' in output) return readAnthropicCacheControl(output.providerOptions)
  if (output.type !== 'content' || !isArray(output.value)) return undefined
  const part = output.value.find(
    (value) => isPlainObject(value) && isPresent(value.providerOptions)
  )
  return isPlainObject(part) ? readAnthropicCacheControl(part.providerOptions) : undefined
}

/** Anthropic SDK 同时接受 camelCase 与 snake_case，显式 false/null 按未设置处理。 */
function readAnthropicCacheControl(providerOptions: unknown, aliases = true): unknown {
  if (!isPlainObject(providerOptions)) return undefined
  const anthropic = providerOptions[AnthropicProviderKey]
  if (!isPlainObject(anthropic)) return undefined
  const value = anthropic[CacheControlField] ?? (aliases ? anthropic.cache_control : undefined)
  return value || undefined
}

/** TTL 为调用方选择；内部默认 5m 点必须位于已有 1h 点之后。 */
function isLongAnthropicCacheControl(control: unknown): boolean {
  return isPlainObject(control) && control.ttl === '1h'
}

/** 显式意图没有原生落点时在发请求前报告，避免 SDK 只给警告后丢弃。 */
function invalidAnthropicBreakpoint(): never {
  throw new AppError('VALIDATION', '调用方的 Anthropic 显式缓存断点没有可缓存内容块落点。')
}

/** 内容块上的 OpenAI 显式断点已经由调用方决定，本层不覆盖。 */
function hasOpenAiBreakpoint(providerOptions: unknown): boolean {
  if (!isPlainObject(providerOptions)) return false
  const openai = providerOptions[OpenAiProviderKey]
  return isPlainObject(openai) && isPresent(openai.promptCacheBreakpoint)
}

/** 这条消息上有没有断点：内部标记或已经写好的线上字段都算。 */
function hasProviderPromptCacheBreakpoint(providerOptions: unknown): boolean {
  if (!isPlainObject(providerOptions)) return false

  const velarosOptions = providerOptions[VelarosProviderOptionsKey]
  if (isPlainObject(velarosOptions) && isTrue(velarosOptions[PromptCacheBreakpointKey])) return true

  return hasProviderWireCacheControl(providerOptions)
}

/** 调用方是不是已经自己写了 `anthropic.cacheControl`。 */
function hasProviderWireCacheControl(providerOptions: unknown): boolean {
  if (!isPlainObject(providerOptions)) return false

  return !isUndefined(readAnthropicCacheControl(providerOptions))
}

/** 调用方是不是已经自己写了 `openai.promptCacheKey`。 */
function hasExplicitProviderPromptCacheKey(providerOptions: unknown): boolean {
  if (!isPlainObject(providerOptions)) return false

  const providerWireOptions = providerOptions[OpenAiProviderKey]
  if (!isPlainObject(providerWireOptions)) return isPresent(providerWireOptions)

  const promptCacheKey = providerWireOptions[PromptCacheKeyField]
  return isString(promptCacheKey) && !isEmpty(promptCacheKey.trim())
}

/** 读出 velaros 命名空间里的会话缓存键；空白值按缺席处理。 */
function readVelarosPromptCacheKey(
  providerOptions: Record<string, unknown>
): LooseOptional<string> {
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
function omitRecordKey(
  record: Record<string, unknown>,
  omittedKey: string
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== omittedKey))
}
