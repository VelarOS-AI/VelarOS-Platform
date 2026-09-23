import { Log } from '@velaros-ai/core'
import { toNullable } from '@velaros-ai/core'
import { isEmpty } from '@velaros-ai/core'
import type {
  ModelDriverLimits,
  ModelInputEstimate,
  ModelTurnDelta,
  ModelTurnRequest,
} from '@velaros-ai/kernel'
import type { ModelDriver } from '@velaros-ai/model'

import type { ModelBudgetPort } from '../types/model-budget.js'
import type { ModelToolModelProfile, ModelToolModelUsage } from '../types/model-tools.js'
import { reservedModelStream } from '../utils/model-budget.js'

/** 单一职责模型工具共用的有界模型调用依赖。 */
export interface ModelToolActivationOptions {
  /** 当前调用的有限档位。 */
  readonly profile: ModelToolModelProfile
  /** 同一 Provider 驱动及实际请求队列。 */
  readonly model: ModelDriver
  /** 调用者已经预留 finalizationTokens 的祖先总账。 */
  readonly parent: ModelBudgetPort
  /** 独立活动的绝对硬期限，发布阶段由调用者另行预留。 */
  readonly deadline: number
}

/** 搜索和上下文维护共用的软收尾、硬上限及计费控制。 */
export interface ModelToolActivationApi extends ModelDriver {
  /** 真实模型身份。 */
  readonly id: string
  /** 当前阶段可用于编译请求的窗口，收尾阶段受已预留额度约束。 */
  readonly limits: ModelDriverLimits
  /** 关闭后的取消权。 */
  readonly signal: AbortSignal
  /** 编译器使用同一估算口。 */
  estimate(request: ModelTurnRequest): Promise<ModelInputEstimate>
  /** 真实派发前检查预算，完整用量向祖先结算一次。 */
  stream(request: ModelTurnRequest, signal: AbortSignal): AsyncIterable<ModelTurnDelta>
  /** 专项来源或读取预算触发软收尾。 */
  finalize(reason: string): void
  /** 下一请求是否应直接交付结果。 */
  finalizing(): boolean
  /** 当前已接受响应是否仍可展开工作。 */
  canExplore(): boolean
  /** 当前单请求截止时间。 */
  deadline(): number
  /** 可审计的实际及保守预留用量。 */
  usage(): ModelToolModelUsage
  /** 取消迟到派发、结算并归还未使用的最后一轮预留。 */
  close(): Promise<void>
}

/** 资源限制只围绕模型调用，业务证据和补丁规则留在各工具中。 */
export class ModelToolActivation implements ModelToolActivationApi {
  public readonly id: string
  public get limits(): ModelDriverLimits {
    const limits = this.options.model.limits
    if (!this.finalizing()) return limits
    const available = Math.max(
      0,
      Math.min(
        this.options.profile.finalizationTokens,
        this.options.profile.modelTokens - this.reserved
      )
    )
    return {
      ...limits,
      contextTokens: Math.min(limits.contextTokens, available),
      inputTokens: Math.min(limits.inputTokens, available),
    }
  }
  private readonly lifetime = new AbortController()
  public readonly signal = this.lifetime.signal
  private readonly accounting = new Set<Promise<void>>()
  private calls = 0
  private reserved = 0
  private measured = 0
  private input = 0
  private output = 0
  private finalUsed = false
  private responseFinalizing = false
  private reason?: string
  private closing?: Promise<void>

