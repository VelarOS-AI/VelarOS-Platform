/**
 * 提供方回放前的历史结构清洗；这里不负责压缩。
 *
 * B1 起，工具结果总预算、会话级微压缩和超大用户正文安全阀都迁入上下文治理第二版。预算与降级
 * 统一由驻留账本处理，超大用户正文则由准入层按记录类型处理。
 *
 * 本文件只保留防止会话锁死的结构修复：剥除孤儿工具结果、回填或移除工具调用组、裁剪二进制与
 * 图片、修复非法代理对、剥离提供方私有元数据。该路径必须与压缩策略独立演进。
 */
import type { ModelMessage, ToolCallPart, ToolResultPart } from 'ai'

import { isArray, isBlank, isEmpty, isNonBlankString, isNumber, isPresent, isString,toNullable } from '@velaros-ai/core'
import { isRecord } from '@velaros-ai/core/utils/unknownJsonRecord'

import type { AssistantToolCallNameCandidate, ModelHistorySanitizationResult, ModelMessageSanitizationOptions, ModelMessageSanitizationResult, PositionalToolCallReference, PositionalToolResultReference, ProviderSpecificMetadataCarrier,SanitizeModelHistoryOptions, ToolResultNameReference } from '../../types/history.js'
import {
  compactToolInputForModel,
  deserializeSerializedToolResult,
  ModelToolResultMaxSerializedLength,
  serializeToolResultForModel,
} from '../tools/tool-result-serialization'

const MaxRecentToolResultContentMessagesToKeep = 1

const HistoricalImagePlaceholder =
  '[historical image bytes omitted only from this later provider replay; the image may have been visible in its original turn]'
const HistoricalFilePlaceholder =
  '[historical file bytes omitted only from this later provider replay; the file may have been available in its original turn]'
const HistoricalToolMediaPlaceholder =
  '[historical tool media bytes omitted only from this later provider replay; they may have been visible or audible in the original tool result; use the artifact reference in this tool result instead]'
const InvalidTextSurrogatePattern =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g
const EmptyResponseReplayPrefixes = [
  '模型返回了空响应。',
  '模型服务返回了空内容响应',
  '模型服务返回了成功结束的空内容响应',
  'Model returned an empty response.',
  'The model service returned an empty response',
  'The model service returned a successful but empty response',
]

/** 把任意值序列化成一个只用来做相等性比较的串：序列化不出来（循环引用、BigInt 等）就退回 `String(value)`，`undefined` 归成字符串 `'undefined'`。只服务比较、不产出数据，所以退化路径宁可粗糙也绝不能抛——比较函数一抛，整条清洗链连带崩掉。 */
function stringifyForComparison(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'undefined'
  } catch {
    // arch-guard:silent-catch-ok JSON 序列化兜底参与相等性比较，必须保持轻量。
    return String(value)
  }
}

/**
 * 两个任意结构序列化之后是否完全一致。用来判「这次清洗到底改没改东西」：没改就把原对象原样传下去，
 * 既省掉复制整棵入参树，也让 `changedMessages` 不会虚高（上层是按它决定要不要回写持久历史的）。
 * 注意它按 JSON 文本比，键顺序不同会判为不同——宁可多算一次改动，也不做深比较拖慢每条消息。
 */
function hasSameProviderPayload(left: unknown, right: unknown): boolean {
  return stringifyForComparison(left) === stringifyForComparison(right)
}

/** 把工具入参规成对象形状：本来就是普通对象就原样用，不是（字符串、数组、null…）就裹成 `{ input }`。下游的入参压缩只按字段名认路，裸值直接喂进去会一个字段都读不到。 */
function readToolInputRecord(input: unknown): Record<string, unknown> {
  return isRecord(input) ? input : { input }
}

/**
 * 整个数组恰好是某个前缀原样重复整数次时（`ABCABC` → `ABC`），折回最短的那一份；否则原样返回。
 * 判据故意收得很紧——长度必须整除、且**每一位**都按 `isEqual` 相等才认，宁可漏折也不误折：
 * 误折会把模型真的写了两遍的内容删掉一半。收拾的是流式重连把同一段内容整体重贴进来的情况。
 */
function collapseRepeatedSequence<T>(values: T[], isEqual: (left: T, right: T) => boolean): T[] {
  if (values.length < 2) return values

  for (let length = 1; length <= Math.floor(values.length / 2); length += 1) {
    if (values.length % length !== 0) {
      continue
    }

    let repeated = true
    for (let index = length; index < values.length; index += 1) {
      if (!isEqual(values[index], values[index % length])) {
        repeated = false
        break
      }
    }

    if (repeated) return values.slice(0, length)
  }

  return values
}

/**
 * 判断一段文本是不是「模型返回了空响应」这类**只给人看的占位提示**（对着 `EmptyResponseReplayPrefixes` 的中英文前缀逐个比开头）。
 * 这些句子是本地生成的界面提示，不是模型说过的话；回放时当成助手发言送回去，模型会以为自己上一轮真说过这句，
 * 于是接着道歉或重复解释。为真的消息会被整条判为不可回放。
 */
function isDisplayOnlyEmptyResponseText(text: string): boolean {
  const trimmed = text.trim()
  return EmptyResponseReplayPrefixes.some((prefix) => trimmed.startsWith(prefix))
}

/** 从一个内容片段里取「文字类」正文：`text`/`reasoning` 取 `text` 字段，`thinking` 取 `thinking` 字段，其余形状返回 `null`。把各家供应方对思考与正文的不同叫法收成一个口子，调用方不必到处分支。 */
function readTextLikePart(part: unknown): Nullable<string> {
  if (!isRecord(part)) return null

  const type = part.type
  if ((type === 'text' || type === 'reasoning') && isString(part.text)) return part.text

  if (type === 'thinking' && isString(part.thinking)) return part.thinking

  return null
}

/**
 * **宽松**版工具调用判定：type 是 `tool-call` 或驼峰的 `toolCall`，且 id（`toolCallId` 或 `id`）与名字（`toolName` 或 `name`）
 * 各有一个非空即可。只用在「这条助手消息还有没有实质内容」这类判断上——那里宁可把写法不规范的形状也认成工具调用，
 * 也不能把一条真有调用的消息误判成空壳删掉。
 * 与严格版 `isToolCallPart` 各管各的，**不可互换**：宽松版认下的形状不保证能直接当 `ToolCallPart` 用。
 */
function isToolCallLikePart(part: unknown): boolean {
  return (
    isRecord(part) &&
    (part.type === 'tool-call' || part.type === 'toolCall') &&
    (isNonBlankString(part.toolCallId) || isNonBlankString(part.id)) &&
    (isNonBlankString(part.toolName) || isNonBlankString(part.name))
  )
}

