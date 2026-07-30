/**
 * 上下文窗口预算。
 *
 * 把模型上下文窗口当作“物理内存”来治理：原始 `contextWindow` 是地址空间，
 * 但真正可供“输入侧（`system` + `history` + `tools`）”使用的额度，必须先扣除两块：
 *  1) 输出预留（`reservedOutputTokens`）：给模型本轮自身生成（含推理）留出的空间，
 *     类似进程栈增长预留；不预留会在“输入快满 + 长输出”时把窗口一起撑爆。
 *  2) 安全余量（`safetyMarginPercent`）：本地 `token` 估算与供应方真实计费口径存在偏差，
 *     留一条缓冲带，避免估算 89% 实际已 100%。
 *
 * ``usableContextWindow = floor(contextWindow * (1 - safety%)) - reservedOutputTokens``
 *
 * 估算用量的百分比改对 `usableContextWindow` 计量后，压缩水位（90%）会更早、更安全地触发。
 * 这些参数全部是“可选调优”：调用方不传时退化为旧行为（`usable == contextWindow`）。
 *
 * 实现说明：本模块只依赖具名导入的叶子原语（`isFiniteNumber` / `clamp`），不依赖任何副作用装载顺序。
 */
import { isFiniteNumber } from '../typeGuards'

import { clamp } from './number'

/** 默认安全余量百分比：吸收本地估算与供应方计费口径的偏差。 */
export const DefaultContextSafetyMarginPercent = 4

/** 输出预留占上下文窗口的比例。 */
export const DefaultOutputReserveRatio = 0.12

/** 输出预留下限：再小的窗口也要给模型留出基本的成稿空间。 */
export const MinOutputReserveTokens = 1_024

/** 输出预留上限：超大窗口下不必无谓预留过多，留给输入侧更多额度。 */
export const MaxOutputReserveTokens = 32_000

/**
 * 缺页中断（context overflow）应急压缩的目标水位。
 * 比常规压缩目标更激进：真正撞墙时要一次性腾出足够空间，避免重试又立刻溢出。
 */
export const ContextOverflowRecoveryTargetPercent = 60

export interface ContextWindowBudget {
  /** 模型上下文窗口原始大小（token）。 */
  contextWindow: number
  /** 扣除输出预留与安全余量后，输入侧真正可用的额度（token）。 */
  usableContextWindow: number
  /** 为模型本轮输出预留的 token 数。 */
  reservedOutputTokens: number
  /** 实际采用的安全余量百分比。 */
  safetyMarginPercent: number
}

export interface ResolveContextWindowBudgetInput {
  contextWindow: number
  /** 显式输出预留；缺省时按窗口比例自动推导并夹在上下限之间。 */
  reservedOutputTokens?: LooseOptional<number>
  /** 显式安全余量百分比；缺省采用默认值。 */
  safetyMarginPercent?: LooseOptional<number>
}

/** 按窗口比例推导输出预留 token，并夹在上下限之间；显式值优先。 */
export function resolveReservedOutputTokens(
  contextWindow: number,
  requested?: LooseOptional<number>,
): number {
  if (isFiniteNumber(requested) && requested >= 0) return Math.floor(requested)

  if (!isFiniteNumber(contextWindow) || contextWindow <= 0) return MinOutputReserveTokens

  const ratioReserve = Math.round(contextWindow * DefaultOutputReserveRatio)
  return Math.floor(clamp(ratioReserve, MinOutputReserveTokens, MaxOutputReserveTokens))
}

/** 由窗口、输出预留、安全余量计算输入侧可用额度（至少 1）。 */
export function resolveUsableContextWindow(input: {
  contextWindow: number
  reservedOutputTokens: number
  safetyMarginPercent: number
}): number {
  if (!isFiniteNumber(input.contextWindow) || input.contextWindow <= 0) return 1

  const margin = clamp(input.safetyMarginPercent, 0, 90)
  const afterMargin = Math.floor(input.contextWindow * (1 - margin / 100))
  const reserved = Math.max(0, Math.floor(input.reservedOutputTokens))
  return Math.max(1, afterMargin - reserved)
}

/** 解析完整的上下文窗口预算视图。 */
export function resolveContextWindowBudget(
  input: ResolveContextWindowBudgetInput,
): ContextWindowBudget {
  const contextWindow =
    isFiniteNumber(input.contextWindow) && input.contextWindow > 0
      ? Math.floor(input.contextWindow)
      : 1
  const safetyMarginPercent = isFiniteNumber(input.safetyMarginPercent)
    ? clamp(input.safetyMarginPercent, 0, 90)
    : DefaultContextSafetyMarginPercent
  const reservedOutputTokens = resolveReservedOutputTokens(
    contextWindow,
    input.reservedOutputTokens,
  )
  const usableContextWindow = resolveUsableContextWindow({
    contextWindow,
    reservedOutputTokens,
    safetyMarginPercent,
  })

  return {
    contextWindow,
    usableContextWindow,
    reservedOutputTokens,
    safetyMarginPercent,
  }
}
