import type { LanguageModel, ModelMessage } from 'ai'

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
  private overheads: readonly number[] = []
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
    const calibrated = Boolean(counter && this.overheads.length && generation === this.generation)
    const overhead = Math.max(0, ...this.overheads)
    const estimate = estimateRequestInput(request, restored, (text, bytes) => {
      textTokens = counter?.(text)
      return calibrated
        ? Math.ceil((textTokens! + overhead) * ModelTuning.estimate.calibrationMargin)
        : bytes
    })
    if (calibrated)
      Object.assign(estimate, {
        calibration: 'provider-usage',
        basis: `文本按 ${this.encoding} 计量，同一路由 ${this.overheads.length} 份实测输入校准额外开销并保留余量；图片与不透明状态独立预留，非供应商精确计数`,
      })
    return { estimate, textTokens, generation }
  }

  public record(sample: ModelInputSample, inputTokens: number): void {
    if (
      sample.generation !== this.generation ||
      sample.textTokens === undefined ||
      sample.estimate.images?.count ||
      !Number.isSafeInteger(inputTokens) ||
      inputTokens <= 0
    )
      return
    // 不透明状态可能只被部分计入，不从真实输入中扣除；额外开销保留为上界。
    this.overheads = [...this.overheads, Math.max(0, inputTokens - sample.textTokens)].slice(
      -ModelTuning.estimate.calibrationSamples
    )
  }

  public reset(): void {
    this.generation++
    this.overheads = []
  }
}