/** **严格**版工具调用判定：普通对象、type 恰为 `tool-call`、`toolCallId` 与 `toolName` 都是非空字符串。只有过它的片段才当作 `ToolCallPart` 去压缩、去配对——这两个字段是供应方给调用与结果认亲的唯一依据，缺一个整轮请求就会被拒。 */
function isToolCallPart(part: unknown): part is ToolCallPart {
  return (
    isRecord(part) &&
    part.type === 'tool-call' &&
    isNonBlankString(part.toolCallId) &&
    isNonBlankString(part.toolName)
  )
}

/** 严格版工具结果判定：type 恰为 `tool-result`，`toolCallId`、`toolName` 非空，且 `output` 必须是对象。`output` 那条不能放松——下游一律按 `{ type, value }` 去读它，是字符串或 null 会当场取不到东西。 */
function isToolResultPart(part: unknown): part is ToolResultPart {
  return (
    isRecord(part) &&
    part.type === 'tool-result' &&
    isNonBlankString(part.toolCallId) &&
    isNonBlankString(part.toolName) &&
    isRecord(part.output)
  )
}

/** 是字符串且去空白后非空就返回去过空白的值，否则 `null`。把「缺席 / 非字符串 / 空串 / 纯空白」四种废值一次收敛成一个 `null`，配对逻辑里就只需判一次空。 */
function readNonBlankString(value: unknown): Nullable<string> {
  if (!isString(value)) return null
  const trimmed = value.trim()
  return trimmed || null
}

/**
 * 从一条 assistant 消息里挑出所有带**非空 `toolCallId`** 的 tool-call，记下它在 content 里的下标、id，
 * 以及可能缺席的 `toolName`（缺就是 `null`）。非 assistant、content 不是数组，一律返回空数组。
 * 服务于「按结果回填缺失的工具名」：id 都空了的那些不在这里管，归 `repairBlankToolCallIdsByAdjacentResults`。
 */
function readAssistantToolCallNameCandidates(
  message: ModelMessage
): AssistantToolCallNameCandidate[] {
  if (message.role !== 'assistant' || !isArray(message.content)) return []

  const candidates: AssistantToolCallNameCandidate[] = []
  message.content.forEach((part, partIndex) => {
    if (!isRecord(part)) return

    const record = part as Record<string, unknown>
    if (record.type !== 'tool-call') return

    const toolCallId = readNonBlankString(record.toolCallId)
    if (!toolCallId) return

    candidates.push({
      partIndex,
      toolCallId,
      toolName: readNonBlankString(record.toolName),
    })
  })

  return candidates
}

/** 从一条 tool 消息里收集 `(toolCallId, toolName)` 对，两者任一为空的直接跳过。只有 id 与名字都齐的结果才有资格当回填工具名的来源——拿一个自己都缺名字的结果去补别人，等于把错误搬了个家。 */
function readToolResultNameReferences(message: ModelMessage): ToolResultNameReference[] {
  if (message.role !== 'tool' || !isArray(message.content)) return []

  const references: ToolResultNameReference[] = []
  message.content.forEach((part) => {
    if (!isRecord(part)) return

    const record = part as Record<string, unknown>
    if (record.type !== 'tool-result') return

    const toolCallId = readNonBlankString(record.toolCallId)
    const toolName = readNonBlankString(record.toolName)
    if (!toolCallId || !toolName) return

    references.push({ toolCallId, toolName })
  })

  return references
}

/**
 * 列出一条 assistant 消息里**全部** tool-call 的位置（消息下标 + 片段下标）与可能为空的 id / 名字。
 * 与 `readAssistantToolCallNameCandidates` 的关键差别：**这里不过滤空 id**——它服务的正是
 * 「id 丢了、只能靠位置把调用与结果配回来」那条修复路，先滤掉空 id 就没得修了。
 */
function readPositionalAssistantToolCalls(
  message: ModelMessage,
  messageIndex: number
): PositionalToolCallReference[] {
  if (message.role !== 'assistant' || !isArray(message.content)) return []

  const references: PositionalToolCallReference[] = []
  message.content.forEach((part, partIndex) => {
    if (!isRecord(part)) return

    const record = part as Record<string, unknown>
    if (record.type !== 'tool-call') return

    references.push({
      messageIndex,
      partIndex,
      toolCallId: readNonBlankString(record.toolCallId),
      toolName: readNonBlankString(record.toolName),
    })
  })

  return references
}

/** tool 消息一侧的同款：列出全部 tool-result 的位置与可能为空的 id / 名字，同样**不过滤空 id**，供按位置配对修复使用。 */
function readPositionalToolResults(
  message: ModelMessage,
  messageIndex: number
): PositionalToolResultReference[] {
  if (message.role !== 'tool' || !isArray(message.content)) return []

  const references: PositionalToolResultReference[] = []
  message.content.forEach((part, partIndex) => {
    if (!isRecord(part)) return

    const record = part as Record<string, unknown>
    if (record.type !== 'tool-result') return

    references.push({
      messageIndex,
      partIndex,
      toolCallId: readNonBlankString(record.toolCallId),
      toolName: readNonBlankString(record.toolName),
    })
  })

  return references
}

/**
 * 从某条 assistant 之后**连续**的 tool 消息里按序收齐所有 tool-result 的位置，遇到第一条非 tool 消息立刻停。
 * 「连续」是硬条件：工具结果必须紧跟着产生它的调用组，跨过一条 user/assistant 再往后认亲，
 * 会把上一轮的调用和下一轮的结果配成一对，而这种错配供应方看不出来，模型会照着错结果继续往下做。
 */
function collectFollowingPositionalToolResults(
  history: readonly ModelMessage[],
  assistantIndex: number
): PositionalToolResultReference[] {
  const references: PositionalToolResultReference[] = []
  for (let index = assistantIndex + 1; index < history.length; index += 1) {
    const message = history[index]!
    if (message.role !== 'tool') break

    references.push(...readPositionalToolResults(message, index))
  }

  return references
}

/** 扫全历史，把 tool-call 与 tool-result 上所有非空 `toolCallId` 收成一个集合。给合成 id 查重用——新造的 id 只要与历史里任何一个撞上，供应方就会把两次不同的调用当成同一次。 */
function collectUsedToolCallIds(history: readonly ModelMessage[]): Set<string> {
  const used = new Set<string>()
  for (const message of history) {
    if (!isArray(message.content)) continue

    for (const part of message.content) {
      if (!isRecord(part)) continue
      const record = part as Record<string, unknown>
      if (record.type !== 'tool-call' && record.type !== 'tool-result') continue

      const toolCallId = readNonBlankString(record.toolCallId)
      if (toolCallId) used.add(toolCallId)
    }
  }

  return used
}

/** 造一个历史里没出现过的合成 id（`synthetic-history-tool-<消息下标>-<调用序号>`，撞了就续 `-1`、`-2`…），并**当场登记进 used 集合**，好让同一轮里接连造出的几个也不会互相撞。 */
function allocateSyntheticHistoryToolCallId(
  usedToolCallIds: Set<string>,
  assistantIndex: number,
  callIndex: number
): string {
  let suffix = 0
  let candidate = `synthetic-history-tool-${assistantIndex}-${callIndex}`
  while (usedToolCallIds.has(candidate)) {
    suffix += 1
    candidate = `synthetic-history-tool-${assistantIndex}-${callIndex}-${suffix}`
  }
  usedToolCallIds.add(candidate)
  return candidate
}

