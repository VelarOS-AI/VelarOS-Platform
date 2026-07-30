/**
 * provider 消息扫描：一次遍历收集工具名/工具调用 id/工具结果 id/折叠句柄计数，
 * 供 Ring 0 出核地板（指纹）与诊断复用。红队铁律——共享 scratch 只扫一次，
 * 禁止每 stage 重复全量扫描（性能悬崖）。
 */
import type { ModelMessage } from 'ai'

import { isArray, isObject, isString } from '@velaros-ai/core'
import { logRuntime } from '@velaros-ai/core/logger'
import { isRecord, readString } from '@velaros-ai/core/utils/unknownJsonRecord'

import { compareStableStrings } from '../residency/determinism'

const log = logRuntime.tag('ProviderRequestMessageScan')

/** 单次扫描的中间结果：工具引用面 + 折叠句柄计数，作为共享 scratch 的扫描位。 */
export interface ToolReferenceScan {
  toolNames: Set<string>
  toolCallIds: Set<string>
  toolResultIds: Set<string>
  contextRefCount: number
}

/** 累加非负数（负值截 0），指纹与预算的 toolSchemaChars 汇总共用。 */
export function sumPositive(values: Iterable<number>): number {
  let total = 0

  for (const value of values) {
    total += Math.max(0, value)
  }

  return total
}

/**
 * 去重去空 + trim + **码元序**排序，稳定指纹里的工具名/调用 id 序列。
 *
 * P7-2：原实现用 `localeCompare`，排序结果随 ICU 数据与 locale 变化 —— 同一份请求在两台机器上
 * 会算出不同指纹，缓存命中判定与金标轨迹比对同时失真。
 */
export function sortedStrings(values: Iterable<string>): string[] {
  return [...new Set([...values].filter((value) => value.trim()).map((value) => value.trim()))].sort(
    compareStableStrings
  )
}

/**
 * 消息片段字符串叶子的**保真**读取：string 原样返回（不 trim、空白也保留），非 string → null。
 * 不 trim 是域语义——工具输出/消息正文内容不许被读取路径篡改；
 * 与 core `readString`（trim + 空白归 null，适合 id/名字类字段）互补，勿混用。
 */
export function readVerbatimString(value: unknown): Nullable<string> {
  return isString(value) ? value : null
}

export function isSerializedContextRefCandidateText(value: string): boolean {
  const trimmed = value.trim()
  // B3:计数纳入旧键代际(先决已证:QueryTurn/StreamTurn 对一切显式 allowTools 强插
  // recall_context,不变量不可能假阳性)。fingerprint.contextRefCount 语义自此变宽。
  if (
    !trimmed.includes('__contextRef') &&
    !trimmed.includes('__kernelRef') &&
    !trimmed.includes('__truncated') &&
    !trimmed.includes('__contextSummary')
  )
    return false

  return trimmed.startsWith('{') || trimmed.startsWith('[')
}

/** 递归统计折叠句柄数量：字符串候选先解析再递归，对象/数组按 own key + 嵌套累加。 */
export function countContextRefs(value: unknown, visited: WeakSet<object> = new WeakSet()): number {
  if (isString(value)) {
    const trimmed = value.trim()
    if (!isSerializedContextRefCandidateText(trimmed)) return 0

    try {
      return countContextRefs(JSON.parse(trimmed), visited)
    } catch (error) {
      log.debug('failed to parse serialized context-ref candidate', { error: String(error) })
      return 0
    }
  }

  if (!isObject(value)) return 0
  if (visited.has(value)) return 0
  visited.add(value)

  if (isArray(value)) return value.reduce<number>((count, item) => count + countContextRefs(item, visited), 0)

  const record = value as Record<string, unknown>
  const ownRef =
    Object.prototype.hasOwnProperty.call(record, '__contextRef') ||
    Object.prototype.hasOwnProperty.call(record, '__kernelRef') ||
    record.__truncated === true ||
    Object.prototype.hasOwnProperty.call(record, '__contextSummary')
      ? 1
      : 0
  return Object.values(record).reduce<number>(
    (count, item) => count + countContextRefs(item, visited),
    ownRef
  )
}

/** 一次遍历 provider 消息，收集工具引用面与折叠句柄计数。 */
export function scanProviderMessages(messages: readonly ModelMessage[]): ToolReferenceScan {
  const scan: ToolReferenceScan = {
    toolNames: new Set(),
    toolCallIds: new Set(),
    toolResultIds: new Set(),
    contextRefCount: 0,
  }

  messages.forEach((message) => {
    scan.contextRefCount += countContextRefs(message.content)
    if (!isArray(message.content)) return

    const content: unknown[] = message.content
    content.forEach((part) => {
      if (!isRecord(part)) return

      if (part.type === 'tool-call') {
        const toolName = readString(part, 'toolName')
        const toolCallId = readString(part, 'toolCallId')
        if (toolName) scan.toolNames.add(toolName)
        if (toolCallId) scan.toolCallIds.add(toolCallId)
        return
      }

      if (part.type !== 'tool-result') return

      const toolName = readString(part, 'toolName')
      const toolCallId = readString(part, 'toolCallId')
      if (toolName) scan.toolNames.add(toolName)
      if (toolCallId) scan.toolResultIds.add(toolCallId)
    })
  })

  return scan
}

/** 收集历史里出现过的工具名（去重排序），供 ProviderTurnRequestHelper 诊断。 */
export function collectProviderRequestHistoryToolNames(
  messages: readonly ModelMessage[]
): string[] {
  return sortedStrings(scanProviderMessages(messages).toolNames)
}
