import type { ModelMessage } from 'ai'

import {
  isEmpty,
  isPlainObject,
  isPresent,
  isString,
} from '@velaros-ai/core'

import type { AgentModelRequestOptions } from '../../contract/requires.js'
import type { CoreProviderOptions, ModelMessageProviderOptions } from '../../types/loop.js'
import { UnknownGovernanceSessionId } from '../residency/session-key'

const SessionPromptCacheKeyHashSeed = 0x811c9dc5
const SessionPromptCacheKeyHashPrime = 0x01000193
const SessionPromptCacheKeyPrefixMaxChars = 48

const VelarosProviderOptionsKey = 'velaros'
const PromptCacheBreakpointKey = 'promptCacheBreakpoint'
const PromptCacheKeyField = 'promptCacheKey'
const AnthropicProviderKey = 'anthropic'
const OpenAiProviderKey = 'openai'
const CacheControlField = 'cacheControl'

/**
 * 造一条带 prompt-cache 断点的 system 消息：内容原样，`providerOptions` 里挂上
 * `velaros.promptCacheBreakpoint = { type: 'ephemeral' }`。系统提示词是前缀里最稳定的一段，
 * 在它尾部打断点等于把整段 system 划成可复用的缓存前缀。
 */
function createPromptCacheSystemMessage(content: string): ModelMessage {
  return {
    role: 'system',
    content,
    providerOptions: mergePromptCacheBreakpointProviderOptions(undefined),
  }
}

/**
 * 保证整条消息链里**只有最后一条 user 消息**带 prompt-cache 断点：先把其余 user 消息上遗留的旧断点
 * （velaros 的 promptCacheBreakpoint 与 anthropic 的 cacheControl）摘掉，再给最后一条补上；
 * 它自己已经有断点（或已由调用方显式写死 cacheControl）就不动。返回新数组，不改入参。
 * 没有任何 user 消息时原样浅拷贝返回。断点必须随对话尾部前移，否则缓存命中停在旧位置。
 */
function markLatestUserMessagePromptCacheBreakpoint(
  messages: readonly ModelMessage[]
): ModelMessage[] {
  const latestUserIndex = findLatestUserMessageIndex(messages)
  if (latestUserIndex < 0) return [...messages]

  const next = messages.map((message, index) =>
    index === latestUserIndex ? message : removeStaleUserPromptCacheBoundary(message)
  )
  const target = next[latestUserIndex]
  if (!target || hasProviderPromptCacheBreakpoint(target.providerOptions)) return next

  next[latestUserIndex] = {
    ...target,
    providerOptions: mergePromptCacheBreakpointProviderOptions(target.providerOptions),
  }
  return next
}

/**
 * 由会话 id 推出发给供应商的 prompt-cache key，形如 `session-<可读前缀>-<8 位十六进制哈希>`：
 * 非 `[A-Za-z0-9_-]` 字符折成 `-`，掐掉首尾连字符，可读前缀截到 48 字符（截完为空就用 `session`），
 * 哈希算的是**未截断的原 id**，所以前缀撞车也不会让两个会话共用同一个 key。
 * 会话 id 为空或等于 `UnknownGovernanceSessionId` 时返回 undefined——无身份会话共用兜底键，
 * 按它缓存等于把不同会话的前缀串到一起。
 */
function resolveSessionPromptCacheKey(
  sessionId: LooseOptional<string>
): LooseOptional<string> {
  // 无身份会话不发 prompt-cache key：兜底键全局共用，按它缓存等于把不同会话的前缀串到一起。
  // 判据与 `resolveGovernanceSessionKey` 的兜底值同源，不再各写一份字面量。
  const trimmed = sessionId?.trim()
  if (!trimmed || trimmed === UnknownGovernanceSessionId) return undefined

  const replaced = trimmed.replace(/[^A-Za-z0-9_-]+/g, '-')
  let start = 0
  let end = replaced.length
  while (replaced[start] === '-') start += 1
  while (end > start && replaced[end - 1] === '-') end -= 1
  const safePrefix = replaced.slice(start, end).slice(0, SessionPromptCacheKeyPrefixMaxChars)
  const prefix = safePrefix || 'session'
  return `session-${prefix}-${hashPromptCacheKey(trimmed)}`
}