/**
 * 一对「调用 / 结果」能否按位置配对补 id 的判据：**两边的 id 必须都是空的**，且调用侧 `toolName` 非空并与结果侧完全相同。
 * 任一侧还留着 id 就说明这不是「双方都丢了 id」那种损坏，硬配会张冠李戴；名字对得上，才敢认这两个是同一次调用。
 */
function canRepairBlankToolCallIdPair(
  call: PositionalToolCallReference,
  result: PositionalToolResultReference
): boolean {
  if (call.toolCallId || result.toolCallId) return false
  return !!call.toolName && call.toolName === result.toolName
}

/** 返回一条新消息，只把指定下标那个片段的 `toolCallId` 换成给定值，其余原样（content 不是数组时原样返回原消息）。**不就地改**——历史消息是共享对象，原地写会顺带污染别处引用的同一份。 */
function rewriteToolPartId(
  message: ModelMessage,
  partIndex: number,
  toolCallId: string
): ModelMessage {
  if (!isArray(message.content)) return message

  const content = message.content.map((part, index) => {
    if (index !== partIndex || !isRecord(part)) return part
    return { ...part, toolCallId }
  })

  return {
    ...message,
    content: content as ModelMessage['content'],
  } as ModelMessage
}

/**
 * 修「tool-call 与对应 tool-result 的 `toolCallId` 双双丢空」这种损坏：对每条含空 id 调用的 assistant 消息，
 * 取其后连续 tool 消息里的全部结果，**只有两边数量完全相等**时才按位置一一配对，逐对再过
 * `canRepairBlankToolCallIdPair`，通过就给调用与结果写上同一个新造的合成 id。
 * 数量对不上就整条跳过——宁可不修，也不猜哪个结果对哪个调用。
 * 修回 id 是为了保住这组调用：缺 id 的工具片段既无法与结果配对，也会被供应方直接判非法，最终只能整片丢掉，
 * 模型就看不见自己上一轮调过什么工具、得到过什么。
 */
function repairBlankToolCallIdsByAdjacentResults(
  history: ModelMessage[]
): ModelHistorySanitizationResult {
  let nextHistory: Nullable<ModelMessage[]> = null
  const changedMessageIndexes = new Set<number>()
  const usedToolCallIds = collectUsedToolCallIds(history)

  history.forEach((message, messageIndex) => {
    const calls = readPositionalAssistantToolCalls(message, messageIndex)
    if (isEmpty(calls) || calls.every((call) => !!call.toolCallId)) return

    const results = collectFollowingPositionalToolResults(history, messageIndex)
    if (calls.length !== results.length) return

    calls.forEach((call, callIndex) => {
      const result = results[callIndex]
      if (!result || !canRepairBlankToolCallIdPair(call, result)) return

      const syntheticId = allocateSyntheticHistoryToolCallId(
        usedToolCallIds,
        messageIndex,
        callIndex
      )
      nextHistory ??= history.slice()
      nextHistory[call.messageIndex] = rewriteToolPartId(
        nextHistory[call.messageIndex]!,
        call.partIndex,
        syntheticId
      )
      nextHistory[result.messageIndex] = rewriteToolPartId(
        nextHistory[result.messageIndex]!,
        result.partIndex,
        syntheticId
      )
      changedMessageIndexes.add(call.messageIndex)
      changedMessageIndexes.add(result.messageIndex)
    })
  })

  return {
    history: nextHistory ?? history,
    changedMessages: changedMessageIndexes.size,
  }
}

/** 与 `collectFollowingPositionalToolResults` 同一套「只认紧随其后的连续 tool 消息」规则，但收的是 `(toolCallId, toolName)` 对而不是位置；同样遇到第一条非 tool 消息就停。 */
function collectFollowingToolResultNameReferences(
  history: readonly ModelMessage[],
  assistantIndex: number
): ToolResultNameReference[] {
  const references: ToolResultNameReference[] = []
  for (let index = assistantIndex + 1; index < history.length; index += 1) {
    const message = history[index]!
    if (message.role !== 'tool') break

    references.push(...readToolResultNameReferences(message))
  }

  return references
}

/**
 * 这批调用的 id 是否**既都非空、又两两不同**（有一个空的或有重复即为假；空列表也为假）。
 * 它决定回填工具名走哪条路：为真才敢按 id 去结果里查表，为假就只能退回「第 n 个调用配第 n 个结果」的位置对应。
 * id 有重复时按 id 查表会把同一个名字灌给两次不同的调用，所以这里必须连重复也一并排除。
 */
function hasDistinctNonEmptyToolCallIds(
  calls: readonly AssistantToolCallNameCandidate[]
): boolean {
  const seen = new Set<string>()
  for (const call of calls) {
    if (!call.toolCallId || seen.has(call.toolCallId)) return false
    seen.add(call.toolCallId)
  }

  return seen.size > 0
}

/**
 * 助手消息里的 tool-call 缺 `toolName` 时，从其后连续 tool 消息的结果里把名字补回来：
 * id 都干净（`hasDistinctNonEmptyToolCallIds`）就按 id 查表，否则按位置取第 n 个结果的名字；
 * 查不到就原样留着不硬编。一条都没补上就返回**原数组**，不复制。
 * 要补是因为缺 `toolName` 的 tool-call 会被供应方直接拒（这个字段在流中断或历史被别的层改写后确实会丢），
 * 而名字在紧随其后的结果里本来就有一份，从那里取回来比把整组调用删掉划算得多。
 */
function backfillAssistantToolCallNamesFromResults(
  history: ModelMessage[]
): ModelHistorySanitizationResult {
  let changedMessages = 0
  const nextHistory = history.map((message, messageIndex) => {
    const calls = readAssistantToolCallNameCandidates(message)
    if (isEmpty(calls) || calls.every((call) => !!call.toolName)) return message

    const references = collectFollowingToolResultNameReferences(history, messageIndex)
    if (isEmpty(references) || !isArray(message.content)) return message

    const useIdLookup = hasDistinctNonEmptyToolCallIds(calls)
    const resultNameById = new Map<string, string>()
    references.forEach((reference) => {
      if (!resultNameById.has(reference.toolCallId)) {
        resultNameById.set(reference.toolCallId, reference.toolName)
      }
    })

    let changed = false
    const nextContent = message.content.map((part, partIndex) => {
      const callIndex = calls.findIndex((call) => call.partIndex === partIndex)
      if (callIndex < 0) return part

      const call = calls[callIndex]
      if (call.toolName) return part

      const toolName = useIdLookup
        ? resultNameById.get(call.toolCallId)
        : references[callIndex]?.toolName
      if (!toolName) return part

      changed = true
      return { ...part, toolName }
    })

    if (!changed) return message

    changedMessages += 1
    return {
      ...message,
      content: nextContent as ModelMessage['content'],
    } as ModelMessage
  })

  return {
    history: changedMessages > 0 ? nextHistory : history,
    changedMessages,
  }
}

