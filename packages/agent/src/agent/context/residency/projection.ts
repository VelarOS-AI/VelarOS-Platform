/**
 * 账本投影是上下文治理第二版唯一的提示词组装入口。
 *
 * 投影函数保持纯计算和确定性，相同输入必得相同输出。函数内禁止读取当前时间、使用随机数或进行
 * 地区相关比较；时间来自记录元数据，顺序由 `seq` 固定。
 *
 * 输出依次由稳定前缀、按账本顺序渲染的驻留记录、活动尾组成。各段只追加，轮间前缀逐字不变。
 * 尾保护仅决定记录所属段落，不改变渲染结果，窗口滑动不能改写已经发送的字节。
 *
 * 工具调用与工具结果必须成对进入提供方，否则历史结构校验会拒绝请求。因此已摘要的工具记录只
 * 降级为结构墓碑：保留消息壳和 `toolCallId`，正文替换为墓碑信封。只有用户、助手叙事和环境变化
 * 等非工具记录才会真正从投影中消失。
 */
import type { ModelMessage } from 'ai'

import { isArray, isEmpty, isFiniteNumber, isNull, isRecord, isString } from '@velaros-ai/core'

import { buildContextRefEnvelope } from '../contextRefEnvelope'

import {
  buildExcerptEnvelope,
  buildToolPartExcerptEnvelope,
  hasExcerptRenderMaterial,
} from './admission'
import { toContextAnchorTexts } from './anchors'
import {
  type ContextRecord,
  type ContextRecordToolPart,
  type ContextResidency,
  type ContextResidencyVector,
  estimateResidencyTokens,
} from './ContextRecord'
import { stableFingerprint } from './determinism'
import { estimateMessageBudgetChars } from './messageFacts'

export interface ContextProjectionBudget {
  /** 尾保护轮数：最近若干轮的记录治理器永不选中（投影落在活动尾）。 */
  tailProtectTurns: number
  /**
   * 尾保护条数：最近若干**条记录**。与轮数取**交集**——两条判据都满足才受保护。
   *
   * 只按对话轮算尾保护有一个致命形态：一次长自主运行（用户发一条指令后 agent 连跑几十轮工具）
   * 整本账本只有 1 个对话轮，于是每条记录都在窗口内，治理器一条候选都收不到、100% 空转（审计
   * V1）。轮是"模型正在聊哪件事"的量纲，条数是"模型手边还需要看多少东西"的量纲，压力来自后者。
   * 缺省视为不限条数（只按轮），0 = 与 `tailProtectTurns: 0` 同义（尾保护关闭）。
   */
  tailProtectMaxRecords?: LooseOptional<number>
  /** 治理窗口 G（token）。给出即产出占用率，缺省则占用率为 null。 */
  budgetTokens?: LooseOptional<number>
  /** token 估算口径，默认 4 字符 1 token。 */
  charsPerToken?: LooseOptional<number>
}

export interface ProjectContextLedgerInput {
  records: readonly ContextRecord[]
  residency: ContextResidencyVector
  budget: ContextProjectionBudget
  /** 稳定前缀：调用方产出并保证逐轮字节不变。 */
  stablePrefix?: readonly ModelMessage[]
  /** 活动尾的外部注入块挂载点（context-dashboard / turn-context delta）。 */
  tailBlocks?: readonly ModelMessage[]
}

export interface ContextProjectionStats {
  recordCount: number
  byResidency: Record<ContextResidency, number>
  /** 真正从投影里消失的记录数（被 summary 代表的非工具成员）。 */
  hiddenCount: number
  /** 渲染成墓碑的记录数。 */
  tombstoneCount: number
  excerptCount: number
  /** 落在尾保护窗口、治理器不得选中的记录 id（账本序）。 */
  tailProtectedRecordIds: string[]
  projectedChars: number
  projectedTokens: number
  budgetTokens: Nullable<number>
  occupancyPercent: Nullable<number>
  /** 账本段的内容指纹：前缀是否漂移一眼可判（缓存回归的探针）。 */
  ledgerFingerprint: string
}

export interface ContextProjectionResult {
  messages: ModelMessage[]
  stats: ContextProjectionStats
}

