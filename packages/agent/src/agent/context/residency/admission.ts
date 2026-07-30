/**
 * 准入钩子（上下文治理 v2 · §4A，唯一的**缓存安全**治理点）。
 *
 * 新记录进账本的一瞬间定初始驻留，之后轮与轮之间投影严格只追加 —— 这是 P1/P4 的地基：
 * 准入不改写任何既有记录，所以准入永远不会毁缓存。三条规则：
 *  ① 工具结果超 `admission.inlineMaxChars` → 直接 EXCERPT（头尾摘录 + 召回句柄，语义与今天的
 *     `tool-output-store` 句柄化逐字一致，`recall_context` 继续认）；
 *  ② 同工具同目标的旧快照类记录 → 标 **pending-EVICT**（只标记，真正逐出归 B1 的 epoch。
 *     依据：相似而过时的内容比无关内容更毒）；
 *  ③ 锚点规则抽取立刻做，落记录元数据（后续骨架与锚点验证共用同一份）。
 *
 * 刻意不做的事：不按工具名单分类。具体能力的工具名不属于 agent 包（与 `StatefulToolResults`
 * 同教义），"可重取 / 快照目标"一律走**结构信号 + 注入分类器**两条路。
 */
import type { ModelMessage } from 'ai'

import { isPresent, toNullable, toOptional } from '@velaros-ai/core'

import { buildContextRefEnvelope, type ContextRefEnvelope } from '../contextRefEnvelope'

import { extractContextAnchors } from './anchors'
import {
  type ContextRecord,
  type ContextRecordExcerpt,
  type ContextRecordKind,
  type ContextResidency,
  createContextRecordId,
} from './ContextRecord'
import type { ContextGovernanceConfig } from './governanceConfig'
import { DefaultContextGovernanceConfig } from './governanceConfig'
import {
  estimateMessageChars,
  extractResourceLocator,
  readMessageText,
  readToolCallFacts,
  readToolResultFacts,
} from './messageFacts'
import type { ContextMigrationCause } from './migrationLog'

const ExcerptTruncationMarker = '...'

/** 分类器可见的准入事实（注入方只读，不得改写）。 */
export interface ContextClassificationInput {
  kind: ContextRecordKind
  toolName: Nullable<string>
  toolCallId: Nullable<string>
  /** 工具调用参数（若调用方给了配对的 tool-call）。 */
  toolArgs: unknown
  text: string
  chars: number
}

/**
 * 记录分类器端口：能力包/宿主注入领域语义的唯一入口。
 * 每个方法都可缺省；返回 nullish 表示"我不表态"，回落结构默认。
 */
export interface ContextRecordClassifier {
  isRefetchable?(input: ContextClassificationInput): LooseOptional<boolean>
  resolveDedupeTarget?(input: ContextClassificationInput): LooseOptional<string>
  isPinned?(input: ContextClassificationInput): LooseOptional<boolean>
}

export interface ContextAdmissionInput {
  kind: ContextRecordKind
  message: ModelMessage
  /** 记录创建时刻，由调用方给（准入是纯函数，不取时钟）。 */
  createdAt: number
  turn: number
  /** 配对的工具调用参数：tool-result 记录靠它拿"目标"。 */
  toolArgs?: unknown
  /** 全保真层引用（PayloadStore）。 */
  payloadRef?: LooseOptional<string>
  /** 显式覆盖：P6 护栏类记录。 */
  pinned?: LooseOptional<boolean>
  /** 显式覆盖：可重取。 */
  refetchable?: LooseOptional<boolean>
  /** 显式覆盖：语义去重的目标定位符。 */
  dedupeTarget?: LooseOptional<string>
  /** summary 专用：被折叠的成员记录 id。 */
  memberIds?: readonly string[]
}

export interface ContextAdmissionDecision {
  record: ContextRecord
  /** 准入事件的因果（`admission` / `admission-oversize`）。 */
  cause: ContextMigrationCause
  /** 本次准入令其失效的旧记录 id（只标记，不迁移）。 */
  supersededIds: string[]
}

