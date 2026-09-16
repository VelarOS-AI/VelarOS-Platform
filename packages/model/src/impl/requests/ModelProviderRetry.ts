import type { ModelProviderRetryDecision, ModelProviderRetryOptions } from '../../types/model'
import { planProviderRetry, waitForRetry } from '../../utils/retry'

/**
 * 服务商瞬时失败的重试计划：判哪些失败值得再试一次、退避等多久。
 *
 * 判据保守：只把能安全当成瞬时传输或服务端故障的失败判成可重试，判不出来一律不重试——
 * 重试一个已经半执行的请求比失败更糟。实例是 `modelProviderRetry`。
 */
export interface ModelProviderRetryApi {
  /** 只把能安全当成瞬时传输/服务端故障的失败判成可重试；判不出来就返回 null。 */
  plan(
    error: unknown,
    options: ModelProviderRetryOptions
  ): Nullable<ModelProviderRetryDecision>
  /** 等一次退避；等待期间被取消就把取消原因抛出去。 */
  wait(delayMs: number, signal: AbortSignal): Promise<void>
}

export class ModelProviderRetry implements ModelProviderRetryApi {
  public plan(
    error: unknown,
    options: ModelProviderRetryOptions
  ): Nullable<ModelProviderRetryDecision> {
    return planProviderRetry(error, options)
  }

  public async wait(delayMs: number, signal: AbortSignal): Promise<void> {
    return waitForRetry(delayMs, signal)
  }
}

/** 整个进程共用的重试计划器：无状态。 */
export const modelProviderRetry: ModelProviderRetryApi = new ModelProviderRetry()
