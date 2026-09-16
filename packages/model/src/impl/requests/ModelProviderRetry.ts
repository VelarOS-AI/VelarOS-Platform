import type { ModelProviderRetryDecision, ModelProviderRetryOptions } from '../../types/model'
import { planProviderRetry, waitForRetry } from '../../utils/retry'

/** 只把能安全当成瞬时传输/服务端故障的失败判成可重试；判不出来就返回 null。 */
export function planModelProviderRetry(
  error: unknown,
  options: ModelProviderRetryOptions,
): Nullable<ModelProviderRetryDecision> {
  return planProviderRetry(error, options)
}

/** 等一次退避；等待期间被取消就把取消原因抛出去。 */
export async function waitForModelRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  return waitForRetry(delayMs, signal)
}