/** 账本投影：唯一的 prompt 组装口。 */
export function projectContextLedger(
  input: ProjectContextLedgerInput
): ContextProjectionResult {
  const ordered = orderBySeq(input.records)
  const tailProtected = resolveTailProtectedRecordIds(ordered, input.budget)
  const charsPerToken = input.budget.charsPerToken ?? 4

  const byResidency: Record<ContextResidency, number> = {
    INLINE: 0,
    EXCERPT: 0,
    SUMMARIZED: 0,
    EVICTED: 0,
    EXPIRED: 0,
  }
  const tailProtectedRecordIds: string[] = []
  const ledgerMessages: ModelMessage[] = []
  const tailMessages: ModelMessage[] = []
  let projectedChars = 0
  let hiddenCount = 0
  let tombstoneCount = 0
  let excerptCount = 0

  for (const record of ordered) {
    const declared = input.residency.get(record.id) ?? record.admittedResidency
    byResidency[declared] += 1
    const isTailProtected = tailProtected.has(record.id)
    if (isTailProtected) tailProtectedRecordIds.push(record.id)

    // 尾保护只决定这条消息挂在"账本段"还是"活动尾"，**不改渲染**（见
    // {@link resolveEffectiveResidency}）：窗口滑动因此不会改写任何已发出去的字节。
    const effective = resolveEffectiveResidency(record, declared)
    const rendered = renderRecord(record, effective)
    if (rendered.kind === 'excerpt') excerptCount += 1
    if (rendered.kind === 'tombstone') tombstoneCount += 1
    if (rendered.kind === 'hidden') {
      hiddenCount += 1
      continue
    }

    projectedChars += residentChars(record, effective)
    if (isTailProtected) {
      tailMessages.push(rendered.message)
      continue
    }
    ledgerMessages.push(rendered.message)
  }

  const projectedTokens = estimateResidencyTokens(projectedChars, charsPerToken)
  const budgetTokens = normalizeBudgetTokens(input.budget.budgetTokens)

  return {
    messages: [
      ...(input.stablePrefix ?? []),
      ...ledgerMessages,
      ...tailMessages,
      ...(input.tailBlocks ?? []),
    ],
    stats: {
      recordCount: ordered.length,
      byResidency,
      hiddenCount,
      tombstoneCount,
      excerptCount,
      tailProtectedRecordIds,
      projectedChars,
      projectedTokens,
      budgetTokens,
      occupancyPercent: resolveOccupancyPercent(projectedTokens, budgetTokens),
      ledgerFingerprint: stableFingerprint(ledgerMessages),
    },
  }
}

export interface ContextProjectionMeasurement {
  projectedChars: number
  projectedTokens: number
  /** 尾保护窗口内（治理器不得选中）的记录 id。 */
  tailProtectedRecordIds: Set<string>
}

/**
 * 投影度量（不产消息，只算占用）。
 *
 * 治理器每次试探降级都要问"现在投影多大"，用 {@link projectContextLedger} 去算等于每次迭代
 * 重建一遍消息数组。这里与投影**共用同一条尾保护规则与同一份 `residentChars`**，所以度量与
 * 真实投影恒等 —— 唯一的替代方案（治理器自己写一份占用公式）会立刻长出第二套尾保护语义。
 */
export function measureLedgerProjection(input: {
  records: readonly ContextRecord[]
  residency: ContextResidencyVector
  budget: ContextProjectionBudget
}): ContextProjectionMeasurement {
  const ordered = orderBySeq(input.records)
  const tailProtectedRecordIds = resolveTailProtectedRecordIds(ordered, input.budget)
  const charsPerToken = input.budget.charsPerToken ?? 4
  let projectedChars = 0

  for (const record of ordered) {
    const declared = input.residency.get(record.id) ?? record.admittedResidency

    const effective = resolveEffectiveResidency(record, declared)
    // 隐藏记录（被 summary 代表的非工具成员）不占字符：与投影的 `hidden` 分支同判。
    if (!record.message) continue
    if (isHiddenInProjection(record, effective)) continue

    projectedChars += residentChars(record, effective)
  }

  return {
    projectedChars,
    projectedTokens: estimateResidencyTokens(projectedChars, charsPerToken),
    tailProtectedRecordIds,
  }
}