/**
 * 从一个对象上摘掉 `providerMetadata` 与 `callProviderMetadata` 两个键，返回新对象；两个键一个都没有时
 * 原样返回并报 `changed: false`（避免为没改的对象白复制一遍）。
 * 判在不在用的是 `hasOwnProperty`，所以显式写着 `undefined` 的键也算「有」，照样摘——留着一个值为 undefined 的键，
 * 序列化后仍可能落成供应方不认的字段。
 */
function stripProviderSpecificMetadataRecord<T extends object>(record: T): {
  record: T
  changed: boolean
} {
  const hasProviderMetadata = Object.prototype.hasOwnProperty.call(record, 'providerMetadata')
  const hasCallProviderMetadata = Object.prototype.hasOwnProperty.call(
    record,
    'callProviderMetadata'
  )
  if (!hasProviderMetadata && !hasCallProviderMetadata) return { record, changed: false }

  const {
    providerMetadata: _providerMetadata,
    callProviderMetadata: _callProviderMetadata,
    ...next
  } = record as T & ProviderSpecificMetadataCarrier
  return { record: next as T, changed: true }
}

/** 片段是 `reasoning`/`thinking` 且正文非空白时把正文取出来，否则 `null`。用于把带供应方私有签名的思考片段降级成纯文本：正文留住，形状不留。 */
function readProviderSpecificReasoningText(record: Record<string, unknown>): Nullable<string> {
  if (
    record.type === 'reasoning' &&
    isString(record.text) &&
    !isBlank(record.text.trim())
  ) return record.text

  if (
    record.type === 'thinking' &&
    isString(record.thinking) &&
    !isBlank(record.thinking.trim())
  ) return record.thinking

  return null
}

/**
 * 把一条消息洗成「换一家供应方也收得下」的样子：消息本身与每个内容片段都摘掉私有元数据，
 * 思考类片段整体降级成 `{ type: 'text' }` 纯文本。没有任何改动时返回原消息对象。
 * 这是跨供应方回放的前提——在 A 家产生的 `providerMetadata`、尤其带签名的 thinking 块，拿到 B 家就是非法字段
 * （签名还对不上），整轮请求会被拒；降级成文本，推理内容还在，形状的包袱丢掉。
 */
function stripProviderSpecificMetadataFromMessage(
  message: ModelMessage
): ModelMessageSanitizationResult {
  let changed = false
  let nextMessage = message
  const strippedMessage = stripProviderSpecificMetadataRecord(message)
  if (strippedMessage.changed) {
    nextMessage = strippedMessage.record
    changed = true
  }

  if (!isArray(nextMessage.content)) return { message: nextMessage, changed }

  let contentChanged = false
  const nextContent = nextMessage.content.map((part) => {
    if (!isRecord(part)) return part

    const partRecord = part as Record<string, unknown>
    const reasoningText = readProviderSpecificReasoningText(partRecord)
    if (reasoningText) {
      contentChanged = true
      return { type: 'text', text: reasoningText }
    }

    const strippedPart = stripProviderSpecificMetadataRecord(partRecord)
    if (!strippedPart.changed) return part

    contentChanged = true
    return strippedPart.record
  })

  if (!contentChanged) return { message: nextMessage, changed }

  return {
    message: {
      ...nextMessage,
      content: nextContent as ModelMessage['content'],
    } as ModelMessage,
    changed: true,
  }
}

/** 全历史逐条做跨供应方净化并统计改了几条；一条都没改就把**原数组**原样返回。只在 `options.stripProviderSpecificMetadata` 打开时才跑——同一家供应方内回放时，那些元数据（含缓存断点、思考签名）留着才是对的，无差别剥掉反而丢掉能力。 */
function stripProviderSpecificMetadataFromHistory(
  history: ModelMessage[]
): ModelHistorySanitizationResult {
  let changedMessages = 0
  const nextHistory = history.map((message) => {
    const result = stripProviderSpecificMetadataFromMessage(message)
    if (result.changed) {
      changedMessages += 1
    }
    return result.message
  })

  return {
    history: changedMessages > 0 ? nextHistory : history,
    changedMessages,
  }
}

/**
 * 把落单的代理项（有高位没低位、或有低位没高位）替换成 `�`。
 * 这种「半个字符」通常来自流式分片在一个 emoji 中间切断；带着它去编码会产出非法 UTF-8，
 * 请求在本地序列化或供应方侧当场失败，整轮就发不出去。换成替换字符后那个位置显示为乱码——
 * 丢的是一个字符，换回的是这一轮能发出去。
 */
function sanitizeInvalidTextSurrogates(value: string): string {
  return value.replace(InvalidTextSurrogatePattern, '\uFFFD')
}

/**
 * 对任意结构递归修非法代理项：字符串直接换，数组与普通对象逐项递归，其它类型原样。
 * 全程没改动时**返回同一个引用**并报 `changed: false`，只有真改过才重建对象——工具入参可能是一棵很大的树，
 * 无条件重建会让每条历史消息都白复制一遍。
 */
function sanitizeUnknownSurrogates(value: unknown): {
  value: unknown
  changed: boolean
} {
  if (isString(value)) {
    const sanitized = sanitizeInvalidTextSurrogates(value)
    return sanitized === value
      ? { value, changed: false }
      : { value: sanitized, changed: true }
  }

  if (isArray(value)) {
    let changed = false
    const nextValue = value.map((item) => {
      const result = sanitizeUnknownSurrogates(item)
      if (result.changed) {
        changed = true
      }
      return result.value
    })
    return changed
      ? { value: nextValue, changed: true }
      : { value, changed: false }
  }

  if (isRecord(value)) {
    let changed = false
    const entries = Object.entries(value).map(([key, item]) => {
      const result = sanitizeUnknownSurrogates(item)
      if (result.changed) {
        changed = true
      }
      return [key, result.value] as const
    })
    return changed
      ? { value: Object.fromEntries(entries), changed: true }
      : { value, changed: false }
  }

  return { value, changed: false }
}

/** 只修对象上指定的那一个字符串字段：该字段不是字符串、或修完没变化，都返回 `null`；真变了才返回「只换了这一个字段」的新对象。用 `null` 表示「不用换」而不是回传原对象，是让调用方一眼分得清有没有改动，不必再比一次。 */
function sanitizeStringRecordField(
  record: Record<string, unknown>,
  field: string
): Nullable<Record<string, unknown>> {
  const value = record[field]
  if (!isString(value)) return null

  const sanitized = sanitizeInvalidTextSurrogates(value)
  if (sanitized === value) return null

  return { ...record, [field]: sanitized }
}

