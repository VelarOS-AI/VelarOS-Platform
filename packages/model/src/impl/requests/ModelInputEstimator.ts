import type { LanguageModel, ModelMessage } from 'ai'

import { isEmpty, isUndefined } from '@velaros-ai/core'

import type { ModelTurnRequest } from '../../types/driver.js'
import type { ModelInputSample, ModelTextEncoding } from '../../types/requests.js'
import { estimateRequestInput, modelTextEncoding } from '../../utils/request-estimate.js'
import { ModelTuning } from '../../utils/tuning.js'

/** 同一供应商实例的容量计量；主线和专项会话共用实际开销，不增加模型请求。 */
export interface ModelInputEstimatorApi {
  /** 计量将发送的同源文本，保留图片、字节分项和独立不透明容量。 */
  prepare(
    request: ModelTurnRequest,
    restored: { messages: readonly ModelMessage[]; opaqueTokens: number }
  ): Promise<ModelInputSample>
  /** 只采纳这一代无图片请求的实际输入用量。 */
  record(sample: ModelInputSample, inputTokens: number): void
  /** 上游超窗后恢复字节估算，迟到旧响应不能重新建立旧校准。 */
  reset(): void
}

export class ModelInputEstimator implements ModelInputEstimatorApi {
  private readonly encoding?: ModelTextEncoding
  private counter?: Promise<(text: string) => number>
  private samples: ReadonlyArray<{ text: number; input: number }> = []
  private generation = 0

  public constructor(model: LanguageModel) {
    this.encoding = modelTextEncoding(model)
  }

  public async prepare(
    request: ModelTurnRequest,
    restored: { messages: readonly ModelMessage[]; opaqueTokens: number }
  ): Promise<ModelInputSample> {
    const generation = this.generation
    if (this.encoding && !this.counter)
      this.counter = (
        this.encoding === 'o200k_base'
          ? import('gpt-tokenizer/encoding/o200k_base')
          : import('gpt-tokenizer/encoding/cl100k_base')
      ).then(
        ({ countTokens }) =>
          (text: string) =>
            countTokens(text, { disallowedSpecial: new Set() })
      )
    const counter = await this.counter
    let textTokens: Optional<number>
    const calibrated = Boolean(counter && !isEmpty(this.samples) && generation === this.generation)
    const estimate = estimateRequestInput(request, restored, (text, bytes) => {
      textTokens = counter?.(text)
      return calibrated
        ? Math.ceil(this.textBound(textTokens!) * ModelTuning.estimate.calibrationMargin)
        : bytes
    })
    if (calibrated)
      Object.assign(estimate, {
        calibration: 'provider-usage',
        basis: `文本按 ${this.encoding} 计量，同一路由 ${this.samples.length} 份实测输入校准开销上界；已见长度内比较增长与固定开销并保留余量，图片与不透明状态独立预留，非供应商精确计数`,
      })
    return { estimate, textTokens, generation }
  }

  public record(sample: ModelInputSample, inputTokens: number): void {
    if (
      sample.generation !== this.generation ||
      isUndefined(sample.textTokens) ||
      sample.estimate.images?.count ||
      !Number.isSafeInteger(inputTokens) ||
      inputTokens <= 0
    )
      return
    // 不透明状态可能只被部分计入，不从真实输入中扣除；两种拟合都覆盖完整实测输入。
    this.samples = [...this.samples, { text: sample.textTokens, input: inputTokens }].slice(
      -ModelTuning.estimate.calibrationSamples
    )
  }

  public reset(): void {
    this.generation++
    this.samples = []
  }

  /** 已见长度范围内比较两种覆盖全部样本的上界；范围外沿用固定开销，不外推增长趋势。 */
  private textBound(text: number): number {
    const samples = this.samples
    const fixed = text + Math.max(0, ...samples.map((sample) => sample.input - sample.text))
    if (
      text < Math.min(...samples.map((sample) => sample.text)) ||
      text > Math.max(...samples.map((sample) => sample.text))
    )
      return fixed
    const textMean = samples.reduce((sum, sample) => sum + sample.text, 0) / samples.length
    const inputMean = samples.reduce((sum, sample) => sum + sample.input, 0) / samples.length
    const variance = samples.reduce((sum, sample) => sum + (sample.text - textMean) ** 2, 0)
    if (!variance) return fixed
    const slope =
      samples.reduce(
        (sum, sample) => sum + (sample.text - textMean) * (sample.input - inputMean),
        0
      ) / variance
    if (!(slope > 0) || !Number.isFinite(slope)) return fixed
    const overhead = Math.max(0, ...samples.map((sample) => sample.input - slope * sample.text))
    return Math.min(fixed, Math.max(text, slope * text + overhead))
  }
}
