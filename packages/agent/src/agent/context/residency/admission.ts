/**
 * 准入钩子（上下文治理 v2 · §4A，唯一的**缓存安全**治理点）。
 *
 * 新记录进账本的一瞬间定初始驻留，之后轮与轮之间投影严格只追加 —— 这是 P1/P4 的地基：
 * 准入不改写任何既有记录，所以准入永远不会毁缓存。三条规则：
 *  ① 工具结果超 `admission.inlineMaxChars` → 直接 EXCERPT（头尾摘录 + 召回句柄，语义与今天的
 *     `tool-output-store` 句柄化逐字一致，`context:recall` 继续认）；
 *  ② 同工具同目标的旧快照类记录 → 标 **pending-EVICT**（只标记，真正逐出归 B1 的 epoch。
 *     依据：相似而过时的内容比无关内容更毒）；
 *  ③ 锚点规则抽取立刻做，落记录元数据（后续骨架与锚点验证共用同一份）。
 *
 * 刻意不做的事：不按工具名单分类。具体能力的工具名不属于 agent 包（与 `StatefulToolResults`
 * 同教义），"可重取 / 快照目标"一律走**结构信号 + 注入分类器**两条路。
 */
import type { ModelMessage } from 'ai'

import { isEmpty, isNotNull, isPresent, toNullable, toOptional } from '@velaros-ai/core'

import { hasFailureSignal } from '../ContextLedger'
import { buildContextRefEnvelope, type ContextRefEnvelope } from '../contextRefEnvelope'

import { extractContextAnchors } from './anchors'
import {
  type ContextRecord,
  type ContextRecordExcerpt,
  type ContextRecordKind,
  type ContextRecordToolPart,
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
  type ToolResultFact,
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
  /** 工具错误形态或正文失败信号。 */
  failureEvidence: boolean
}

/**
 * `resolveDedupeTarget` 的**否决**哨兵：这条记录一律不参与去重。
 *
 * 端口原本只有"表态/弃权"两态，而弃权（nullish）会回落结构信号（args 里的 url/path）——于是
 * 「文件读不去重」这类意图根本无法表达：注入方一弃权，`system:read('/tmp/a.log', 1..120)` 与
 * 续读的 `120..240` 就同 key，前一页被当成"过时快照"折掉（审计 U42）。加第三态"否决"，
 * 表达的是"我知道这个工具，且我确定它不该按目标去重"，与"我不认识这个工具"分开。
 * 取一个不可能是 url/path 的字面量，避免与结构信号撞车。
 */
export const ContextDedupeVetoTarget = '@@velaros/no-dedupe@@'

/**
 * 记录分类器端口：能力包/宿主注入领域语义的唯一入口。
 * 每个方法都可缺省；返回 nullish 表示"我不表态"，回落结构默认。
 * `resolveDedupeTarget` 另有 {@link ContextDedupeVetoTarget} 一态表示"否决去重"。
 */
export interface ContextRecordClassifier {
  isRefetchable?(input: ContextClassificationInput): LooseOptional<boolean>
  resolveDedupeTarget?(input: ContextClassificationInput): LooseOptional<string>
  isPinned?(input: ContextClassificationInput): LooseOptional<boolean>
  /** 在尾保护之外继续保持直接驻留的额外轮数。 */
  resolveWarmLeaseTurns?(input: ContextClassificationInput): LooseOptional<number>
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
  /**
   * 并行工具结果的全保真层引用：toolCallId → payloadRef。
   *
   * 一条 `role:'tool'` 消息可装 N 份结果，只给第一份填 ref 会让第 2..N 份的墓碑指向别人的
   * payload（审计 V12）。给整张表，per-part 各取各的。
   */
  payloadRefsByToolCallId?: LooseOptional<Readonly<Record<string, string>>>
  /** 显式覆盖：P6 护栏类记录。 */
  pinned?: LooseOptional<boolean>
  /** 显式覆盖：可重取。 */
  refetchable?: LooseOptional<boolean>
  /** 显式覆盖：语义去重的目标定位符。 */
  dedupeTarget?: LooseOptional<string>
  /** 显式覆盖：准入后的额外升温租约。 */
  warmLeaseTurns?: LooseOptional<number>
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
  const priorRecords = options.priorRecords ?? []
  const text = readMessageText(input.message)
  const chars = estimateMessageChars(input.message)
  const results = readToolResultFacts(input.message)
  const identity = resolveToolIdentity(input, results)
  const failureEvidence = results.some((result) => result.isError) || hasFailureSignal(text)
  const classification: ContextClassificationInput = {
    kind: input.kind,
    toolName: identity.toolName,
    toolCallId: identity.toolCallId,
    toolArgs: input.toolArgs,
    text,
    chars,
    failureEvidence,
  }