/** 按片段类型挑出该修的那个字段修非法代理项：`text`/`reasoning` 修 `text`，`thinking` 修 `thinking`，其它类型一概不碰。 */
function sanitizeTextContentPartSurrogates(part: Record<string, unknown>): {
  part: Record<string, unknown>
  changed: boolean
} {
  if (part.type === 'text' || part.type === 'reasoning') {
    const sanitizedPart = sanitizeStringRecordField(part, 'text')
    return sanitizedPart
      ? { part: sanitizedPart, changed: true }
      : { part, changed: false }
  }

  if (part.type === 'thinking') {
    const sanitizedPart = sanitizeStringRecordField(part, 'thinking')
    return sanitizedPart
      ? { part: sanitizedPart, changed: true }
      : { part, changed: false }
  }

  return { part, changed: false }
}

/**
 * 修工具结果 `output` 里的非法代理项，按 output 形状分三路：`text`/`error-text` 修 `value` 这个字符串；
 * `content` 数组只逐项修其中 `type === 'text'` 的片段；其它形状原样不动。
 * 二进制与媒体片段一律不碰——它们的载荷不是文本，按字符替换只会把数据改坏。
 */
function sanitizeToolResultOutputSurrogates(output: unknown): {
  output: unknown
  changed: boolean
} {
  if (!isRecord(output)) return { output, changed: false }

  if ((output.type === 'text' || output.type === 'error-text') && isString(output.value)) {
    const sanitized = sanitizeInvalidTextSurrogates(output.value)
    return sanitized === output.value
      ? { output, changed: false }
      : { output: { ...output, value: sanitized }, changed: true }
  }

  if (output.type !== 'content' || !isArray(output.value)) return { output, changed: false }

  let changed = false
  const nextValue = output.value.map((item) => {
    if (!isRecord(item) || item.type !== 'text') return item

    const sanitizedItem = sanitizeStringRecordField(item, 'text')
    if (!sanitizedItem) return item

    changed = true
    return sanitizedItem
  })

  return changed
    ? { output: { ...output, value: nextValue }, changed: true }
    : { output, changed: false }
}

/** 内容片段修代理项的分派口：`tool-call` 递归修整棵 `input`，`tool-result` 修 `output`，其余交给 `sanitizeTextContentPartSurrogates`。工具入参与结果也必须修——非法代理项藏在参数深处一样会让整个请求编码失败。 */
function sanitizeContentPartSurrogates(part: unknown): {
  part: unknown
  changed: boolean
} {
  if (!isRecord(part)) return { part, changed: false }

  if (part.type === 'tool-call') {
    const sanitizedInput = sanitizeUnknownSurrogates(part.input)
    if (!sanitizedInput.changed) return { part, changed: false }

    return {
      part: {
        ...part,
        input: sanitizedInput.value,
      },
      changed: true,
    }
  }

  if (part.type === 'tool-result') {
    const sanitizedOutput = sanitizeToolResultOutputSurrogates(part.output)
    if (!sanitizedOutput.changed) return { part, changed: false }

    return {
      part: {
        ...part,
        output: sanitizedOutput.output,
      },
      changed: true,
    }
  }

  return sanitizeTextContentPartSurrogates(part)
}

/** 一条消息的代理项修复：content 是字符串就整段修，是数组就逐片段修，其它形状不动；没改动时返回原消息对象。 */
function sanitizeInvalidSurrogatesFromMessage(
  message: ModelMessage
): ModelMessageSanitizationResult {
  if (isString(message.content)) {
    const sanitizedContent = sanitizeInvalidTextSurrogates(message.content)
    return sanitizedContent === message.content
      ? { message, changed: false }
      : { message: { ...message, content: sanitizedContent } as ModelMessage, changed: true }
  }

  if (!isArray(message.content)) return { message, changed: false }

  let changed = false
  const content = message.content.map((part) => {
    const result = sanitizeContentPartSurrogates(part)
    if (result.changed) {
      changed = true
    }
    return result.part
  })

  return changed
    ? { message: { ...message, content: content as ModelMessage['content'] } as ModelMessage, changed: true }
    : { message, changed: false }
}

/** 一个片段算不算「助手确实产出了点什么」：有非空白的文字类正文，或者是（宽松判定下的）工具调用。空白文本、纯元数据片段都不算。 */
function hasEffectiveAssistantPart(part: unknown): boolean {
  const text = readTextLikePart(part)
  if (isNonBlankString(text)) return true

  return isToolCallLikePart(part)
}

/** 整条 content 是否**每一个**片段都是文字类（text/reasoning/thinking）。只有为真时才允许把它们拼成一整段去比对「空响应」占位提示——夹着工具调用的消息哪怕文字部分长得一样，也绝不能按那条路判掉。 */
function isTextOnlyAssistantContent(content: unknown[]): boolean {
  return content.every((part) => isPresent(readTextLikePart(part)))
}

/** 把文字类片段的正文按原顺序用换行拼成一整段（非文字片段被 `readTextLikePart` 判成 null 后滤掉）。配合 `isTextOnlyAssistantContent` 使用，单独用会把夹在工具调用之间的零散文字误拼成一段发言。 */
function extractTextOnlyAssistantContent(content: unknown[]): string {
  return content
    .map((part) => readTextLikePart(part))
    .filter((text): text is string => isString(text))
    .join('\n')
}

/**
 * 判定一条 assistant 消息**不能**再回放给供应方。为真的条件（任一）：
 * `stopReason` 是 `error` 或 `aborted`（那一轮没正常收尾，内容是半截的）；content 是空白字符串；content 是空数组；
 * 整条都是文字且拼起来是「模型返回了空响应」这类界面占位提示；没有任何一个片段算实质内容
 * （`hasEffectiveAssistantPart` 全假）。非 assistant 消息一律为假。
 *
 * 为真的消息由结构自愈整条删掉。留着的代价是双向的：模型会把半截话或本地提示当成自己上一轮的发言接着往下编；
 * 而一条内容为空的 assistant 消息本身就可能被供应方判为非法，整轮请求被拒。
 */
export function isReplayUnsafeAssistantMessage(message: ModelMessage): boolean {
  if (message.role !== 'assistant') return false

  const stopReason = toNullable((message as { stopReason?: unknown }).stopReason)
  if (stopReason === 'error' || stopReason === 'aborted') return true

  const content = message.content
  if (isString(content)) {
    const text = content.trim()
    return !text || isDisplayOnlyEmptyResponseText(text)
  }

  if (!isArray(content) || isEmpty(content)) return true

  if (
    isTextOnlyAssistantContent(content) &&
    isDisplayOnlyEmptyResponseText(extractTextOnlyAssistantContent(content))
  ) return true

  return !content.some((part) => hasEffectiveAssistantPart(part))
}

/** 片段是不是带字节的二进制内容（`image` 或 `file`）——也就是裁剪历史体积时该被换成占位文本的那一类。 */
function isHistoricalBinaryPart(part: unknown): boolean {
  return isRecord(part) && (part.type === 'image' || part.type === 'file')
}

