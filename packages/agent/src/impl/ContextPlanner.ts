import { isEmpty } from '@velaros-ai/core'
import type { ModelEstimateCalibration } from '@velaros-ai/model'

import type { ActFrameSegment } from '../types/act.js'
import { ContextPlanTuning } from '../utils/tuning.js'

/** 一个会话的容量规划：按实测用量校准估算，按段内增长估计剩余轮数；状态只在内存里，重启后重新学习。 */
export interface ContextPlannerApi {
  /** 当前的估算校准；没有实测样本时不缩小原始估算。 */
  calibration(): ModelEstimateCalibration
  /** 记下一次供应商实测的输入用量；带图片的请求不取样。 */
  measure(measured: { readonly text: number; readonly images: number }, inputTokens: number): void
  /** 供应商以超窗拒绝：清空校准，回到原始估算。 */
  rejected(): void
  /** 记下一帧的字符密度，用来把 token 窗口换算成投影的字符预算。 */
  density(chars: number, tokens: number): void
  /** 窗口对应的投影字符预算；还没有样本时用 ceiling。 */
  chars(window: number, ceiling: number): number
  /** 每轮增长的估计（token）。 */
  growth(window: number): number
  /** 按当前增长，窗口还能再容纳几轮。 */
  runway(tokens: number, window: number): number
  /** 一帧已被接受：同一段、同一底座内的正向增长计入样本。 */
  accept(tokens: number, segment: Optional<ActFrameSegment>): void
  /** 因容量封段了一次；与上次封段间隔过短记为抖动。 */
  folded(): void
  /** 最近一次封段离上一次不足 foldTurns 帧，且之后还没跑满 minTurns 帧。 */
  thrashing(): boolean
  /** 这一段已经整理过一次仍然不够：同段不再整理，等下次封段。 */
  exhaust(segment: string): void
  /** 这一段是否已整理过且不够。 */
  exhausted(segment: string): boolean
}

export class ContextPlanner implements ContextPlannerApi {
  private ratios: readonly number[] = []
  private densities: readonly number[] = []
  private increases: readonly number[] = []
  private last?: { readonly tokens: number; readonly segment: string; readonly revision: number }
  private sinceFold = Number.POSITIVE_INFINITY
  private shortFold = false
  private spent?: string

  public constructor(private readonly policy: { foldTurns: number; minTurns: number }) {}

  public calibration(): ModelEstimateCalibration {
    if (isEmpty(this.ratios)) return { textRatio: 1 }
    return {
      textRatio: Math.min(1, Math.max(...this.ratios) * ContextPlanTuning.calibrationMargin),
    }
  }

  public measure(
    measured: { readonly text: number; readonly images: number },
    inputTokens: number
  ) {
    // 图片的真实开销因供应商而异，只用纯文本请求校准文本部分
    if (measured.images > 0 || measured.text <= 0 || !(inputTokens > 0)) return
    this.ratios = [...this.ratios, inputTokens / measured.text].slice(
      -ContextPlanTuning.calibrationSamples
    )
  }

  public rejected(): void {
    this.ratios = []
  }

  public density(chars: number, tokens: number): void {
    if (chars > 0 && tokens > 0)
      this.densities = [...this.densities, chars / tokens].slice(-ContextPlanTuning.densitySamples)
  }

  public chars(window: number, ceiling: number): number {
    if (isEmpty(this.densities)) return ceiling
    const sorted = [...this.densities].sort((a, b) => a - b)
    return Math.max(1, Math.min(ceiling, Math.floor(window * sorted[sorted.length >> 1]!)))
  }

  public growth(window: number): number {
    if (isEmpty(this.increases))
      return Math.max(1, Math.floor(window * ContextPlanTuning.growthSeed))
    const sorted = [...this.increases].sort((a, b) => a - b)
    return Math.max(1, sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))]!)
  }

  public runway(tokens: number, window: number): number {
    return (window - tokens) / this.growth(window)
  }

  public accept(tokens: number, segment: Optional<ActFrameSegment>): void {
    this.sinceFold++
    if (
      segment &&
      this.last?.segment === segment.id &&
      this.last.revision === segment.revision &&
      tokens > this.last.tokens
    )
      this.increases = [...this.increases, tokens - this.last.tokens].slice(
        -ContextPlanTuning.growthSamples
      )
    this.last = segment ? { tokens, segment: segment.id, revision: segment.revision } : undefined
  }

  public folded(): void {
    this.shortFold = this.sinceFold < this.policy.foldTurns
    this.sinceFold = 0
  }

  public thrashing(): boolean {
    return this.shortFold && this.sinceFold < this.policy.minTurns
  }

  public exhaust(segment: string): void {
    this.spent = segment
  }

  public exhausted(segment: string): boolean {
    return this.spent === segment
  }
}