/**
 * 把按会话推出的 prompt-cache key 并进请求级 providerOptions 的 `velaros.promptCacheKey`。
 * 三种情况原样返回不覆盖：会话推不出 key、调用方已在 `openai` 下显式写了 promptCacheKey、
 * 或现有 `velaros` 槽位被占成了非对象（形状不认识就别动，免得把别人的配置搅坏）。
 */
function mergeSessionPromptCacheProviderOptions(
  modelRequestOptions: LooseOptional<AgentModelRequestOptions>,
  sessionId: LooseOptional<string>
): CoreProviderOptions {
  const providerOptions = modelRequestOptions?.providerOptions
  const promptCacheKey = resolveSessionPromptCacheKey(sessionId)
  if (!promptCacheKey || hasExplicitProviderPromptCacheKey(providerOptions))
    return providerOptions

  const velarosOptions = providerOptions?.[VelarosProviderOptionsKey]
  if (isPresent(velarosOptions) && !isPlainObject(velarosOptions))
    return providerOptions

  return {
    ...(providerOptions ?? {}),
    [VelarosProviderOptionsKey]: {
      ...((velarosOptions ?? {}) as Record<string, unknown>),
      [PromptCacheKeyField]: promptCacheKey,
    },
  }
}

/** 从尾往前找第一条 `role === 'user'` 的消息下标；一条都没有返回 -1（调用方必须先判负）。 */
function findLatestUserMessageIndex(messages: readonly ModelMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return index
  }
  return -1
}

/**
 * 摘掉一条 user 消息上遗留的旧缓存断点。非 user 消息、没有 providerOptions、或本来就没有断点时
 * **返回同一个对象引用**（调用方靠这点跳过无谓拷贝）；确有改动才浅拷贝，且清空后的
 * `providerOptions` 是空对象时整个字段 delete 掉，不留空壳影响供应商侧的请求指纹。
 */
function removeStaleUserPromptCacheBoundary(message: ModelMessage): ModelMessage {
  if (message.role !== 'user' || !isPlainObject(message.providerOptions)) return message

  const nextProviderOptions = removePromptCacheBoundaryProviderOptions(message.providerOptions)
  if (nextProviderOptions === message.providerOptions) return message

  const nextMessage = { ...message } as ModelMessage
  if (!isEmpty(Object.keys(nextProviderOptions))) {
    nextMessage.providerOptions = nextProviderOptions as ModelMessageProviderOptions
  } else {
    delete nextMessage.providerOptions
  }
  return nextMessage
}

/**
 * 判断一份 providerOptions 上是否已经存在缓存断点——两种写法认其一即为真：
 * 自家的 `velaros.promptCacheBreakpoint`，或供应商原生的 `anthropic.cacheControl`。
 * 非对象一律为假。为真就别再补断点，避免把调用方显式写的 cacheControl 覆盖掉。
 */
function hasProviderPromptCacheBreakpoint(providerOptions: unknown): boolean {
  if (!isPlainObject(providerOptions)) return false

  const velarosOptions = providerOptions[VelarosProviderOptionsKey]
  if (
    isPlainObject(velarosOptions) &&
    isPresent(velarosOptions[PromptCacheBreakpointKey])
  )
    return true

  const anthropicOptions = providerOptions[AnthropicProviderKey]
  return (
    isPlainObject(anthropicOptions) &&
    isPresent(anthropicOptions[CacheControlField])
  )
}