/**
 * 有效驻留态：**无摘录素材的 EXCERPT 回落 INLINE**。
 *
 * 这不是宽容而是对齐：`renderExcerptMessage` 拿不到信封时会原样投影全文，度量若仍按
 * `bytes.excerpt`（此时是 0）算，治理器会以为省下了全部字符 —— 一次"省了但没省"的 epoch。
 * 判据与准入期定 `admittedResidency` 用的是同一个 {@link hasExcerptRenderMaterial}（单源）。
 *
 * ## 尾保护**不**在这里生效（v3 · R1 判决）
 * 尾保护的语义是「治理器不得再降这条记录」——由 `collectCandidates` / `applyPendingDistills`
 * 按 id 排除窗口内记录兑现——而**不是**「把准入期已判 EXCERPT 的记录还原成全文」。上翻会直接
 * 毁掉 P4：窗口是「最近 N 轮 ∩ 最近 M 条」的交集，每追加一条记录就滑一格，滑出去的那条 EXCERPT
 * 记录的渲染会从全文变成信封，而它的位置固定在前缀中段 —— 既不产 `GovernanceEpochReport`
 * 也不落 `ContextResidencyMigrationEvent`，KV 缓存却每轮失效一次（长自主运行正是 V1 要救的形态）。
 * 窗口内外渲染一致，前缀才只在 epoch 迁移时变。
 *
 * 顺带堵掉一个洞：一条 50K 的工具结果不再因为"落在窗口里"就绕过 `admission.excerptMaxChars`
 * 安全阀被逐字发给 provider。
 *
 * 窗口内的记录永远不会被降级（窗口只出不进：记录数只增、latestTurn 只涨），所以"声明态"对它们
 * 恒等于准入态 —— 尾保护不需要在渲染面再补一道地板。
 */
export function resolveEffectiveResidency(
  record: ContextRecord,
  declared: ContextResidency
): ContextResidency {
  if (declared === 'EXCERPT' && !hasExcerptRenderMaterial(record)) return 'INLINE'

  return declared
}

/**
 * 当前驻留态下这条记录在 prompt 里**真正**占的字符数（投影与预算共用的单源）。
 *
 * 口径是"渲染即量"：直接量 {@link renderRecord} 产出的那条消息，与 `bytes.budget` 同一把尺子
 * （`estimateMessageBudgetChars`）。过去这里是三条估算——EXCERPT 按摘录原文长度记（不含信封与二次
 * 转义）、冷驻留一律按 ~70 字符的墓碑常量记，而 tool-call 的冷驻留其实**逐字保留全部 input
 * 参数**。实测记账比真实小 2.7~4.3 倍（审计 V3/V11/U1/U5/U17/U26），于是"达标即停"在真实占用
 * 远高于目标线时提前收手、savingPercent 与 dashboard 一起骗人、handoff 该布防时不布防。
 *
 * 缓存按记录对象身份 memo：记录一旦入账永不改写（P1），所以同一条记录同一驻留态的渲染长度恒定。
 */
export function residentChars(record: ContextRecord, residency: ContextResidency): number {
  // INLINE 使用归一化附件后的字符量；原文长度独立保留在 bytes.full。
  if (residency === 'INLINE') return record.bytes.budget ?? (record.message ? estimateMessageBudgetChars(record.message) : record.bytes.full)

  const cached = renderedCharsByRecord.get(record)
  const hit = cached?.get(residency)
  if (isFiniteNumber(hit)) return hit

  const rendered = renderRecord(record, residency)
  const chars = rendered.kind === 'hidden' ? 0 : estimateMessageBudgetChars(rendered.message)
  if (cached) cached.set(residency, chars)
  else renderedCharsByRecord.set(record, new Map([[residency, chars]]))

  return chars
}

const renderedCharsByRecord = new WeakMap<ContextRecord, Map<ContextResidency, number>>()

/**
 * 尾保护窗口：最近 `tailProtectTurns` 轮**与**最近 `tailProtectMaxRecords` 条记录的**交集**。
 *
 * 单源在这里，投影与度量共用（两份尾保护语义迟早会漂，那正是本函数存在的理由）。
 */
export function resolveTailProtectedRecordIds(
  records: readonly ContextRecord[],
  budget: Pick<ContextProjectionBudget, 'tailProtectTurns' | 'tailProtectMaxRecords'>
): Set<string> {
  const protectTurns = Math.max(0, Math.floor(budget.tailProtectTurns))
  const maxRecords = isFiniteNumber(budget.tailProtectMaxRecords)
    ? Math.max(0, Math.floor(budget.tailProtectMaxRecords))
    : Number.POSITIVE_INFINITY
  const protectedIds = new Set<string>()
  if (protectTurns === 0 || maxRecords === 0) return protectedIds

  const ordered = orderBySeq(records)
  const latestTurn = ordered.reduce((latest, record) => Math.max(latest, record.turn), 0)
  const floorTurn = latestTurn - (protectTurns - 1)
  const fromIndex =
    maxRecords === Number.POSITIVE_INFINITY ? 0 : Math.max(0, ordered.length - maxRecords)
  for (let index = fromIndex; index < ordered.length; index += 1) {
    const record = ordered[index]!
    if (record.turn >= floorTurn) protectedIds.add(record.id)
  }

  return protectedIds
}

