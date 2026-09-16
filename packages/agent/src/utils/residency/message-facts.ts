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

import type { ToolCallFact, ToolResultFact } from '../../types/residency.js'
import { estimateContextValueChars } from '../context/context-usage'
import { readVerbatimString } from '../context/message-scan'
import { readUserMessageText } from '../context/user-message-text'

const log = Log.tag('ContextResidencyMessageFacts')

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

/**
 * 读出这条消息里的全部工具调用事实（toolCallId / toolName / 入参），按片段出现序返回。
 * 只认 assistant 角色 + 数组正文，其余形态返回空数组（不是错，只是这条消息没带调用）。
 * 身份缺一不可：`toolCallId` 或 `toolName` 读不出来的片段整条跳过——半个身份的调用没法配对，留着只会误导后续判定。
 * 入参兼容 `input` 与旧字段 `args` 两种写法。
 */
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

/**
 * 读出这条消息里的全部工具结果事实（身份、原始 value、文本投影、是否报错），按片段出现序返回。
 * 只认 tool 角色 + 数组正文，其余形态返回空数组。身份读不全的片段整条跳过，同 {@link readToolCallFacts}。
 * 一条 tool 消息可以装多份并行结果，所以返回的是数组——账本的 per-part 摘录与 per-part 召回引用都建立在这份清单上。
 * `isError` 只认 `output.type === 'error-text'` 这一个结构信号，不去猜正文里的"失败"字样。
 */
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

/**
 * 把一个 URL 归一成去重用的目标串：去掉 `#` 及其后的片段，再去掉结尾的斜杠。
 * 两处取舍都服务于"这两次调用取的是不是同一份事实"：同页锚点（`#section`）不是不同目标，尾斜杠有无也不是；
 * 但 query 一律保留——`?page=2` 与 `?page=3` 确实是两份不同的内容，合并会把前一页当成过时快照折掉。
 */
function normalizeUrlLocator(raw: string): string {
  const hashIndex = raw.indexOf('#')
  const withoutHash = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw
  let end = withoutHash.length
  while (end > 0 && withoutHash[end - 1] === '/') end -= 1
  return withoutHash.slice(0, end)
}

/**
 * 把任意形态的消息正文递归投影成一段保真文本（**不 trim**，正文不许被读取路径篡改）。
 *
 * 逐级尝试：字符串原样返回 → 数组逐项递归后换行拼接 → 对象先取 `text` / `value` 字段 →
 * 再解包 `output.value`（tool-result 片段的正文藏在这里，不解包就会退化成整个 part 的 JSON 转储，
 * 摘录预算被结构包裹和转义吃掉一大截，模型拿到的头尾全是 JSON 碎片而不是工具输出本身）→
 * 最后才整体 JSON 序列化。序列化也失败时回落 `String(content)` 并记一条 debug，绝不抛错——
 * 读取路径抛错会把整条准入链路打死，而这里只是要一段用于抽锚点与算长度的文本。
 * 拿不到任何文本时返回空串。
 */
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