  public constructor(private readonly options: ModelToolActivationOptions) {
    this.id = options.model.id
  }
  public estimate(request: ModelTurnRequest) {
    return this.options.model.estimate(request)
  }
  public finalize(reason: string): void {
    this.reason ??= reason
  }
  public finalizing(): boolean {
    const { profile, deadline } = this.options
    return (
      Boolean(this.reason) ||
      this.calls >= profile.modelCalls - 1 ||
      Date.now() + profile.callTimeoutMs + profile.finalizationMs >= deadline ||
      this.reserved + profile.finalizationTokens >= profile.modelTokens
    )
  }
  public canExplore(): boolean {
    return (
      !this.signal.aborted &&
      !this.responseFinalizing &&
      Date.now() < this.options.deadline - this.options.profile.finalizationMs
    )
  }
  public deadline(): number {
    return Math.min(
      this.options.deadline,
      Date.now() +
        (this.finalizing()
          ? this.options.profile.finalizationMs
          : this.options.profile.callTimeoutMs)
    )
  }
  public usage(): ModelToolModelUsage {
    return {
      calls: this.calls,
      reservedTokens: this.reserved,
      measuredCalls: this.measured,
      inputTokens: this.input,
      outputTokens: this.output,
      finalUsed: this.finalUsed,
      reason: toNullable(this.reason),
    }
  }

  public async *stream(
    request: ModelTurnRequest,
    signal: AbortSignal
  ): AsyncIterable<ModelTurnDelta> {
    const { profile, parent, deadline } = this.options
    const combined = AbortSignal.any([
      signal,
      this.signal,
      AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    ])
    combined.throwIfAborted()
    if (this.finalUsed || this.calls >= profile.modelCalls || Date.now() >= deadline)
      throw Object.assign(new Error('模型工具已达到硬上限'), { code: 'MODEL_TOOL_LIMIT' })
    const finalizing = this.finalizing()
    const estimate = await this.estimate(request)
    const tokens = estimate.tokens + request.outputTokens
    combined.throwIfAborted()
    if (!finalizing && this.reserved + tokens + profile.finalizationTokens > profile.modelTokens) {
      this.finalize('token-budget')
      throw Object.assign(new Error('普通请求将占用收尾额度，请重新编译最后交付轮'), {
        code: 'CONTEXT_BUDGET',
      })
    }
    if (
      this.reserved + tokens > profile.modelTokens ||
      (finalizing && tokens > profile.finalizationTokens)
    )
      throw Object.assign(new Error('本次模型工具 token 预算不足'), { code: 'CONTEXT_BUDGET' })
    if (!finalizing) {
      yield* reservedModelStream(
        parent,
        tokens,
        combined,
        () => this.dispatch(request, combined, tokens, false),
        this.accounting
      )
    } else yield* this.dispatch(request, combined, tokens, true)
  }

  private async *dispatch(
    request: ModelTurnRequest,
    signal: AbortSignal,
    tokens: number,
    finalizing: boolean
  ): AsyncIterable<ModelTurnDelta> {
    this.responseFinalizing = finalizing
    if (finalizing) this.finalUsed = true
    this.reserved += tokens
    this.calls++
    const { profile, parent, deadline } = this.options
    const bounded = AbortSignal.any([
      signal,
      AbortSignal.timeout(
        Math.max(
          1,
          Math.min(
            finalizing ? profile.finalizationMs : profile.callTimeoutMs,
            deadline - Date.now()
          )
        )
      ),
    ])
    let measured = false
    for await (const event of this.options.model.stream(request, bounded)) {
      bounded.throwIfAborted()
      if (event.type === 'usage') {
        if (measured) throw new Error('模型工具重复返回用量')
        measured = true
        this.measured++
        this.input += event.inputTokens
        this.output += event.outputTokens
        const settled = parent.recordUsage(event.inputTokens, event.outputTokens)
        this.accounting.add(settled)
        await settled
      }
      yield event
    }
  }

  public close(): Promise<void> {
    if (!this.closing) {
      this.lifetime.abort()
      this.closing = this.settle()
    }
    return this.closing
  }
  private async settle(): Promise<void> {
    const failures = (await Promise.allSettled([...this.accounting])).flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    )
    try {
      if (!this.finalUsed)
        await this.options.parent.releaseModel('context', this.options.profile.finalizationTokens)
    } catch (error) {
      Log.tag('ActRuntime').debug('ModelToolActivation 已进入异常处理或降级分支')
      failures.push(error)
    }
    if (failures.length === 1) throw failures[0]
    if (!isEmpty(failures)) throw new AggregateError(failures, '模型工具预算结算失败')
  }
}