  // 多结果消息不参与语义去重：记录身份只认第一份结果，拿它的 `工具::目标` 去判定整条消息过时，
  // 会连带把同消息里另外几份无关结果一起标 pending-EVICT。保守 = 不去重（也因此结构默认不可重取）。
  const dedupeKey =
    results.length > 1 ? null : resolveDedupeKey(classification, input, options.classifier)
  const refetchable = resolveRefetchable(classification, input, options.classifier, dedupeKey)
  const openingUserRecord =
    input.kind === 'user' && !priorRecords.some((prior) => prior.kind === 'user')
  const pinned = resolvePinned(classification, input, options.classifier, openingUserRecord)
  const warmLeaseTurns = resolveWarmLeaseTurns(classification, input, options.classifier)
  const oversize = resolveOversizeKind(input.kind, chars, config)
  const id = createContextRecordId(options.seq)
  const excerptMaxChars =
    oversize === 'user-text' ? config.admission.userInlineMaxChars : config.admission.excerptMaxChars
  const excerpt = oversize
    ? buildRecordExcerpt({
        id,
        kind: input.kind,
        text,
        toolCallId: identity.toolCallId,
        payloadRef: input.payloadRef,
        toolName: identity.toolName,
        maxChars: excerptMaxChars,
      })
    : null
  const toolParts = buildToolParts({
    id,
    results,
    payloadRef: input.payloadRef,
    payloadRefsByToolCallId: input.payloadRefsByToolCallId,
    // 摘录预算按 part 均分：N 份结果各留各的头尾，总量仍在一份预算内。整条消息共用一份摘录
    // 会让投影把同一段文本复制 N 遍写回 N 个 part —— 那是把消息放大而不是压缩（审计 V5）。
    maxCharsPerPart: oversize
      ? Math.max(1, Math.floor(excerptMaxChars / Math.max(1, results.length)))
      : 0,
  })
  // **判了超长还不够，得真有素材才算 EXCERPT**（审计 R5）。摘录预算按 part 均分，于是存在一个
  // 真实窗口：每个 part 都不超均分额度、整条消息却因 JSON 结构与转义开销越过阈值 —— 此时一份
  // per-part 素材都建不出来，投影只能原样发全文，而账本上写着 EXCERPT。那条"48K/24K 安全阀"
  // 于是变成"有时候不生效"，且没有任何记账偏差暴露它。这里把判据与渲染面对齐（同一个
  // {@link hasExcerptRenderMaterial}）：素材建不出来就老老实实记 INLINE —— 发出去的字节一个不
  // 变（本来就是全文），变的只是账本不再自相矛盾，治理器也不会以为这条还能靠"变薄"省下什么。
  const admittedResidency: ContextResidency =
    oversize && hasExcerptRenderMaterial({ kind: input.kind, excerpt, toolParts })
      ? 'EXCERPT'
      : 'INLINE'

  const record: ContextRecord = {
    id,
    seq: options.seq,
    kind: input.kind,
    createdAt: input.createdAt,
    turn: Math.max(0, Math.floor(input.turn)),
    pinned,
    refetchable,
    warmLeaseTurns,
    failureEvidence,
    admittedResidency,
    bytes: { full: chars, excerpt: excerpt ? excerpt.text.length : 0 },
    anchors: extractContextAnchors(text),
    message: input.message,
    excerpt,
    toolParts,
    toolName: identity.toolName,
    toolCallId: identity.toolCallId,
    dedupeKey,
    memberIds: input.memberIds ?? [],
    payloadRef: toNullable(input.payloadRef),
  }

  return {
    record,
    // 因果跟着**实际落点**走：判超长却没摘出素材、最终以 INLINE 准入的记录记 `admission`，
    // 否则事件流里会出现一条"超长准入"却全程全文的记录，离线重放读不出真相。
    cause: admittedResidency === 'EXCERPT' ? 'admission-oversize' : 'admission',
    supersededIds: collectSupersededIds(record, priorRecords),
  }
}

/**
 * 这条记录在 EXCERPT 档**渲染得出信封吗**（准入判定与投影渲染的单源判据）。
 *
 * 工具结果一旦带 per-part 事实，渲染就走 per-part 信封（并行结果各拿各的身份，V5/V12），
 * 记录级 `excerpt` 在那条路上根本不参与 —— 所以"有没有素材"必须按 part 问，不能看记录级摘录。
 */