/**
 * 给被裁掉的二进制片段造一条文本占位：`file` 用文件版文案，其余（含 `image`）用图片版。
 * 文案刻意写明「只是这次回放里省略了，它在原来那一轮是可见的」——写成「图片不可用」之类，
 * 模型会以为用户根本没发过图，转头去跟用户要一张他明明已经发过的图。
 */
function buildHistoricalBinaryPlaceholder(part: unknown): { type: 'text'; text: string } {
  const type = isRecord(part) ? part.type : null
  return {
    type: 'text',
    text: type === 'file' ? HistoricalFilePlaceholder : HistoricalImagePlaceholder,
  }
}

/**
 * 把一串 content 里的 image/file 片段换成占位文本，并把**连续相同**的占位折成一条——一次发九张图不会变成九句一模一样的占位。
 * 非二进制片段原样保留，并且会打断折叠：隔了别的内容之后再出现的占位要重新写一条，否则读起来像那段内容之后什么都没附。
 */
function pruneHistoricalBinaryContent(content: unknown[]): {
  content: unknown[]
  changed: boolean
} {
  let changed = false
  const pruned: unknown[] = []
  let previousPlaceholderText: Nullable<string> = null

  content.forEach((part) => {
    if (!isHistoricalBinaryPart(part)) {
      pruned.push(part)
      previousPlaceholderText = null
      return
    }

    changed = true
    const placeholder = buildHistoricalBinaryPlaceholder(part)
    if (previousPlaceholderText !== placeholder.text) {
      pruned.push(placeholder)
      previousPlaceholderText = placeholder.text
    }
  })

  return { content: pruned, changed }
}

/**
 * 全历史范围裁掉用户发过的图片/文件字节，但**刻意留出最近一段窗口**：
 * 先从末尾找最后一条 user 消息当本轮起点，再往前找它之前最后一条 assistant，
 * 只裁这条 assistant **之前**的 user 消息里的二进制。也就是本轮和上一轮的图还留着原件，更早的才换成占位。
 *
 * 这是两头都要的取舍：历史图片每轮都重传会很快把请求撑爆（也把钱烧掉），但把刚发的图也裁掉，
 * 模型就没法回答「这张图里是什么」。找不到 user、或找不到前一条 assistant 时整个不裁——
 * 那说明历史还很短，或者本轮就是第一轮，没有可裁的「更早」。
 */
function pruneHistoricalBinaryPartsForProvider(
  history: ModelMessage[]
): ModelHistorySanitizationResult {
  let currentTurnStart = -1
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.role === 'user') {
      currentTurnStart = index
      break
    }
  }

  if (currentTurnStart < 0) return { history, changedMessages: 0 }

  let lastAssistantBeforeTurn = -1
  for (let index = currentTurnStart - 1; index >= 0; index -= 1) {
    if (history[index]?.role === 'assistant') {
      lastAssistantBeforeTurn = index
      break
    }
  }

  if (lastAssistantBeforeTurn < 0) return { history, changedMessages: 0 }

  let nextHistory: Nullable<ModelMessage[]> = null
  let changedMessages = 0

  for (let index = 0; index < lastAssistantBeforeTurn; index += 1) {
    const message = history[index]
    if (message.role !== 'user' || !isArray(message.content)) {
      continue
    }

    const result = pruneHistoricalBinaryContent(message.content)
    if (!result.changed) {
      continue
    }

    nextHistory ??= history.slice()
    nextHistory[index] = {
      ...message,
      content: result.content as ModelMessage['content'],
    } as ModelMessage
    changedMessages += 1
  }

  return {
    history: nextHistory ?? history,
    changedMessages,
  }
}

/** 工具结果 content 里的片段是不是二进制/媒体类：`image-data`、`media`、`file-data`、`file-url`、`file-id` 五种之一。 */
function isToolResultBinaryContentPart(part: unknown): boolean {
  if (!isRecord(part)) return false

  return (
    part.type === 'image-data' ||
    part.type === 'media' ||
    part.type === 'file-data' ||
    part.type === 'file-url' ||
    part.type === 'file-id'
  )
}

/** 某个工具结果的 `output` 是不是 `type: 'content'` 的数组且其中**至少有一个**二进制/媒体片段。是裁剪的入场判断，只查有没有、不管有几个。 */
function hasToolResultBinaryContent(output: unknown): boolean {
  return (
    isRecord(output) &&
    output.type === 'content' &&
    isArray(output.value) &&
    output.value.some((part) => isToolResultBinaryContentPart(part))
  )
}

/**
 * 裁工具结果里的媒体（截图之类）：先找出所有含二进制片段的 tool-result 的位置，
 * 只保留**最近 `MaxRecentToolResultContentMessagesToKeep` 条消息**里的那些，更早的把二进制片段逐个换成占位文本，
 * 同一片段里的其余非二进制内容照旧保留。含二进制的消息条数没超过阈值时一条都不动。
 *
 * 保留窗口按「消息条数」而不是字节：模型真正要看的只有刚截下来的那张图，
 * 而一张截图动辄上百 KB，历史里攒三五张就能把请求撑爆。占位文案里明说「改用这条工具结果里的 artifact 引用」，
 * 让模型知道原件仍然取得回来，而不是以为截图丢了、转头重截一遍。
 */
function pruneToolResultBinaryContentForProvider(
  history: ModelMessage[]
): ModelHistorySanitizationResult {
  const references: Array<{ messageIndex: number; partIndex: number }> = []

  history.forEach((message, messageIndex) => {
    if (!isArray(message.content)) return

    const content: unknown[] = message.content
    content.forEach((part, partIndex) => {
      if (!isRecord(part) || part.type !== 'tool-result') return

      if (hasToolResultBinaryContent(part.output)) {
        references.push({ messageIndex, partIndex })
      }
    })
  })

  const messageIndexes = [...new Set(references.map((reference) => reference.messageIndex))]
  if (messageIndexes.length <= MaxRecentToolResultContentMessagesToKeep)
    return { history, changedMessages: 0 }

  const recentMessageIndexes = messageIndexes.slice(-MaxRecentToolResultContentMessagesToKeep)
  const protectedMessageIndexes = new Set(recentMessageIndexes)
  const protectedKeys = new Set(
    references
      .filter((reference) => protectedMessageIndexes.has(reference.messageIndex))
      .map((reference) => `${reference.messageIndex}:${reference.partIndex}`)
  )
  let changedMessages = 0
  const nextHistory = history.map((message, messageIndex) => {
    if (!isArray(message.content)) return message

    let changed = false
    const content: unknown[] = message.content
    const nextContent = content.map((part, partIndex) => {
      const key = `${messageIndex}:${partIndex}`
      if (protectedKeys.has(key) || !isRecord(part) || part.type !== 'tool-result') return part

      const output = part.output
      if (!hasToolResultBinaryContent(output) || !isRecord(output) || !isArray(output.value)) return part

      changed = true
      return {
        ...part,
        output: {
          ...output,
          value: output.value.map((contentPart) =>
            isToolResultBinaryContentPart(contentPart)
              ? { type: 'text', text: HistoricalToolMediaPlaceholder }
              : contentPart
          ),
        },
      }
    })

    if (!changed) return message

    changedMessages += 1
    return {
      ...message,
      content: nextContent as ModelMessage['content'],
    } as ModelMessage
  })

  return { history: nextHistory, changedMessages }
}