/**
 * 判断调用方是否已经自己指定了 prompt-cache key：`openai.promptCacheKey` 是非空白字符串即为真。
 * 另有一条保守分支——`openai` 槽位存在但不是对象（形状不认识）也算为真，宁可不注入也不覆盖。
 * 为真时会话级 key 就不再往里并。
 */
function hasExplicitProviderPromptCacheKey(providerOptions: unknown): boolean {
  if (!isPlainObject(providerOptions)) return false

  const openAiOptions = providerOptions[OpenAiProviderKey]
  if (!isPlainObject(openAiOptions)) return isPresent(openAiOptions)

  const promptCacheKey = openAiOptions[PromptCacheKeyField]
  return isString(promptCacheKey) && !isEmpty(promptCacheKey.trim())
}

/**
 * 在一份 providerOptions 上补写 `velaros.promptCacheBreakpoint = { type: 'ephemeral' }`，返回新对象，
 * 其余键原样保留。入参不是对象时从空对象起手；`velaros` 槽位已被占成非对象时原样返回不写入。
 */
function mergePromptCacheBreakpointProviderOptions(
  providerOptions: unknown
): ModelMessageProviderOptions {
  const base = isPlainObject(providerOptions) ? providerOptions : {}
  const velarosOptions = base[VelarosProviderOptionsKey]
  if (isPresent(velarosOptions) && !isPlainObject(velarosOptions))
    return base as ModelMessageProviderOptions

  return {
    ...base,
    [VelarosProviderOptionsKey]: {
      ...((velarosOptions ?? {}) as Record<string, unknown>),
      [PromptCacheBreakpointKey]: { type: 'ephemeral' },
    },
  } as ModelMessageProviderOptions
}

/**
 * 从 providerOptions 里删掉两处缓存断点标记：`velaros.promptCacheBreakpoint` 与
 * `anthropic.cacheControl`。删完哪个供应商槽位空了就把该槽位一起删掉，不留空对象。
 * 两处都不存在时**返回原对象引用**，调用方据此判断「没变过」。
 */
function removePromptCacheBoundaryProviderOptions(
  providerOptions: Record<string, unknown>
): Record<string, unknown> {
  let changed = false
  const next: Record<string, unknown> = { ...providerOptions }

  const velarosOptions = providerOptions[VelarosProviderOptionsKey]
  if (isPlainObject(velarosOptions) && PromptCacheBreakpointKey in velarosOptions) {
    changed = true
    const cleaned = omitRecordKey(velarosOptions, PromptCacheBreakpointKey)
    if (!isEmpty(Object.keys(cleaned))) next[VelarosProviderOptionsKey] = cleaned
    else delete next[VelarosProviderOptionsKey]
  }

  const anthropicOptions = providerOptions[AnthropicProviderKey]
  if (isPlainObject(anthropicOptions) && CacheControlField in anthropicOptions) {
    changed = true
    const cleaned = omitRecordKey(anthropicOptions, CacheControlField)
    if (!isEmpty(Object.keys(cleaned))) next[AnthropicProviderKey] = cleaned
    else delete next[AnthropicProviderKey]
  }

  return changed ? next : providerOptions
}

/** 返回去掉指定键的浅拷贝；原对象不动，键不存在时等于原样复制一份。 */
function omitRecordKey(
  record: Record<string, unknown>,
  omittedKey: string
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== omittedKey))
}

/**
 * 对会话 id 做 FNV-1a 32 位哈希，输出补零到 8 位的十六进制串。只用来给 prompt-cache key 收尾去歧义，
 * 不是加密哈希，也不保证不碰撞；好处是纯同步、无依赖、同一 id 跨进程结果稳定。
 */
function hashPromptCacheKey(value: string): string {
  let hash = SessionPromptCacheKeyHashSeed
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, SessionPromptCacheKeyHashPrime) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export {
  createPromptCacheSystemMessage,
  markLatestUserMessagePromptCacheBreakpoint,
  mergeSessionPromptCacheProviderOptions,
  resolveSessionPromptCacheKey,
}
