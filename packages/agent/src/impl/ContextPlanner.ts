import { isEmpty } from '@velaros-ai/core'
import type { ModelEstimateCalibration } from '@velaros-ai/model'

import type { ActFrameSegment } from '../types/act.js'
import { ContextPlanTuning } from '../utils/tuning.js'

/** 一个会话的容量规划：按实测用量校准估算，按段内增长估计剩余轮数；状态只在内存里，重启后重新学习。 */
export interface ContextPlannerApi {
  /** 当前的估算校准；没有实测样本时不缩小原始估算。 */
  calibration(): ModelEstimateCalibration
  /** 记下无图片请求的实测输入；不扣减不透明状态，保守校准可见文本。 */
  measure(
    measured: { readonly text: number; readonly images: number; readonly opaque?: number },
    inputTokens: number
  ): void
  /** 供应商以超窗拒绝：清空校准，回到原始估算。 */
  rejected(): void
  /** 记下一帧的字符密度，用来把 token 窗口换算成投影的字符预算。 */
  density(chars: number, tokens: number): void
  /** 窗口对应的投影字符预算；还没有样本时用 ceiling。 */
  chars(window: number, ceiling: number): number
  /** 每轮增长的估计（token）；保留此前帧的布局单独取样。 */
  growth(window: number, retained?: boolean): number
  /** 按当前布局的增长，窗口还能再容纳几轮。 */
  runway(tokens: number, window: number, retained?: boolean): number
  /** 一帧已被接受：优先使用实测输入；同段、同底座、同布局、同计量来源的正向增长计入样本。 */
  accept(
    tokens: number,
    segment: Optional<ActFrameSegment>,
    retained?: boolean,
    inputTokens?: number
  ): void
  /** 封段后重新学习增长；与上次封段间隔过短仍记为抖动，容量校准保留。 */
  folded(): void
  /** 最近一次封段离上一次不足 foldTurns 帧，且之后还没跑满 minTurns 帧。 */
  thrashing(): boolean
  /** 这一段已经整理过一次仍然不够：同段不再整理，等下次封段。 */
  exhaust(segment: string): void
  /** 这一段是否已整理过且不够。 */
  exhausted(segment: string): boolean
}

export class ContextPlanner implements ContextPlannerApi {
  private samples: ReadonlyArray<{ text: number; input: number }> = []
  private densities: readonly number[] = []
  private increases: { readonly plain: readonly number[]; readonly retained: readonly number[] } = {
    plain: [],
    retained: [],
  }
  private last?: {
    readonly tokens: number
    readonly segment: string
    readonly revision: number
    readonly retained: boolean
    readonly measured: boolean
  }
  private sinceFold = Number.POSITIVE_INFINITY
  private shortFold = false
  private spent?: string

  public constructor(private readonly policy: { foldTurns: number; minTurns: number }) {}

  public calibration(): ModelEstimateCalibration {
    if (isEmpty(this.samples)) return { textRatio: 1 }
    const margin = ContextPlanTuning.calibrationMargin
    const fallback = {
      textRatio: Math.min(1, Math.max(...this.samples.map((s) => s.input / s.text)) * margin),
    }
    const textMean = this.samples.reduce((sum, s) => sum + s.text, 0) / this.samples.length
    const inputMean = this.samples.reduce((sum, s) => sum + s.input, 0) / this.samples.length
    const variance = this.samples.reduce((sum, s) => sum + (s.text - textMean) ** 2, 0)
    if (!variance) return fallback
    const slope =
      this.samples.reduce((sum, s) => sum + (s.text - textMean) * (s.input - inputMean), 0) /
      variance
    if (!(slope > 0 && slope * margin < 1)) return fallback
    // 固定开销与正文增长分开学习；上移到覆盖所有实测样本，再对两部分统一加余量。
    // 短首轮的高 token/字节比不应一直乘在随后大段源码上。
    const overheadTokens = Math.ceil(
      Math.max(0, ...this.samples.map((s) => s.input - slope * s.text)) * margin
    )
    return { textRatio: slope * margin, overheadTokens }
  }

  public measure(
    measured: { readonly text: number; readonly images: number; readonly opaque?: number },
    inputTokens: number
  ) {
    // 不透明状态可能只被部分采用，不从实测输入扣除它；样本是文本用量的上界。
    // 后续估算仍额外预留状态容量，避免低估，也让长程 Responses 会话持续学习。
    if (measured.images > 0 || measured.text <= 0 || !(inputTokens > 0)) return
    this.samples = [...this.samples, { text: measured.text, input: inputTokens }].slice(
      -ContextPlanTuning.calibrationSamples
    )
  }

  public rejected(): void {
    this.samples = []
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

  public growth(window: number, retained = false): number {
    const samples = retained ? this.increases.retained : this.increases.plain
    if (isEmpty(samples)) return Math.max(1, Math.floor(window * ContextPlanTuning.growthSeed))
    const sorted = [...samples].sort((a, b) => a - b)
    return Math.max(1, sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))]!)
  }

  public runway(tokens: number, window: number, retained = false): number {
    return (window - tokens) / this.growth(window, retained)
  }

  public accept(
    tokens: number,
    segment: Optional<ActFrameSegment>,
    retained = false,
    inputTokens?: number
  ): void {
    this.sinceFold++
    // 准入估算会随校准改变；两个不同估算比例之差不是请求正文的真实增长。
    const measured = Number.isSafeInteger(inputTokens) && inputTokens! > 0
    const sampled = measured ? inputTokens! : tokens
    if (
      segment &&
      this.last?.segment === segment.id &&
      this.last.revision === segment.revision &&
      this.last.retained === retained &&
      this.last.measured === measured &&
      sampled > this.last.tokens
    )
      this.increases = {
        ...this.increases,
        [retained ? 'retained' : 'plain']: [
          ...this.increases[retained ? 'retained' : 'plain'],
          sampled - this.last.tokens,
        ].slice(-ContextPlanTuning.growthSamples),
      }
    this.last = segment
      ? { tokens: sampled, segment: segment.id, revision: segment.revision, retained, measured }
      : undefined
  }

  public folded(): void {
    this.shortFold = this.sinceFold < this.policy.foldTurns
    this.sinceFold = 0
    // 上一段的大读取已被封存；沿用它会让新段反复被预测为只剩一轮，无法收集新的增长样本。
    this.increases = { plain: [], retained: [] }
    this.last = undefined
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
