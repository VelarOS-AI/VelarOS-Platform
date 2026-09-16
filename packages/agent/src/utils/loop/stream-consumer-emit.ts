// 域：流消费过程中「往外发」的三件纯函数——记正文增量、收敛用量遥测、取请求指纹 id。
//
// 它们只读账本、写调用方传进来的 turnState、经调用方传进来的事件面发事件，自己不持状态、不抛错。
// 从 StreamConsumer 里搬出来正是因为用不到 this：留在类里会让人以为它们依赖某份实例状态。
import { isEmpty, isNotNull, isNull, isObject, isPresent, isString, toNullable } from '@velaros-ai/core'

import type { ConsumeAssistantStreamArgs, StreamConsumerEvents, StreamDiagnostics } from '../../types/loop.js'
import type { ProviderTurnRecorder, ProviderTurnUsage } from '../../types/records.js'
import { ChatRuntimeEvents } from '../wire/chat-runtime.js'

/**
 * 从传入的请求指纹里取稳定 id 字符串（`ProviderRequestFingerprint` 的 `id`），供 model span 的
 * `requestFingerprint` 字段（与 context-replays 对齐）。类型是 `unknown`，非对象 / 无 id 返回 null。
 */
export function readRequestFingerprintId(fingerprint: unknown): Nullable<string> {
  if (!isObject(fingerprint)) return null
  const id = (fingerprint as { id?: unknown }).id
  return isString(id) ? id : null
}

/**
 * 一条流收敛时把 usage 记进 turnState 并发一次用量遥测。
 *
 * 次序有讲究：`finishReason` 与请求指纹**先于** usage 门写入——它们与 token 无关，供应方一个 token
 * 都没回报时收敛态也必须带着它们，否则截断事故事后零痕迹。供应方完全没给 usage 就到此为止，
 * 不写 token 字段也不发遥测（发一份全 0 的账比没有账更误导）。
 */
export function emitStreamUsageTelemetry(
  diagnostics: StreamDiagnostics,
  turnState: {
    turn: Nullable<number>
    inputTokens?: LooseOptional<number>
    outputTokens?: LooseOptional<number>
    costUsd?: LooseOptional<number>
    reasoningTokens?: LooseOptional<number>
    cacheReadInputTokens?: LooseOptional<number>
    cacheWriteInputTokens?: LooseOptional<number>
    finishReason?: LooseOptional<string>
    requestFingerprint?: LooseOptional<string>
  },
  args: ConsumeAssistantStreamArgs
): void {
  turnState.finishReason = toNullable(
    diagnostics.finishReasons[0] ?? diagnostics.rawFinishReasons[0]
  )
  turnState.requestFingerprint = readRequestFingerprintId(args.requestFingerprint)

  const hasProviderUsage =
    isNotNull(diagnostics.inputTokens) ||
    isNotNull(diagnostics.outputTokens) ||
    isNotNull(diagnostics.totalTokens) ||
    isNotNull(diagnostics.reasoningTokens) ||
    isNotNull(toNullable(diagnostics.cacheReadInputTokens)) ||
    isNotNull(toNullable(diagnostics.cacheWriteInputTokens)) ||
    isNotNull(diagnostics.costUsd)

  if (!hasProviderUsage) return

  // 真实输入 token 交给上层 turn helper 做 MMU 用量校准；其余字段与它同源同通道回传。
  turnState.inputTokens = diagnostics.inputTokens
  turnState.outputTokens = diagnostics.outputTokens
  turnState.costUsd = diagnostics.costUsd
  turnState.reasoningTokens = diagnostics.reasoningTokens
  turnState.cacheReadInputTokens = toNullable(diagnostics.cacheReadInputTokens)
  turnState.cacheWriteInputTokens = toNullable(diagnostics.cacheWriteInputTokens)
  const usage: ProviderTurnUsage = {}
  if (isPresent(diagnostics.inputTokens)) {
    usage.inputTokens = diagnostics.inputTokens
  }
  if (isPresent(diagnostics.outputTokens)) {
    usage.outputTokens = diagnostics.outputTokens
  }
  if (isPresent(diagnostics.totalTokens)) {
    usage.totalTokens = diagnostics.totalTokens
  }
  args.providerTurnReducer?.apply({
    type: 'usage',
    ...usage,
  })

  args.events.emitRuntime?.(
    ChatRuntimeEvents.usageTelemetry({
      turn: turnState.turn,
      model: args.model,
      inputTokens: diagnostics.inputTokens,
      outputTokens: diagnostics.outputTokens,
      visibleOutputTokens: diagnostics.visibleOutputTokens,
      totalTokens: diagnostics.totalTokens,
      reasoningTokens: diagnostics.reasoningTokens,
      cachedInputTokens: diagnostics.cachedInputTokens,
      cacheReadInputTokens: diagnostics.cacheReadInputTokens,
      cacheWriteInputTokens: diagnostics.cacheWriteInputTokens,
      costUsd: diagnostics.costUsd,
      finishReasons: isEmpty(diagnostics.finishReasons)
        ? undefined
        : [...diagnostics.finishReasons],
      rawFinishReasons: isEmpty(diagnostics.rawFinishReasons)
        ? undefined
        : [...diagnostics.rawFinishReasons],
      source: isNull(diagnostics.costUsd) ? 'provider' : 'gateway-cost',
      confidence: 'high',
    })
  )
}

/**
 * 记一段可见正文增量：追进本轮缓冲、累计到 turnState、写进回合账本、投给事件面。
 * 空串直接返回（不记账也不发事件）。一旦记过，本轮就算「有可见输出」，连接重试从此被禁——
 * 重放会让界面出现重复文字。
 */
export function appendStreamTextDelta(
  text: string,
  turnState: { accumulatedText: string; hasVisibleOutput: boolean },
  events: Pick<StreamConsumerEvents, 'emitTextDelta'>,
  appendCurrentText: (text: string) => void,
  providerTurnReducer?: ProviderTurnRecorder
): void {
  if (!text) return

  appendCurrentText(text)
  turnState.accumulatedText += text
  turnState.hasVisibleOutput = true
  providerTurnReducer?.apply({ type: 'assistant-text-delta', text })
  events.emitTextDelta(text)
}
