import { isUndefined } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { ModelTurnDelta, ModelTurnRequest } from '@velaros-ai/kernel'

import type { ModelDriver } from '../../contract/requires.js'

/** 调用者的持久派发登记与驱动实际开始保持同一顺序。 */
export interface ModelRequestDispatcherApi {
  /** 新驱动在准备完成后确认；旧驱动在调用入口保守确认，未知用量不退款。 */
  stream(
    driver: ModelDriver,
    request: ModelTurnRequest,
    signal: AbortSignal,
    beforeDispatch?: () => Promise<void>
  ): AsyncIterable<ModelTurnDelta>
}

/** 包装器转发同一登记链，队列取消和准备失败不会被当成模型派发。 */
class ModelRequestDispatcher implements ModelRequestDispatcherApi {
  public async *stream(
    driver: ModelDriver,
    request: ModelTurnRequest,
    signal: AbortSignal,
    beforeDispatch?: () => Promise<void>
  ): AsyncIterable<ModelTurnDelta> {
    let dispatched = false
    let registration: Promise<void> | undefined
    const dispatch = () =>
      (registration ??= (async () => {
        signal.throwIfAborted()
        await beforeDispatch?.()
        dispatched = true
      })())
    if (!driver.dispatchAware) await dispatch()
    for await (const delta of driver.stream(request, signal, dispatch)) {
      if (!dispatched) throw new AppError('PROTOCOL', '模型驱动在派发确认前返回响应')
      if (
        delta.type === 'usage' &&
        (![delta.inputTokens, delta.outputTokens].every(
          (value) => Number.isSafeInteger(value) && value >= 0
        ) ||
          !Number.isSafeInteger(delta.inputTokens + delta.outputTokens) ||
          [delta.cacheReadTokens, delta.cacheWriteTokens].some(
            (value) => !isUndefined(value) && (!Number.isSafeInteger(value) || value < 0)
          ) ||
          (delta.cacheReadTokens ?? 0) + (delta.cacheWriteTokens ?? 0) > delta.inputTokens)
      )
        throw new AppError('PROTOCOL', '模型用量不符合实际计数契约')
      yield delta
    }
  }
}

export const modelRequestDispatcher: ModelRequestDispatcherApi = new ModelRequestDispatcher()