/** 账本序（已有序时零拷贝——度量在 epoch 循环里被反复调用）。 */
function orderBySeq(records: readonly ContextRecord[]): readonly ContextRecord[] {
  for (let index = 1; index < records.length; index += 1) {
    if (records[index]!.seq < records[index - 1]!.seq)
      return [...records].sort((left, right) => left.seq - right.seq)
  }

  return records
}

/** 该记录在给定驻留态下是否**整条消失**（与 `renderRecord` 的 hidden 分支同判）。 */
function isHiddenInProjection(record: ContextRecord, residency: ContextResidency): boolean {
  if (residency === 'INLINE' || residency === 'EXCERPT') return false
  if (record.kind === 'tool-result' || record.kind === 'tool-call') return false

  return residency === 'SUMMARIZED'
}

type RenderedRecord =
  | { kind: 'inline' | 'excerpt' | 'tombstone'; message: ModelMessage }
  | { kind: 'hidden'; message: null }

function renderRecord(record: ContextRecord, residency: ContextResidency): RenderedRecord {
  const message = record.message
  if (!message) return { kind: 'hidden', message: null }

  if (residency === 'INLINE') return { kind: 'inline', message }

  if (residency === 'EXCERPT') {
    const excerptMessage = renderExcerptMessage(record, message)
    if (excerptMessage) return { kind: 'excerpt', message: excerptMessage }
    return { kind: 'inline', message }
  }

  // SUMMARIZED / EVICTED / EXPIRED：工具类记录必须留结构壳（配对不可破），其余真正消失。
  if (record.kind === 'tool-result') return {
      kind: 'tombstone',
      message: rewriteToolResultOutputs(message, (part) =>
        buildTombstoneText(record, residency, findToolPart(record, part))
      ),
    }

  if (record.kind === 'tool-call') return {
      kind: 'tombstone',
      message: stripAssistantTextParts(message),
    }

  if (residency === 'SUMMARIZED') return { kind: 'hidden', message: null }

  return { kind: 'tombstone', message: buildTombstoneMessage(record, residency) }
}

function renderExcerptMessage(record: ContextRecord, message: ModelMessage): Nullable<ModelMessage> {
  // user 记录（48K 安全阀）：**角色不可改写**。把正文换成 v1 同形的"摘录 + 存储提示"纯文本，
  // 信封 JSON 留给工具结果——把一条用户指令渲染成 assistant JSON 会同时丢角色与可读性。
  if (record.kind === 'user') {
    const excerptText = record.excerpt?.text
    if (!excerptText) return null

    return rewriteUserTextParts(message, excerptText)
  }

  // 工具结果：**每个 part 各拿各的信封**。同一条 tool 消息可装 N 份并行结果，共用一个信封会把
  // 第一份的 toolCallId/ref/正文写进全部 N 个 part —— 结果与调用错配、召回指向别人的 payload、
  // 消息还被放大到原文的两倍多（审计 V5/V12）。没有 per-part 素材的 part 保持原样。
  if (record.kind === 'tool-result') {
    if (isEmpty(record.toolParts)) {
      const envelope = buildExcerptEnvelope(record)
      if (!envelope) return null

      const serialized = JSON.stringify(envelope)
      return rewriteToolResultOutputs(message, () => serialized)
    }

    let rewritten = false
    const rendered = rewriteToolResultOutputs(message, (part) => {
      const envelope = buildToolPartExcerptEnvelope(record, findToolPart(record, part))
      if (!envelope) return null
      rewritten = true
      return JSON.stringify(envelope)
    })
    return rewritten ? rendered : null
  }

  const envelope = buildExcerptEnvelope(record)
  if (!envelope) return null

  return { role: 'assistant', content: JSON.stringify(envelope) }
}

/**
 * part → per-part 事实。
 *
 * 按 `toolCallId` 认领；认不出（历史被改写过 / 结构异常）时回落记录级身份，保证渲染永远有一份
 * 可用的召回引用，而不是让某个 part 变成没有指针的死信封。
 */
function findToolPart(record: ContextRecord, part: unknown): ContextRecordToolPart {
  const toolCallId = isRecord(part) && isString(part.toolCallId) ? part.toolCallId : null
  const matched = toolCallId
    ? record.toolParts.find((candidate) => candidate.toolCallId === toolCallId)
    : null

  return (
    matched ?? {
      toolCallId: toolCallId ?? record.toolCallId ?? record.id,
      toolName: record.toolName ?? record.kind,
      chars: record.bytes.full,
      excerpt: record.excerpt,
      payloadRef: record.payloadRef,
    }
  )
}

