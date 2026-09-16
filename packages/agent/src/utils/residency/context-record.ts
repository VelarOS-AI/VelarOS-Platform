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


import type { ContextRecord,ContextResidency } from '../../types/residency.js'

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

/**
 * 缺席量纲时的字符/token 密度（与 v1 `estimateBlockTokens` 同口径：4 字符 1 token）。
 *
 * 它是**兜底**不是常量：真实密度由编译期一次 tokenize 实测（中文/JSON 密集会话约 1.5-2），
 * 凡是能拿到实测值的地方都必须把它传进来——写死 4 会把占用低估 2-3 倍。
 */
export const DefaultResidencyCharsPerToken = 4

/** 字符 → token 的粗估；`charsPerToken` 缺席时按 {@link DefaultResidencyCharsPerToken} 兜底。 */
export function estimateResidencyTokens(
  chars: number,
  charsPerToken: number = DefaultResidencyCharsPerToken
): number {
  const divisor = charsPerToken > 0 ? charsPerToken : DefaultResidencyCharsPerToken
  return Math.max(0, Math.ceil(Math.max(0, chars) / divisor))
}