export function hasExcerptRenderMaterial(record: {
  kind: ContextRecordKind
  excerpt: Nullable<ContextRecordExcerpt>
  toolParts: readonly ContextRecordToolPart[]
}): boolean {
  if (record.kind === 'tool-result' && !isEmpty(record.toolParts))
    return record.toolParts.some((part) => isNotNull(part.excerpt))

  return isNotNull(record.excerpt)
}

/**
 * per-part 摘录信封（并行工具结果专用）。
 *
 * 与 {@link buildExcerptEnvelope} 同形，只是身份、正文与 `originalLength` 都取这一个 part 的。
 */
export function buildToolPartExcerptEnvelope(
  record: ContextRecord,
  part: ContextRecordToolPart
): Nullable<ContextRefEnvelope> {
  const excerpt = part.excerpt
  if (!excerpt) return null

  return buildContextRefEnvelope({
    __contextRef: 'tool-output',
    ref: excerpt.ref,
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    payloadRef: toOptional(part.payloadRef),
    excerpt: excerpt.text,
    excerptKind: excerpt.kind,
    excerptTruncated: excerpt.truncated,
    originalLength: part.chars,
    reason: excerpt.reason,
    retrieval: {
      tool: 'context:recall',
      args: { ref: excerpt.ref, refKind: excerpt.refKind, reason: excerpt.reason },
    },
    meta: { recordId: record.id },
  })
}

/**
 * per-part 事实：身份、正文长度、召回引用、按需的头尾摘录。
 *
 * `maxCharsPerPart <= 0` = 本记录未超长，不需要摘录素材（投影按全文渲染，墓碑档仍要 ref）。
 */
