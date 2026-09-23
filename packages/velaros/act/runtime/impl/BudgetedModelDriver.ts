import { isEmpty } from '@velaros-ai/core'
import type {
  ModelDriverLimits,
  ModelInputEstimate,
  ModelTurnDelta,
  ModelTurnRequest,
} from '@velaros-ai/kernel'
import type { ModelDriver } from '@velaros-ai/model'

import type { BudgetedModelOptions } from '../types/model-budget.js'
import { reservedModelStream } from '../utils/model-budget.js'

/** 与 Kernel 驱动一致，附加父任务预算的内部驱动。 */
export interface BudgetedModelDriverApi extends ModelDriver {
  /** 取消迟到派发，等待已开始的父预算结算。 */
  close(): Promise<void>
  /** 真实模型身份。 */
  readonly id: string
  /** 真实窗口限制。 */
  readonly limits: ModelDriverLimits
  /** 估算最终请求。 */
  estimate(request: ModelTurnRequest): Promise<ModelInputEstimate>
  /** 调用前预留父预算，并记录一次真实用量。 */
  stream(request: ModelTurnRequest, signal: AbortSignal): AsyncIterable<ModelTurnDelta>
}

/** 子调用在真实发送前原子预留父预算，续跑沿用同一总账。 */
export class BudgetedModelDriver implements BudgetedModelDriverApi {
  public readonly id: string
  private readonly lifetime = new AbortController()
  private readonly accounting = new Set<Promise<void>>()
  private closing?: Promise<void>
  public readonly limits
  public constructor(private readonly options: BudgetedModelOptions) {
    this.id = options.model.id
    this.limits = options.model.limits
  }
  public estimate(request: ModelTurnRequest) {
    return this.options.model.estimate(request)
  }
  public async *stream(
    request: ModelTurnRequest,
    signal: AbortSignal
  ): AsyncIterable<ModelTurnDelta> {
    const combined = AbortSignal.any([signal, this.options.signal, this.lifetime.signal])
    combined.throwIfAborted()
    const estimate = await this.estimate(request)
    combined.throwIfAborted()
    yield* reservedModelStream(
      this.options.parent,
      estimate.tokens + request.outputTokens,
      combined,
      () => this.dispatch(request, combined),
      this.accounting
    )
  }
  public close(): Promise<void> {
    if (!this.closing) {
      this.lifetime.abort()
      this.closing = Promise.allSettled([...this.accounting]).then((results) => {
        const failures = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : []
        )
        if (!isEmpty(failures)) throw new AggregateError(failures, '子模型预算结算失败')
      })
    }
    return this.closing
  }
  private async *dispatch(
    request: ModelTurnRequest,
    combined: AbortSignal
  ): AsyncIterable<ModelTurnDelta> {
    let measured = false
    for await (const event of this.options.model.stream(request, combined)) {
      combined.throwIfAborted()
      if (event.type === 'usage') {
        if (measured) throw new Error('子模型重复用量')
        measured = true
        const recorded = this.options.parent.recordUsage(event.inputTokens, event.outputTokens)
        this.accounting.add(recorded)
        await recorded
      }
      yield event
    }
  }
}