/** 对一个工具调用片段的入参做面向模型的投影压缩（入参先经 `readToolInputRecord` 规成对象，再交给 `compactToolInputForModel`）；压缩前后序列化一致就当没改、返回原片段，避免为没变化的片段白复制一份。 */
function sanitizeToolCallPart(part: ToolCallPart): { part: ToolCallPart; changed: boolean } {
  const input = readToolInputRecord(part.input)
  const compactedInput = compactToolInputForModel(input, part.toolCallId)
  const changed = !hasSameProviderPayload(part.input, compactedInput)

  return {
    part: changed ? { ...part, input: compactedInput } : part,
    changed,
  }
}

/** 工具结果正文超过 `ModelToolResultMaxSerializedLength` 时，把已序列化的正文解回结构再按面向模型的预算重新序列化（该路径会按预算裁剪内容）；没超长就原样返回，一个字都不动。 */
function compactToolResultOutputValue(value: string): string {
  if (value.length <= ModelToolResultMaxSerializedLength) return value

  return serializeToolResultForModel(deserializeSerializedToolResult(value))
}

/** 文本去空白、转小写后以 `error:` 或 `blocked:` 开头即为真——工具失败正文最常见的两种开头。 */
function hasFailureLikeTextPrefix(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return normalized.startsWith('error:') || normalized.startsWith('blocked:')
}

/** 值看着像 JSON（去空白后以 `"` 或 `{` 开头）时才试着解析，解析不了返回 `null`（当普通文本处理）。先看开头再解析，是为了不给每一条工具正文都跑一次 `JSON.parse` —— 这段代码每次发请求都要走遍整份历史。 */
function parseJsonFailureCandidate(value: string): Nullable<unknown> {
  const trimmed = value.trim()
  if (!trimmed.startsWith('"') && !trimmed.startsWith('{')) return null

  try {
    return JSON.parse(trimmed)
  } catch {
    // arch-guard:silent-catch-ok 非法 JSON 工具输出按普通文本处理。
    return null
  }
}

/**
 * 工具结果正文是否是「失败样」的。
 *
 * 失败结果不做正文压缩/折叠——错误原文是模型自纠的唯一线索，压掉它就等于让模型对着
 * 一句"[已折叠]"猜刚才为什么失败。原住 v1 `history/microCompaction.ts`，随该文件拆除迁来。
 */
function isFailureLikeToolResultValue(value: string): boolean {
  if (hasFailureLikeTextPrefix(value)) return true

  const parsed = parseJsonFailureCandidate(value)
  if (isString(parsed)) return hasFailureLikeTextPrefix(parsed)
  if (!isRecord(parsed)) return false

  if (isString(parsed.error) && !isBlank(parsed.error.trim())) return true
  if (!isString(parsed.status)) return false

  const status = parsed.status.trim().toLowerCase()
  return status === 'failed' || status === 'blocked' || status === 'error'
}

/**
 * 工具结果正文的压缩，但先把**不该压的**挑出来放行：`output` 不是对象、类型不是 `text`/`error-text`、
 * `value` 不是字符串，一律原样不动；`error-text` 以及被 `isFailureLikeToolResultValue` 判为失败样的正文
 * **一律整段保留**——错误原文是模型自纠的唯一线索，压掉它等于让模型对着一句摘要猜自己刚才为什么失败。
 * 剩下的才走 `compactToolResultOutputValue`，压完没变化同样按「没改」返回原片段。
 */
function sanitizeToolResultPart(part: ToolResultPart): {
  part: ToolResultPart
  changed: boolean
} {
  const output = part.output
  if (!isRecord(output)) return { part, changed: false }

  const outputRecord = output as Record<string, unknown>
  const outputType = outputRecord.type
  const outputValue = outputRecord.value
  if ((outputType !== 'text' && outputType !== 'error-text') || !isString(outputValue)) return { part, changed: false }
  if (outputType === 'error-text' || isFailureLikeToolResultValue(outputValue)) return { part, changed: false }

  const compactedValue = compactToolResultOutputValue(outputValue)
  if (compactedValue === outputValue) return { part, changed: false }

  return {
    part: {
      ...part,
      output: {
        ...outputRecord,
        value: compactedValue,
      },
    } as ToolResultPart,
    changed: true,
  }
}

/**
 * 一条消息 content 数组的清洗主干，四步固定顺序：
 * ① 把 `toolCallId` 或 `toolName` 为空的 tool-call / tool-result **整片丢弃**——走到这一步说明前面的修复没救回来，
 *    这种片段必被供应方判非法，留着就是整轮请求被拒；
 * ② 合法 tool-call 做入参压缩，但 id 在 `options.preserveToolCallInputIds` 里的**原样放行**
 *    （那是本轮正在跑的调用，回放给供应方的入参必须与真实发出的逐字一致，压一下就对不上了）；
 * ③ 合法 tool-result 做正文压缩，`options.skipToolResultBudget` 打开时跳过（结构自愈那条路只管配对结构，不碰长度）；
 * ④ 最后去重（重复文本折叠 + 同 id 工具片段收敛）。
 */
function sanitizeModelContentArray(
  content: unknown[],
  options: ModelMessageSanitizationOptions = {}
): {
  content: unknown[]
  changed: boolean
} {
  let changed = false
  const sanitized = content.flatMap((part) => {
    if (
      isRecord(part) &&
      (part.type === 'tool-call' || part.type === 'tool-result') &&
      (!isNonBlankString(part.toolCallId) || !isNonBlankString(part.toolName))
    ) {
      changed = true
      return []
    }

    if (isToolCallPart(part)) {
      if (options.preserveToolCallInputIds?.has(part.toolCallId)) return [part]
      const result = sanitizeToolCallPart(part)
      changed = changed || result.changed
      return [result.part]
    }

    if (isToolResultPart(part)) {
      if (options.skipToolResultBudget) return [part]
      const result = sanitizeToolResultPart(part)
      changed = changed || result.changed
      return [result.part]
    }

    return [part]
  })

  const deduped = dedupeRepeatedModelContentParts(sanitized)
  changed = changed || deduped.changed

  return { content: deduped.content, changed }
}

