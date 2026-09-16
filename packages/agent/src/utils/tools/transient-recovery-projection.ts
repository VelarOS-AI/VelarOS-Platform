import type { ModelMessage } from 'ai'

import { isArray, isFalse, isPlainObject, isString, Log, optionalWhen } from '@velaros-ai/core'

import type { RestoredReusableInputs } from '../../types/tools.js'
import { isContextRefEnvelope } from '../context/context-ref-envelope'

const RecoveryToolNames = new Set(['project:edit', 'project:file', 'project:change'])
const RecoveryKinds = new Set(['project-edit-candidates', 'project-edit-validation'])

function isRecovery(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && isString(value.kind) && RecoveryKinds.has(value.kind)
}

/** 只有项目修改失败回执携带受信任的恢复元数据，源码 JSON 不参与候选扫描。 */
function projectRecovery(value: unknown, archive: boolean, errorOutput: boolean, depth = 0): unknown {
  if (!isPlainObject(value) || depth > 8) return value
  if (isContextRefEnvelope(value) && isString(value.excerpt)) {
    try {
      const decoded = JSON.parse(value.excerpt)
      const projected = projectRecovery(decoded, archive, errorOutput, depth + 1)
      return projected === decoded ? value : { ...value, excerpt: JSON.stringify(projected) }
    } catch { Log.tag('ContextProjection').debug('跳过无法解析或序列化的记录，保持原文与召回入口')

      // 根据真实错误载体或摘要保留的错误头确认失败来源；
      // 无法解析的拼接内容不提供候选，只保留召回入口。
      const failureHeader = /^\s*\{\s*"error"\s*:/u.test(value.excerpt)
      if (errorOutput || failureHeader) {
        const { excerpt: _excerpt, ...envelope } = value
        return { ...envelope, excerptTruncated: true, reason: '工具失败摘录不完整；请召回该次工具回执查看完整详情。' }
      }
      return value
    }
  }
  if (!archive || (!errorOutput && !isString(value.error) && !isFalse(value.ok))) return value
  const receipt = (recovery: Record<string, unknown>) => ({ kind: recovery.kind, status: 'archived', note: '恢复详情已归档；需要时召回该次工具回执。' })
  const details = optionalWhen(isPlainObject, value.details)
  if (details && isRecovery(details.recovery)) return { ...value, details: { ...details, recovery: receipt(details.recovery) } }
  if (isRecovery(value.recovery)) return { ...value, recovery: receipt(value.recovery) }
  return value
}

function projectToolContent(content: unknown, archive: boolean): unknown {
  if (!isArray(content)) return content
  return content.map((part) => {
    if (!isPlainObject(part) || part.type !== 'tool-result' || !RecoveryToolNames.has(String(part.toolName)) || !isPlainObject(part.output)) return part
    const output = part.output
    const errorOutput = output.type === 'error-text' || output.type === 'error-json'
    if ((output.type === 'text' || output.type === 'error-text') && isString(output.value)) {
      try {
        const value = JSON.parse(output.value)
        const projected = projectRecovery(value, archive, errorOutput)
        return projected === value ? part : { ...part, output: { ...output, value: JSON.stringify(projected) } }
      } catch { Log.tag('ContextProjection').debug('跳过无法解析或序列化的记录，保持原文与召回入口')
 return part }
    }
    if (output.type !== 'json' && output.type !== 'error-json') return part
    const projected = projectRecovery(output.value, archive, errorOutput)
    return projected === output.value ? part : { ...part, output: { ...output, value: projected } }
  })
}

function latestDecisionIndex(messages: readonly ModelMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === 'assistant' || messages[index].role === 'user') return index
  }
  return -1
}

/**
 * The next model decision sees each failure's candidates once. Following an assistant/user boundary,
 * only its short receipt remains in provider history; the stored output is untouched and recallable.
 */
export function projectTransientRecoveryHistory(messages: readonly ModelMessage[]): ModelMessage[] {
  const latestDecision = latestDecisionIndex(messages)
  return messages.map((message, index) => message.role === 'tool'
    ? { ...message, content: projectToolContent(message.content, index < latestDecision) as typeof message.content }
    : message)
}

/** 恢复原参数只展示有限体积；更大的输入保持省略形态，模型按省略元数据召回需要的字段。 */
const RestoredInputMaxChars = 32_000

function decodeFailureReceipt(output: Record<string, unknown>): Optional<Record<string, unknown>> {
  let value: unknown = output.value
  if ((output.type === 'text' || output.type === 'error-text') && isString(value)) {
    try { value = JSON.parse(value) } catch { Log.tag('ContextProjection').debug('工具回执不是 JSON，不恢复原参数')
      return undefined }
  }
  if (isContextRefEnvelope(value) && isString(value.excerpt)) {
    try { value = JSON.parse(value.excerpt) } catch { Log.tag('ContextProjection').debug('失败回执摘录不完整，不恢复原参数')
      return undefined }
  }
  return optionalWhen(isPlainObject, value)
}

/** 回执声明了本次调用自己的复用引用且确证未写入，才是可以原地修正的失败。 */
function isReusableFailure(receipt: Record<string, unknown>, toolCallId: string): boolean {
  const reuse = optionalWhen(isPlainObject, receipt.inputReuse)
  return reuse?.reuse === `attempt:${toolCallId}` && receipt.executionOutcome === 'not-applied'
}

function hasHistoryOmissions(input: unknown): boolean {
  return isPlainObject(input) && (Object.hasOwn(input, '__historyInputOmissions') || Object.hasOwn(input, '__historyInputPreview'))
}

export async function restoreReusableInputsForNextDecision(
  messages: readonly ModelMessage[],
  readAttemptInput: (toolCallId: string) => Promise<Optional<Record<string, unknown>>>,
): Promise<RestoredReusableInputs> {
  const unchanged: RestoredReusableInputs = { messages: [...messages], restoredToolCallIds: new Set() }
  const latestDecision = latestDecisionIndex(messages)
  const decision = messages[latestDecision]
  if (decision?.role !== 'assistant' || !isArray(decision.content)) return unchanged
  const failed = new Set<string>()
  for (const message of messages.slice(latestDecision + 1)) {
    if (message.role !== 'tool' || !isArray(message.content)) continue
    for (const part of message.content) {
      if (part.type !== 'tool-result' || !RecoveryToolNames.has(part.toolName)) continue
      const receipt = decodeFailureReceipt(part.output as Record<string, unknown>)
      if (receipt && isReusableFailure(receipt, part.toolCallId)) failed.add(part.toolCallId)
    }
  }
  if (failed.size === 0) return unchanged
  const restored = new Map<string, Record<string, unknown>>()
  for (const toolCallId of failed) {
    try {
      const input = await readAttemptInput(toolCallId)
      if (input && JSON.stringify(input).length <= RestoredInputMaxChars) restored.set(toolCallId, input)
    } catch (error) {
      Log.tag('ContextProjection').debug('读取失败调用的原参数失败，保持省略形态', { error })
    }
  }
  const restoredToolCallIds = new Set<string>()
  const content = decision.content.map((part) => {
    if (part.type !== 'tool-call' || !hasHistoryOmissions(part.input)) return part
    const input = restored.get(part.toolCallId)
    if (!input) return part
    restoredToolCallIds.add(part.toolCallId)
    return { ...part, input: structuredClone(input) }
  })
  if (restoredToolCallIds.size === 0) return unchanged
  return {
    messages: messages.map((message, index) => index === latestDecision ? { ...decision, content } : message),
    restoredToolCallIds,
  }
}
