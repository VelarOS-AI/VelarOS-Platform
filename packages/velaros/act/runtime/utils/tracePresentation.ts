import {
  isArray,
  isNumber,
  isPlainObject,
  isString,
  optionalWhen,
  toNullable,
} from '@velaros-ai/core'
import type { InvocationRecord } from '@velaros-ai/kernel'

import type { ActInvocationSummary, ActRequestSummary } from '../types/trace.js'

/** 从权威回执生成宿主展示，不解析被裁剪的 JSON，也不推断未结算效果。 */
export function summarizeInvocation(
  record: InvocationRecord,
  maxChars: number,
  fullContent = false
): ActInvocationSummary {
  const input = JSON.stringify(record.prepared.input) ?? ''
  const output = record.receipt
    ? (JSON.stringify(record.receipt.error ?? record.receipt.value) ?? '')
    : ''
  const inputLimit = fullContent ? input.length : Math.min(2000, Math.floor(maxChars / 2))
  const inputText = input.slice(0, inputLimit)
  const outputText = output.slice(
    0,
    fullContent ? output.length : Math.min(6000, maxChars - inputText.length)
  )
  return {
    moduleId: record.prepared.binding.moduleId,
    operation: record.prepared.operation,
    status: record.receipt?.outcome ?? 'pending',
    effect: record.receipt?.effect ?? 'unknown',
    input: inputText,
    output: outputText,
    inputTruncated: inputText.length < input.length,
    outputTruncated: outputText.length < output.length,
  }
}

/** 子任务结果笔记里最后接纳的一段回答；笔记形状不对或没有回答时为空。 */
export function childAnswerText(note: unknown): string {
  if (!isPlainObject(note) || !isArray(note.events)) return ''
  const accepted: unknown = note.events.findLast(
    (event) => isPlainObject(event) && event.type === 'accepted' && isString(event.text)
  )
  return isPlainObject(accepted) && isString(accepted.text) ? accepted.text : ''
}

/** 从完整封存请求提取展示；常规模式按预算采样，宿主全文模式保留完整文本；图片和字节数据使用占位。 */
export function summarizeModelRequest(
  audit: unknown,
  maxChars: number,
  fullContent = false
): Nullable<ActRequestSummary> {
  if (!isPlainObject(audit) || !isPlainObject(audit.providerRequest)) return null
  const request = audit.providerRequest
  if (
    request.schemaVersion !== 2 ||
    !isString(request.model) ||
    !isString(request.system) ||
    !isArray(request.messages) ||
    !isNumber(request.outputTokens) ||
    !Number.isSafeInteger(request.outputTokens) ||
    request.outputTokens < 1 ||
    !isPlainObject(request.requestFingerprint) ||
    !isString(request.requestFingerprint.id)
  )
    return null
  let mediaOmitted = false
  const messages = JSON.stringify(
    request.messages,
    (_key, value) => {
      if (isPlainObject(value) && (value.type === 'image' || value.$velarosType === 'bytes')) {
        mediaOmitted = true
        return { type: 'media-omitted', mediaType: optionalWhen(isString, value.mediaType) }
      }
      return value
    },
    2
  )
  const system = fullContent
    ? request.system
    : request.system.slice(0, Math.min(8000, Math.floor(maxChars / 4)))
  const text = fullContent ? messages : messages.slice(0, Math.min(24000, maxChars - system.length))
  const value = audit.estimate
  const estimate:
    { tokens: number; precision: 'exact' | 'estimate'; basis: Nullable<string> } | undefined =
    isPlainObject(value) &&
    isNumber(value.tokens) &&
    Number.isSafeInteger(value.tokens) &&
    value.tokens >= 0 &&
    (value.precision === 'exact' || value.precision === 'estimate')
      ? {
          tokens: value.tokens,
          precision: value.precision,
          basis: isString(value.basis) ? value.basis : null,
        }
      : undefined
  return {
    model: request.model,
    fingerprint: request.requestFingerprint.id,
    inputTokens: toNullable(estimate?.tokens),
    precision: toNullable(estimate?.precision),
    basis: isString(estimate?.basis) ? estimate.basis : null,
    outputTokens: request.outputTokens,
    system,
    messages: text,
    systemTruncated: system.length < request.system.length,
    messagesTruncated: text.length < messages.length,
    mediaOmitted,
  }
}