/** 算工具片段的去重键：`tool-call:<id>` 或 `tool-result:<id>`；不是工具片段、或 `toolCallId` 不是字符串时返回 `null`（不参与去重）。type 必须进键——同一个 id 的调用和结果是两样东西，合成一个键会让结果把调用盖掉，配对当场断掉。 */
function getToolPartKey(part: unknown): Nullable<string> {
  if (!isRecord(part)) return null

  if (part.type !== 'tool-call' && part.type !== 'tool-result') return null

  return isString(part.toolCallId) ? `${part.type}:${part.toolCallId}` : null
}

/** 是不是 `{ type: 'text', text: string }` 这种普通文本片段（`reasoning`/`thinking` 不算，去重只处理正文）。 */
function isTextPart(part: unknown): part is { type: 'text'; text: string } {
  return isRecord(part) && part.type === 'text' && isString(part.text)
}

/**
 * 只挑出 content 里的文本片段单独看：若它们整体构成某个前缀的整数次重复（`collapseRepeatedSequence`），
 * 就只留下第一份、删掉其余，非文本片段的位置不受影响；文本片段少于两个直接返回。
 * 收拾的是流式重连把同一段回答整体重贴进来的情况——那样模型会读到自己把同一段话说了两三遍，
 * 之后的输出也跟着跑偏。判据严到「整除且逐位相等」，所以真的写了两遍相似内容不会被误删。
 */
function dedupeRepeatedTextParts(content: unknown[]): {
  content: unknown[]
  changed: boolean
} {
  const textPartIndexes = content
    .map((part, index) => (isTextPart(part) ? index : -1))
    .filter((index) => index >= 0)
  if (textPartIndexes.length < 2) return { content, changed: false }

  const textParts = textPartIndexes.map((index) => content[index] as { type: 'text'; text: string })
  const collapsed = collapseRepeatedSequence(textParts, (left, right) => left.text === right.text)
  if (collapsed.length === textParts.length) return { content, changed: false }

  const keptTextIndexes = new Set(textPartIndexes.slice(0, collapsed.length))
  return {
    content: content.filter((part, index) => !isTextPart(part) || keptTextIndexes.has(index)),
    changed: true,
  }
}

/**
 * 按 `getToolPartKey` 给工具片段去重：同一个键再次出现时，**用后来的那条覆盖先前那条，并留在原来的位置**。
 * 覆盖而不是丢弃，是因为后写的通常更完整（流式常先落一个空壳、最终结果后到）；
 * 留在原位，是为了不打乱调用与结果的先后次序——次序一乱，供应方的配对校验就过不去了。
 * 非工具片段一律原样保留。
 */
function dedupeToolParts(content: unknown[]): {
  content: unknown[]
  changed: boolean
} {
  const deduped: unknown[] = []
  const seenIndexes = new Map<string, number>()
  let changed = false

  content.forEach((part) => {
    const toolPartKey = getToolPartKey(part)
    if (!toolPartKey) {
      deduped.push(part)
      return
    }

    const existingIndex = seenIndexes.get(toolPartKey)
    if (isNumber(existingIndex)) {
      deduped[existingIndex] = part
      changed = true
      return
    }

    seenIndexes.set(toolPartKey, deduped.length)
    deduped.push(part)
  })

  return { content: deduped, changed }
}

/** 先折重复文本、再按 id 收敛工具片段，两步串起来；任一步有改动就报 `changed`。顺序固定：先折文本可以让后一步少扫一些片段，反过来则没有这个好处。 */
function dedupeRepeatedModelContentParts(content: unknown[]): {
  content: unknown[]
  changed: boolean
} {
  const textResult = dedupeRepeatedTextParts(content)
  const toolResult = dedupeToolParts(textResult.content)

  return {
    content: toolResult.content,
    changed: textResult.changed || toolResult.changed,
  }
}

/** 单条消息的清洗入口：content 不是数组（纯字符串内容）就原样返回；否则走 `sanitizeModelContentArray`，**只有真有改动才复制出一条新消息**，原对象一个字不动——历史消息是共享的，就地改会波及别处引用的同一条。 */
export function sanitizeModelMessage(
  message: ModelMessage,
  options: ModelMessageSanitizationOptions = {}
): ModelMessageSanitizationResult {
  if (!isArray(message.content)) return { message, changed: false }

  const result = sanitizeModelContentArray(message.content, options)
  if (!result.changed) return { message, changed: false }

  return {
    message: {
      ...message,
      content: result.content as ModelMessage['content'],
    } as ModelMessage,
    changed: true,
  }
}

/**
 * 整份历史的清洗入口，按固定顺序跑完六步并累计改动条数，每一步都吃上一步的产物：
 * ① 裁历史里用户发的图片/文件（保留最近窗口）；② 裁工具结果里的媒体（保留最近若干条）；
 * ③ 逐条清洗 content（丢残缺工具片段、压入参与正文、去重）并修非法代理项；
 * ④ 按相邻结果修空的 `toolCallId`；⑤ 从结果回填缺失的 `toolName`；
 * ⑥ `options.stripProviderSpecificMetadata` 打开时剥供应方私有元数据（跨供应方回放才需要）。
 *
 * 全程零改动时返回**原数组**，调用方靠 `changedMessages` 判断要不要把结果回写进持久历史——
 * 每次发请求都要走一遍整份历史，没变化就不该产生任何复制。
 * 本文件只做结构清洗，不做预算压缩：整体预算与降级归上下文治理第二版的驻留账本。
 */
export function sanitizeModelHistory(
  history: ModelMessage[],
  options?: SanitizeModelHistoryOptions
): ModelHistorySanitizationResult {
  let changedMessages = 0
  const prunedHistory = pruneHistoricalBinaryPartsForProvider(history)
  changedMessages += prunedHistory.changedMessages
  const prunedToolBinaryHistory = pruneToolResultBinaryContentForProvider(prunedHistory.history)
  changedMessages += prunedToolBinaryHistory.changedMessages
  const sanitizedHistory = prunedToolBinaryHistory.history.map((message) => {
    const result = sanitizeModelMessage(message)
    const textResult = sanitizeInvalidSurrogatesFromMessage(result.message)
    if (result.changed || textResult.changed) {
      changedMessages += 1
    }
    return textResult.message
  })

  const repairedBlankToolCallIds = repairBlankToolCallIdsByAdjacentResults(sanitizedHistory)
  changedMessages += repairedBlankToolCallIds.changedMessages

  const backfilledToolCallNames = backfillAssistantToolCallNamesFromResults(
    repairedBlankToolCallIds.history
  )
  changedMessages += backfilledToolCallNames.changedMessages

  let workingHistory = backfilledToolCallNames.history
  if (options?.stripProviderSpecificMetadata) {
    const strippedProviderMetadata = stripProviderSpecificMetadataFromHistory(workingHistory)
    workingHistory = strippedProviderMetadata.history
    changedMessages += strippedProviderMetadata.changedMessages
  }

  return {
    history: changedMessages > 0 ? workingHistory : history,
    changedMessages,
  }
}
export { sanitizeModelHistory as sanitizeModelHistoryForProvider }
export { sanitizeModelMessage as sanitizeModelMessageForProvider }