function buildToolParts(input: {
  id: string
  results: readonly ToolResultFact[]
  payloadRef: LooseOptional<string>
  payloadRefsByToolCallId: LooseOptional<Readonly<Record<string, string>>>
  maxCharsPerPart: number
}): ContextRecordToolPart[] {
  return input.results.map((result, index) => {
    // 第一份结果沿用记录级 payloadRef（调用方只给单值时的既有形态），其余各取各的。
    const payloadRef =
      input.payloadRefsByToolCallId?.[result.toolCallId] ??
      (index === 0 ? input.payloadRef?.trim() || null : null)
    const excerpt =
      input.maxCharsPerPart > 0 && result.text.length > input.maxCharsPerPart
        ? buildRecordExcerpt({
            id: input.id,
            kind: 'tool-result',
            text: result.text,
            toolCallId: result.toolCallId,
            payloadRef,
            toolName: result.toolName,
            maxChars: input.maxCharsPerPart,
          })
        : null

    return {
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      chars: result.text.length,
      excerpt,
      payloadRef: toNullable(payloadRef),
    }
  })
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
      tool: 'context:recall',
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

/** 超长档：工具结果走 `inlineMaxChars`，user 正文走 `userInlineMaxChars`（v1 48K 安全阀）。 */
function resolveOversizeKind(
  kind: ContextRecordKind,
  chars: number,
  config: ContextGovernanceConfig
): Nullable<'tool-result' | 'user-text'> {
  if (kind === 'tool-result' && chars > config.admission.inlineMaxChars) return 'tool-result'
  if (kind === 'user' && chars > config.admission.userInlineMaxChars) return 'user-text'

  return null
}

function buildRecordExcerpt(input: {
  id: string
  kind: ContextRecordKind
  text: string
  toolCallId: Nullable<string>
  toolName: Nullable<string>
  payloadRef: LooseOptional<string>
  maxChars: number
}): ContextRecordExcerpt {
  const ref = input.payloadRef?.trim() || input.toolCallId || input.id
  const refKind = input.payloadRef?.trim()
    ? 'payload-ref'
    : input.toolCallId
      ? 'tool-payload'
      : 'context-handle'

  // user 正文保留头尾，避免结尾约束、附件说明或纠正被头部截断吞掉。完整正文只通过持久 ref 召回；
  // 投影期 user 记录只换正文不换角色，所以这里存的就是最终要贴进消息的文本。
  if (input.kind === 'user') {
    const text = buildUserTextSafetyValveText(input.text, input.maxChars, ref, refKind)
    return {
      text,
      kind: 'text',
      truncated: text.length < input.text.length,
      ref,
      refKind,
      reason: 'need the full user message',
    }
  }

  const excerptText = sliceHeadTailExcerpt(input.text, input.maxChars)
  return {
    text: excerptText,
    kind: 'head',
    truncated: excerptText.length < input.text.length,
    ref,
    refKind,
    reason: input.toolName ? `need full ${input.toolName} output` : 'need the full record',
  }
}

function buildUserTextSafetyValveText(
  original: string,
  maxChars: number,
  ref: string,
  refKind: ContextRecordExcerpt['refKind']
): string {
  const guidance = `[user text partially resident; originalLength=${original.length}; visible=head+tail; use context:recall(ref:"${ref}", refKind:"${refKind}", offset:0) for the exact full text.]`
  const excerptBudget = Math.max(1, maxChars - guidance.length - 2)
  const excerpt = sliceHeadTailExcerpt(original, excerptBudget).trim()
  return [excerpt, '', guidance].join('\n')
}

function resolveToolIdentity(
  input: ContextAdmissionInput,
  results: readonly ToolResultFact[]
): {
  toolName: Nullable<string>
  toolCallId: Nullable<string>
} {
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
  if (explicit) return `${classification.toolName}::${explicit}`

  // 注入方**否决**去重时到此为止：不回落结构信号。弃权（nullish）才回落——两者语义不同，
  // 混在一起就没法表达"这个工具我认识，但它的两次调用不是同一份事实"（审计 U42）。
  const injected = classifier?.resolveDedupeTarget?.(classification)?.trim()
  if (injected === ContextDedupeVetoTarget) return null

  const target = injected || extractResourceLocator(input.toolArgs)
  if (!target) return null

  return `${classification.toolName}::${target}`
}

function resolveRefetchable(
  classification: ContextClassificationInput,
  input: ContextAdmissionInput,
  classifier: LooseOptional<ContextRecordClassifier>,
  _dedupeKey: Nullable<string>
): boolean {
  if (isPresent(input.refetchable)) return input.refetchable

  const injected = classifier?.isRefetchable?.(classification)
  if (isPresent(injected)) return injected

  // 不再把“参数里有资源定位符”解释成“安全可重跑”。有副作用的能力同样可能携带定位符，
  // 结构猜测会把其结果错误地放进陈旧可重取档。宿主认识能力语义时必须显式表态；未知工具
  // 保守留在普通驻留档，若已有 payloadRef，治理器仍可走内容寻址的无副作用 page-out。
  return false
}

function resolveWarmLeaseTurns(
  classification: ContextClassificationInput,
  input: ContextAdmissionInput,
  classifier: LooseOptional<ContextRecordClassifier>
): number {
  if (isPresent(input.warmLeaseTurns)) return Math.max(0, Math.floor(input.warmLeaseTurns))

  const injected = classifier?.resolveWarmLeaseTurns?.(classification)
  if (isPresent(injected)) return Math.max(0, Math.floor(injected))

  // 普通 user 轮在尾窗口滑出后再保留四轮，避免多阶段任务刚进入执行就把中途纠正折掉。
  if (classification.kind === 'user') return 4
  // 错误正文通常仍在下一批修复/验证里使用，比普通工具输出多保留一个短阶段。
  if (classification.failureEvidence) return 8
  return 0
}

function resolvePinned(
  classification: ContextClassificationInput,
  input: ContextAdmissionInput,
  classifier: LooseOptional<ContextRecordClassifier>,
  openingUserRecord: boolean
): boolean {
  if (isPresent(input.pinned)) return input.pinned

  // 账本段的第一条 user 记录 = 任务陈述，结构性 pinned。
  //
  // **pinned 的真实语义是"治理器完全免疫"**：`GovernanceEpoch.isDegradable` 与
  // `distill.isDistillable` 都对 pinned 直接返回 false，这条记录连 EXCERPT 都降不了；账本层的
  // `clampResidencyForRecord` 地板（最低 EXCERPT）是**第二道保险**，防的是绕过候选集直接调
  // `ledger.migrate` 的路径，而不是给治理器留一条"可以变薄"的口子（审计 R7：文案曾写成"地板
  // EXCERPT，可以变薄"，与实现不符）。代价照实说：一条超长任务陈述会整段占住预算，压不下去的
  // 出路是转交（handoff），不是压它。
  //
  // 它被折掉有两重后果：投影以 assistant 开头（Anthropic 直接 400，会话砖化），以及模型再也
  // 看不到任务是什么——只剩骨架里那一行 220 字、还被排在整段账本之后（审计 V2）。
  // 这条不交给注入分类器表态：它是 provider 结构约束，不是领域语义。
  if (openingUserRecord) return true

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