/** 改写 user 消息的文本正文（字符串正文与 text 片段两种形态），角色与其余片段逐字保留。 */
function rewriteUserTextParts(message: ModelMessage, value: string): ModelMessage {
  if (message.role !== 'user') return message
  if (isString(message.content)) return { ...message, content: value } as ModelMessage
  if (!isArray(message.content)) return message

  let replaced = false
  const content = (message.content as unknown[]).flatMap((part) => {
    if (!isRecord(part) || part.type !== 'text') return [part]
    // 摘录已经覆盖全部 text parts，只在第一处放一次，其余附件保持原顺序与内容。
    if (replaced) return []
    replaced = true
    return [{ ...part, text: value }]
  })

  return replaced ? ({ ...message, content } as ModelMessage) : message
}

/**
 * 墓碑文本：一行 id + 原因 + 召回指针。
 *
 * EXPIRED 刻意**不发信封**——原文已冷归档 GC，给一个能召回的指针只会换来一次空转召回。
 * 诚实的做法是给纯文本墓碑，模型一眼看出"这段回不来了"。
 */
function buildTombstoneText(
  record: ContextRecord,
  residency: ContextResidency,
  part?: LooseOptional<ContextRecordToolPart>
): string {
  const reason = `context record ${record.id} is ${residency.toLowerCase()}`
  if (residency === 'EXPIRED')
    return `[context-record ${record.id} expired: cold-archived, original no longer retrievable]`

  const ref = resolveTombstoneRef(record, part)
  return JSON.stringify(
    buildContextRefEnvelope({
      __contextRef: 'history-budget-truncated',
      ref,
      reason,
      originalLength: part ? part.chars : record.bytes.full,
      retrieval: {
        tool: 'context:recall',
        args: { ref, refKind: resolveTombstoneRefKind(record, part), reason },
      },
      meta: { recordId: record.id, anchors: toContextAnchorTexts([...record.anchors]) },
    })
  )
}

function resolveTombstoneRef(
  record: ContextRecord,
  part: LooseOptional<ContextRecordToolPart>
): string {
  if (part) return part.excerpt?.ref ?? part.payloadRef ?? part.toolCallId
  return record.excerpt?.ref ?? record.payloadRef ?? record.toolCallId ?? record.id
}

function resolveTombstoneRefKind(
  record: ContextRecord,
  part: LooseOptional<ContextRecordToolPart>
): 'payload-ref' | 'tool-payload' | 'context-handle' {
  if (part) return part.payloadRef ? 'payload-ref' : 'tool-payload'
  if (record.payloadRef) return 'payload-ref'
  if (record.toolCallId) return 'tool-payload'
  return 'context-handle'
}

function buildTombstoneMessage(record: ContextRecord, residency: ContextResidency): ModelMessage {
  return { role: 'assistant', content: buildTombstoneText(record, residency) }
}

/**
 * 改写 tool 消息里每个 tool-result 片段的正文，消息壳与 toolCallId 逐字保留。
 *
 * `nextValue` 按 part 调用（并行结果各写各的）；返回 null = 这个 part 原样保留 —— 结构化输出
 * 没有 per-part 素材时，"原样"必须是逐字不动，不能被当成空正文写回去。
 */
function rewriteToolResultOutputs(
  message: ModelMessage,
  nextValue: (part: unknown) => Nullable<string>
): ModelMessage {
  if (message.role !== 'tool' || !isArray(message.content)) return message

  const content = (message.content as unknown[]).map((part) => {
    if (!isRecord(part) || part.type !== 'tool-result') return part
    const value = nextValue(part)
    if (isNull(value)) return part
    const output = isRecord(part.output) ? part.output : { type: 'text' }
    return { ...part, output: { ...output, type: 'text', value } }
  })

  return { ...message, content } as ModelMessage
}

/** tool-call 消息降级：文本片段清掉，tool-call 片段逐字保留（配对不可破）。 */
function stripAssistantTextParts(message: ModelMessage): ModelMessage {
  if (message.role !== 'assistant' || !isArray(message.content)) return message

  const content = (message.content as unknown[]).filter(
    (part) => !isRecord(part) || part.type !== 'text'
  )
  if (isEmpty(content)) return message

  return { ...message, content } as ModelMessage
}

function normalizeBudgetTokens(value: LooseOptional<number>): Nullable<number> {
  if (!isFiniteNumber(value) || value <= 0) return null
  return Math.floor(value)
}

function resolveOccupancyPercent(
  projectedTokens: number,
  budgetTokens: Nullable<number>
): Nullable<number> {
  if (!budgetTokens) return null
  return Math.round((projectedTokens / budgetTokens) * 1000) / 10
}