export interface AdmitContextRecordOptions {
  seq: number
  config?: LooseOptional<ContextGovernanceConfig>
  classifier?: LooseOptional<ContextRecordClassifier>
  /** 账本内既有记录（按账本序），用于语义去重比对。 */
  priorRecords?: readonly ContextRecord[]
}

/**
 * 准入判决：给一条新消息定初始驻留、抽锚点、算字节、标失效旧快照。
 * 纯函数 —— 同输入必同输出（时间由 `createdAt` 携带）。
 */
export function admitContextRecord(
  input: ContextAdmissionInput,
  options: AdmitContextRecordOptions
): ContextAdmissionDecision {
  const config = options.config ?? DefaultContextGovernanceConfig
  const text = readMessageText(input.message)
  const chars = estimateMessageChars(input.message)
  const identity = resolveToolIdentity(input)
  const classification: ContextClassificationInput = {
    kind: input.kind,
    toolName: identity.toolName,
    toolCallId: identity.toolCallId,
    toolArgs: input.toolArgs,
    text,
    chars,
  }

  const dedupeKey = resolveDedupeKey(classification, input, options.classifier)
  const refetchable = resolveRefetchable(classification, input, options.classifier, dedupeKey)
  const pinned = resolvePinned(classification, input, options.classifier)
  const oversize = input.kind === 'tool-result' && chars > config.admission.inlineMaxChars
  const id = createContextRecordId(options.seq)
  const excerpt = oversize
    ? buildRecordExcerpt({
        id,
        text,
        toolCallId: identity.toolCallId,
        payloadRef: input.payloadRef,
        toolName: identity.toolName,
        maxChars: config.admission.excerptMaxChars,
      })
    : null
  const admittedResidency: ContextResidency = oversize ? 'EXCERPT' : 'INLINE'

  const record: ContextRecord = {
    id,
    seq: options.seq,
    kind: input.kind,
    createdAt: input.createdAt,
    turn: Math.max(0, Math.floor(input.turn)),
    pinned,
    refetchable,
    admittedResidency,
    bytes: { full: chars, excerpt: excerpt ? excerpt.text.length : 0 },
    anchors: extractContextAnchors(text),
    message: input.message,
    excerpt,
    toolName: identity.toolName,
    toolCallId: identity.toolCallId,
    dedupeKey,
    memberIds: input.memberIds ?? [],
    payloadRef: toNullable(input.payloadRef),
  }

  return {
    record,
    cause: oversize ? 'admission-oversize' : 'admission',
    supersededIds: collectSupersededIds(record, options.priorRecords ?? []),
  }
}

/** EXCERPT 记录 → 召回信封（投影期拼装的唯一形态，与 v1 折叠桩逐字同形）。 */
export function buildExcerptEnvelope(record: ContextRecord): Nullable<ContextRefEnvelope> {
  const excerpt = record.excerpt
  if (!excerpt) return null

  return buildContextRefEnvelope({
    __contextRef: 'tool-output',
    ref: excerpt.ref,
    toolCallId: toOptional(record.toolCallId),
    toolName: toOptional(record.toolName),
    payloadRef: toOptional(record.payloadRef),
    excerpt: excerpt.text,
    excerptKind: excerpt.kind,
    excerptTruncated: excerpt.truncated,
    originalLength: record.bytes.full,
    reason: excerpt.reason,
    retrieval: {
      tool: 'recall_context',
      args: { ref: excerpt.ref, refKind: excerpt.refKind, reason: excerpt.reason },
    },
    meta: { recordId: record.id },
  })
}

/** 头尾摘录（沿用 `tool-output-store` 的对半切 + 代理对边界保护）。 */
export function sliceHeadTailExcerpt(text: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  if (text.length <= maxChars) return text
  if (maxChars <= ExcerptTruncationMarker.length) return sliceHead(text, maxChars)

  const available = maxChars - ExcerptTruncationMarker.length
  const head = sliceHead(text, Math.ceil(available / 2))
  const tail = sliceTail(text, Math.floor(available / 2))
  return `${head}${ExcerptTruncationMarker}${tail}`
}

