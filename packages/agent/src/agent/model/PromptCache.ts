import type { ModelMessage } from 'ai'

import {
  isEmpty,
  isPlainObject,
  isPresent,
  isString,
} from '@velaros-ai/core'

import { UnknownGovernanceSessionId } from '../context/residency/sessionKey'

import type { AgentModelRequestOptions } from './ModelContracts'

const SessionPromptCacheKeyHashSeed = 0x811c9dc5
const SessionPromptCacheKeyHashPrime = 0x01000193
const SessionPromptCacheKeyPrefixMaxChars = 48

const VelarosProviderOptionsKey = 'velaros'
const PromptCacheBreakpointKey = 'promptCacheBreakpoint'
const PromptCacheKeyField = 'promptCacheKey'
const AnthropicProviderKey = 'anthropic'
const OpenAiProviderKey = 'openai'
const CacheControlField = 'cacheControl'

type CoreProviderOptions = AgentModelRequestOptions['providerOptions']
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
  if (!target || hasProviderPromptCacheBreakpoint(target.providerOptions)) return next

  next[latestUserIndex] = {
    ...target,
    providerOptions: mergePromptCacheBreakpointProviderOptions(target.providerOptions),
  }
  return next
}

function resolveSessionPromptCacheKey(
  sessionId: LooseOptional<string>
): LooseOptional<string> {
  // 无身份会话不发 prompt-cache key：兜底键全局共用，按它缓存等于把不同会话的前缀串到一起。
  // 判据与 `resolveGovernanceSessionKey` 的兜底值同源，不再各写一份字面量。
  const trimmed = sessionId?.trim()
  if (!trimmed || trimmed === UnknownGovernanceSessionId) return undefined

  const safePrefix = trimmed
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SessionPromptCacheKeyPrefixMaxChars)
  const prefix = safePrefix || 'session'
  return `session-${prefix}-${hashPromptCacheKey(trimmed)}`
}

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

function findLatestUserMessageIndex(messages: readonly ModelMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return index
  }
  return -1
}

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

function hasExplicitProviderPromptCacheKey(providerOptions: unknown): boolean {
  if (!isPlainObject(providerOptions)) return false

  const openAiOptions = providerOptions[OpenAiProviderKey]
  if (!isPlainObject(openAiOptions)) return isPresent(openAiOptions)

  const promptCacheKey = openAiOptions[PromptCacheKeyField]
  return isString(promptCacheKey) && !isEmpty(promptCacheKey.trim())
}

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

function omitRecordKey(
  record: Record<string, unknown>,
  omittedKey: string
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== omittedKey))
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
  createPromptCacheSystemMessage,
  markLatestUserMessagePromptCacheBreakpoint,
  mergeSessionPromptCacheProviderOptions,
  resolveSessionPromptCacheKey,
}
