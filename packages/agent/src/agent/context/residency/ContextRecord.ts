/**
 * 驻留账本的记录类型（上下文治理 v2 · P1 只追加 / P2 五态驻留）。
 *
 * 两条硬约束决定了本文件的形状：
 *  ① **记录内容一旦追加不可变**。所以 `ContextRecord` 里没有 `residency` 字段——驻留态是随
 *     epoch 变化的**外部状态向量**（见 `ResidencyLedger`），变化必须是显式迁移事件。记录上只留
 *     `admittedResidency`（准入判决，永不改写）。设计稿 §3 把 residency 画在记录上，但同稿的
 *     `project(ledger, residencyVector, budget)` 签名已经把它拆成独立入参——按后者落地。
 *  ② **投影必须确定**。所以时间、字节数、锚点全部在准入时算好落在记录元数据里，投影期零计算、
 *     零时钟、零随机。
 *
 * 全保真层不在这里：EXPIRED 之前的原文由既有 `ContextPayloadStore` 持有（v1 资产，不动），
 * 记录只带 `payloadRef` 与召回引用。
 */
import type { ModelMessage } from 'ai'

import type { ContextRefRetrieval } from '../contextRefEnvelope'

/** 记录类别（设计稿 §3 七类）。 */
export type ContextRecordKind =
  | 'user'
  | 'assistant'
  | 'tool-call'
  | 'tool-result'
  /** turn-context 注入块。 */
  | 'env-delta'
  /** I1/I2 产物，携 memberIds 作无损指针。 */
  | 'summary'
  /** 权限判决 / 用户纠正 / 安全规则 → 默认 PINNED。 */
  | 'governance'

/**
 * 驻留态（P2 五态）。单向降级：INLINE → EXCERPT → SUMMARIZED → EVICTED → EXPIRED；
 * 提升不是原地改写，而是在尾部**追加新副本**（缓存安全，见 §4C fault 处理）。
 */
export type ContextResidency = 'INLINE' | 'EXCERPT' | 'SUMMARIZED' | 'EVICTED' | 'EXPIRED'

/** 降级序（下标即 rank，越大越冷）。 */
export const ContextResidencyOrder: readonly ContextResidency[] = [
  'INLINE',
  'EXCERPT',
  'SUMMARIZED',
  'EVICTED',
  'EXPIRED',
]

/** PINNED 记录的最冷驻留（P6：护栏类内容永不被摘要吞掉）。 */
export const PinnedFloorResidency: ContextResidency = 'EXCERPT'

/** 驻留态向量：记录 id → 当前驻留态。投影的第二个入参。 */
export type ContextResidencyVector = ReadonlyMap<string, ContextResidency>

export interface ContextRecordBytes {
  /** 全文字符数（token 估算的输入）。 */
  full: number
  /** EXCERPT 投影后的字符数；无摘录时等于 0。 */
  excerpt: number
}

/** EXCERPT 投影的素材：准入期算好，投影期只做信封拼装。 */
export interface ContextRecordExcerpt {
  text: string
  kind: 'structured' | 'head' | 'facts' | 'code' | 'text' | 'json'
  /** false = 摘录未截断（内容已完整可见，不必召回）。 */
  truncated: boolean
  /** 召回引用，恒等于信封 `retrieval.args.ref`。 */
  ref: string
  refKind: ContextRefRetrieval['args']['refKind']
  reason: string
}

export interface ContextRecord {
  /** 稳定 id（`ctx-r000001` 形态），跨会话重放不变。 */
  readonly id: string
  /** 单调序号：账本序的唯一权威（不靠 id 字典序）。 */
  readonly seq: number
  readonly kind: ContextRecordKind
  /** 记录创建时刻（元数据携带 —— 投影内禁 `Date.now`）。 */
  readonly createdAt: number
  /** 所属对话轮序，从 0 起。尾保护窗口按它算。 */
  readonly turn: number
  /** P6：护栏类记录，最低只降到 EXCERPT。 */
  readonly pinned: boolean
  /** 文件读 / 页面快照类：可重取 → I0 优先逐出。 */
  readonly refetchable: boolean
  /** 准入判决（不可变）。当前驻留态在账本的向量里。 */
  readonly admittedResidency: ContextResidency
  readonly bytes: ContextRecordBytes
  /** 规则抽取的关键场：路径 / 命令 / 数字 / 标识符。 */
  readonly anchors: readonly string[]
  /** INLINE 投影正文。summary / env-delta / governance 同样以消息形态携带。 */
  readonly message: Nullable<ModelMessage>
  readonly excerpt: Nullable<ContextRecordExcerpt>
  readonly toolName: Nullable<string>
  readonly toolCallId: Nullable<string>
  /**
   * 语义去重键：`工具名::目标定位符`。同键的旧记录在新记录准入时被标 pending-EVICT
   * （相似而过时的内容比无关内容更毒）。无定位符时为 null，永不参与去重。
   */
  readonly dedupeKey: Nullable<string>
  /** summary 专用：被折叠的成员记录 id（无损指针）。其余类别恒为空数组。 */
  readonly memberIds: readonly string[]
  /** 全保真层引用（PayloadStore）。 */
  readonly payloadRef: Nullable<string>
}

/** 驻留态在降级序里的位次。 */
export function residencyRank(residency: ContextResidency): number {
  const rank = ContextResidencyOrder.indexOf(residency)
  return rank < 0 ? 0 : rank
}

/** `to` 是否比 `from` 更冷（严格降级）。 */
export function isResidencyDowngrade(from: ContextResidency, to: ContextResidency): boolean {
  return residencyRank(to) > residencyRank(from)
}

/** P6 地板：pinned 记录不得降到 EXCERPT 以下。 */
export function clampResidencyForRecord(
  record: Pick<ContextRecord, 'pinned'>,
  residency: ContextResidency
): ContextResidency {
  if (!record.pinned) return residency
  return residencyRank(residency) > residencyRank(PinnedFloorResidency)
    ? PinnedFloorResidency
    : residency
}

/** 稳定记录 id：序号零填充到 6 位，超出后自然加长（排序恒以 `seq` 为准，不依赖字典序）。 */
export function createContextRecordId(seq: number): string {
  return `ctx-r${String(Math.max(0, Math.floor(seq))).padStart(6, '0')}`
}

/** 当前驻留态下这条记录占的字符数（投影与预算共用的单源）。 */
export function residentChars(record: ContextRecord, residency: ContextResidency): number {
  if (residency === 'INLINE') return record.bytes.full
  if (residency === 'EXCERPT') return record.bytes.excerpt
  return estimateTombstoneChars(record)
}

/** 墓碑行的字符数：一行 id + 类别，量级恒定。 */
export function estimateTombstoneChars(record: ContextRecord): number {
  return record.id.length + record.kind.length + 48
}

/** 字符 → token 的粗估（与 v1 `estimateBlockTokens` 同口径：4 字符 1 token）。 */
export function estimateResidencyTokens(chars: number, charsPerToken: number = 4): number {
  const divisor = charsPerToken > 0 ? charsPerToken : 4
  return Math.max(0, Math.ceil(Math.max(0, chars) / divisor))
}