function buildRecordExcerpt(input: {
  id: string
  text: string
  toolCallId: Nullable<string>
  toolName: Nullable<string>
  payloadRef: LooseOptional<string>
  maxChars: number
}): ContextRecordExcerpt {
  const excerptText = sliceHeadTailExcerpt(input.text, input.maxChars)
  const ref = input.payloadRef?.trim() || input.toolCallId || input.id
  const refKind = input.payloadRef?.trim()
    ? 'payload-ref'
    : input.toolCallId
      ? 'tool-payload'
      : 'context-handle'

  return {
    text: excerptText,
    kind: 'head',
    truncated: excerptText.length < input.text.length,
    ref,
    refKind,
    reason: input.toolName ? `need full ${input.toolName} output` : 'need the full record',
  }
}

function resolveToolIdentity(input: ContextAdmissionInput): {
  toolName: Nullable<string>
  toolCallId: Nullable<string>
} {
  const results = readToolResultFacts(input.message)
  const first = results[0]
  if (first) return { toolName: first.toolName, toolCallId: first.toolCallId }

  const calls = readToolCallFacts(input.message)
  const call = calls[0]
  if (call) return { toolName: call.toolName, toolCallId: call.toolCallId }

  return { toolName: null, toolCallId: null }
}

function resolveDedupeKey(
  classification: ContextClassificationInput,
  input: ContextAdmissionInput,
  classifier: LooseOptional<ContextRecordClassifier>
): Nullable<string> {
  if (!classification.toolName) return null

  const explicit = input.dedupeTarget?.trim()
  const injected = classifier?.resolveDedupeTarget?.(classification)?.trim()
  const structural = extractResourceLocator(input.toolArgs)
  const target = explicit || injected || structural
  if (!target) return null

  return `${classification.toolName}::${target}`
}

function resolveRefetchable(
  classification: ContextClassificationInput,
  input: ContextAdmissionInput,
  classifier: LooseOptional<ContextRecordClassifier>,
  dedupeKey: Nullable<string>
): boolean {
  if (isPresent(input.refetchable)) return input.refetchable

  const injected = classifier?.isRefetchable?.(classification)
  if (isPresent(injected)) return injected

  // 结构默认：带资源定位符的工具结果 = 可重取（同一个 url/path 再跑一次就能拿回来）。
  return classification.kind === 'tool-result' && isPresent(dedupeKey)
}

function resolvePinned(
  classification: ContextClassificationInput,
  input: ContextAdmissionInput,
  classifier: LooseOptional<ContextRecordClassifier>
): boolean {
  if (isPresent(input.pinned)) return input.pinned

  const injected = classifier?.isPinned?.(classification)
  if (isPresent(injected)) return injected

  return classification.kind === 'governance'
}

/**
 * 语义去重：同 `dedupeKey` 的既有**可重取**记录被新记录取代 → 标 pending-EVICT。
 * 只收集 id，不改任何既有记录（P1）。
 */
function collectSupersededIds(
  record: ContextRecord,
  priorRecords: readonly ContextRecord[]
): string[] {
  if (!record.dedupeKey || !record.refetchable) return []

  return priorRecords
    .filter(
      (prior) =>
        prior.id !== record.id &&
        prior.dedupeKey === record.dedupeKey &&
        prior.refetchable &&
        !prior.pinned
    )
    .map((prior) => prior.id)
}

function sliceHead(text: string, maxChars: number): string {
  if (maxChars <= 0) return ''

  let end = Math.min(text.length, maxChars)
  if (end > 0 && end < text.length && isSurrogatePair(text, end - 1)) end -= 1
  return text.slice(0, end)
}

function sliceTail(text: string, maxChars: number): string {
  if (maxChars <= 0) return ''

  let start = Math.max(0, text.length - maxChars)
  if (start > 0 && start < text.length && isSurrogatePair(text, start - 1)) start += 1
  return text.slice(start)
}

function isSurrogatePair(text: string, highIndex: number): boolean {
  const high = text.charCodeAt(highIndex)
  const low = text.charCodeAt(highIndex + 1)
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff
}
