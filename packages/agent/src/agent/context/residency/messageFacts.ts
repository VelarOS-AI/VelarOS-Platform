/**
 * 模型消息的事实读取（驻留账本的唯一消息解析口）。
 *
 * 存在理由：准入、摄入、投影三处都要问同一批问题——这条消息的正文是什么、带哪些工具调用/结果、
 * 目标资源是谁、多少字符。判定散落三份必然漂移（v1 的教训：同一个"折叠桩"有 8 种皮，各层各写
 * 各的嗅探），故收在此一处。
 *
 * 保真纪律：正文读取**不 trim**（工具输出与消息正文不许被读取路径篡改），沿用
 * `providerRequest/messageScan.readVerbatimString` 的同一口径。
 */
import type { ModelMessage } from 'ai'

import { isArray, isEmpty, isRecord, isString, Log, toNullable } from '@velaros-ai/core'

import { estimateContextValueChars } from '../contextUsage'
import { readVerbatimString } from '../providerRequest/messageScan'
import { readUserMessageText } from '../userMessageText'

const log = Log.tag('ContextResidencyMessageFacts')

export interface ToolCallFact {
  toolCallId: string
  toolName: string
  args: unknown
}

export interface ToolResultFact {
  toolCallId: string
  toolName: string
  /** 结果正文（文本档）；结构化输出为 null。 */
  value: Nullable<string>
  /** 结果正文的保真文本投影：文本档即原文，结构化档退化为稳定 JSON（per-part 摘录的素材）。 */
  text: string
  isError: boolean
}

/** URL 定位符：去 hash（同页锚点不是不同目标），保留 query（`?page=2` 是不同目标）。 */
const UrlPattern = /\bhttps?:\/\/[^\s"'<>)\]}]+/i
/** 路径定位符：绝对路径或带目录分隔的相对路径。 */
const PathPattern = /(?:^|["'\s(])((?:\/|\.{1,2}\/|[A-Za-z]:\\)[^\s"'<>)\]}]+)/

/** 消息正文的保真文本投影（结构化内容退化为稳定 JSON 文本）。 */
export function readMessageText(message: ModelMessage): string {
  if (message.role === 'user') return readUserMessageText(message) ?? ''
  return readContentText(message.content)
}

/** 消息的字符规模：字符串正文按长度，结构化正文按序列化长度。 */
export function estimateMessageChars(message: ModelMessage): number {
  if (isString(message.content)) return message.content.length

  try {
    return JSON.stringify(message.content)?.length ?? 0
  } catch (error) {
    log.warn('消息字符估算序列化失败，回落到文本投影长度', { error: String(error) })
    return readMessageText(message).length
  }
}

/** 附件字节仅作原始元数据；治理字符规模复用发送计量中的附件摘要。 */
export function estimateMessageBudgetChars(message: ModelMessage): number {
  try {
    return estimateContextValueChars(message.content)
  } catch (error) {
    log.warn('消息治理字符估算失败，回落到原始字符规模', { error: String(error) })
    return estimateMessageChars(message)
  }
}

/** 该消息是否携带工具调用片段（assistant 消息的 `tool-call` 结构位）。 */
export function hasToolCallParts(message: ModelMessage): boolean {
  return !isEmpty(readToolCallFacts(message))
}

export function readToolCallFacts(message: ModelMessage): ToolCallFact[] {
  if (message.role !== 'assistant' || !isArray(message.content)) return []

  const facts: ToolCallFact[] = []
  for (const part of message.content as unknown[]) {
    if (!isRecord(part) || part.type !== 'tool-call') continue
    const toolCallId = readVerbatimString(part.toolCallId)
    const toolName = readVerbatimString(part.toolName)
    if (!toolCallId || !toolName) continue
    facts.push({ toolCallId, toolName, args: part.input ?? part.args })
  }

  return facts
}

export function readToolResultFacts(message: ModelMessage): ToolResultFact[] {
  if (message.role !== 'tool' || !isArray(message.content)) return []

  const facts: ToolResultFact[] = []
  for (const part of message.content as unknown[]) {
    if (!isRecord(part) || part.type !== 'tool-result') continue
    const toolCallId = readVerbatimString(part.toolCallId)
    const toolName = readVerbatimString(part.toolName)
    if (!toolCallId || !toolName) continue
    const output = isRecord(part.output) ? part.output : null
    facts.push({
      toolCallId,
      toolName,
      value: output ? readVerbatimString(output.value) : null,
      text: readContentText(part),
      isError: output?.type === 'error-text',
    })
  }

  return facts
}

/**
 * 资源定位符抽取：URL 优先，其次路径。
 *
 * 用途是**语义去重键**的目标位——"同工具同目标的旧快照"里的"目标"。刻意不认工具名单：
 * 具体能力的工具名不属于 agent 包（`StatefulToolResults` 同款教义），结构信号才是本包能拿的。
 */
export function extractResourceLocator(value: unknown): Nullable<string> {
  const text = isString(value) ? value : readContentText(value)
  if (!text.trim()) return null

  const url = UrlPattern.exec(text)
  if (url?.[0]) return normalizeUrlLocator(url[0])

  const path = PathPattern.exec(text)
  return toNullable(path?.[1])
}

function normalizeUrlLocator(raw: string): string {
  const hashIndex = raw.indexOf('#')
  const withoutHash = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw
  let end = withoutHash.length
  while (end > 0 && withoutHash[end - 1] === '/') end -= 1
  return withoutHash.slice(0, end)
}

function readContentText(content: unknown): string {
  if (isString(content)) return content

  if (isArray(content)) return content
      .map((part) => readContentText(part))
      .filter(Boolean)
      .join('\n')

  if (!isRecord(content)) return ''

  const direct = [readVerbatimString(content.text), readVerbatimString(content.value)]
    .filter(Boolean)
    .join('\n')
  if (direct.trim()) return direct

  // tool-result 片段的正文在 `output.value` 里。不解包就会退化成整个 part 的 JSON 转储：
  // 摘录预算被结构包裹与转义吃掉一大截，模型拿到的头尾都是 JSON 碎片而不是工具输出本身，
  // 锚点也变成在转义后的文本上抽（审计 U23）。v1 的句柄化摘录的就是输出正文，这里对齐它。
  if (isRecord(content.output)) {
    const output = readContentText(content.output.value ?? content.output)
    if (output.trim()) return output
  }

  try {
    return JSON.stringify(content) ?? ''
  } catch (error) {
    log.debug('消息片段序列化失败，回落到字符串表示', { error: String(error) })
    return String(content)
  }
}
