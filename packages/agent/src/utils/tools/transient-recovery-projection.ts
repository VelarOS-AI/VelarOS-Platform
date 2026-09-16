import type { ModelMessage } from 'ai'

import { isArray, isFalse, isPlainObject, isString, Log, optionalWhen } from '@velaros-ai/core'

import type { RestoredReusableInputs } from '../../types/tools.js'
import { isContextRefEnvelope } from '../context/context-ref-envelope'

const RecoveryToolNames = new Set(['project:edit'])
const RecoveryKinds = new Set(['project-edit-candidates', 'project-edit-validation'])

/**
 * 该值是否是受信任的恢复元数据块——纯对象且 `kind` 是 `project-edit-candidates` / `project-edit-validation` 之一。
 * 只认这两个 kind：候选扫描必须限定在失败回执自带的结构上，源码 JSON 里恰好有同名字段也不能当恢复数据。
 */
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

/**
 * 遍历一条 tool 消息的内容块，只对 RecoveryToolNames（当前是 `project:edit`）的 tool-result 做恢复元数据投影，其余原样放行。
 * 文本类输出（text / error-text）先 JSON.parse 再投影再序列化回去，parse 或 stringify 失败就保持原文（记一条 debug 日志，不抛）；
 * json / error-json 直接对值投影。投影没改动时返回原对象引用，避免无谓的新对象。
 * `archive` 为真表示这条已经越过了最近一次决策边界，可以把恢复详情折成短回执。
 */
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

/**
 * 从后往前找最近一条 assistant 或 user 消息的下标，没有则返回 -1。
 * 这条就是「最近一次模型决策」的边界：它之前的工具回执算已消化（恢复详情可折叠），它之后的属于当前这轮，必须原样留着。
 */
function latestDecisionIndex(messages: readonly ModelMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === 'assistant' || messages[index].role === 'user') return index
  }
  return -1
}

/**
 * 投影发给 provider 的历史：每次失败的恢复候选只让模型完整看见一轮——
 * 越过 assistant/user 决策边界之后，provider 历史里只留一条短回执（`status: 'archived'` 加一句召回提示）。
 * 只改这份出站投影；归档的工具输出一个字没动，模型需要细节时仍可 context:recall 取回完整回执。
 */
export function projectTransientRecoveryHistory(messages: readonly ModelMessage[]): ModelMessage[] {
  const latestDecision = latestDecisionIndex(messages)
  return messages.map((message, index) => message.role === 'tool'
    ? { ...message, content: projectToolContent(message.content, index < latestDecision) as typeof message.content }
    : message)
}

/** 恢复原参数只展示有限体积；更大的输入保持省略形态，模型按省略元数据召回需要的字段。 */
const RestoredInputMaxChars = 32_000

/**
 * 把一个 tool-result 的 output 解成失败回执对象：文本类输出先 JSON.parse，若外层是 context-ref 信封再 parse 一次它的 excerpt。
 * 任一步 parse 失败或最终不是纯对象就返回 undefined（记 debug 日志，不抛）——解不出回执就当没有可复用的原参数，宁可让模型重填。
 */
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

/**
 * 这份入参在历史里是不是已经被省略过——带 `__historyInputOmissions` 或 `__historyInputPreview` 任一键即为真。
 * 只有被省略过的调用才值得把原参数读回来填充；没省略过的历史入参本来就是完整的，回填反而是多余的改写。
 */
function hasHistoryOmissions(input: unknown): boolean {
  return isPlainObject(input) && (Object.hasOwn(input, '__historyInputOmissions') || Object.hasOwn(input, '__historyInputPreview'))
}

/**
 * 最近一次模型决策里若有「可原地修正」的工具失败，把那几次调用在历史中被省略的入参读回来填回去，
 * 让模型改一处重发即可，而不必凭记忆把整份大参数重写一遍。
 * 判定很窄：只看最近一条 assistant 决策之后的 tool 回执，且回执必须自报 `inputReuse.reuse === 'attempt:<toolCallId>'`
 * 并确证 `executionOutcome === 'not-applied'`（真没写入）——已经产生副作用的失败绝不回填。
 * 回填还有两道闸：原参数序列化后超过 RestoredInputMaxChars 就放弃（保持省略形态，模型按省略元数据自己召回需要的字段）；
 * 读取抛错只记 debug 不中断。没有任何一处成功回填时原样返回入参消息（浅拷），并告知哪些 toolCallId 被回填过。
 */
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
