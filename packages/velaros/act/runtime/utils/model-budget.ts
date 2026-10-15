import { isArray, isEmpty, isNumber, isPlainObject, isString, Log } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { ModelTurnDelta } from '@velaros-ai/kernel'
import { modelProviderRetry } from '@velaros-ai/model'

import type { ModelBudgetPort, ModelBudgetSettlement } from '../types/model-budget.js'

import { ActRuntimeTuning } from './tuning.js'

/** 持久回执只能重放到原根任务及其显式祖先，损坏回执不能变成预算事实。 */
export function readModelBudgetSettlement(
  value: unknown,
  rootSessionId: string
): ModelBudgetSettlement {
  const identity = (id: unknown): id is string => isString(id) && id.length > 0 && id.length <= 256
  const tokenCount = (count: unknown): count is number =>
    isNumber(count) && Number.isSafeInteger(count) && count >= 0
  if (
    !isPlainObject(value) ||
    !identity(value.requestId) ||
    !identity(value.rootTaskId) ||
    value.rootSessionId !== rootSessionId ||
    !tokenCount(value.inputTokens) ||
    !tokenCount(value.outputTokens) ||
    !Number.isSafeInteger(value.inputTokens + value.outputTokens) ||
    (value.status !== 'pending' && value.status !== 'settled' && value.status !== 'archived') ||
    !isArray(value.targets) ||
    isEmpty(value.targets)
  )
    throw new AppError('TASK_STATE', '模型结算回执无效')
  const receipt: ModelBudgetSettlement = {
    requestId: value.requestId,
    rootSessionId,
    rootTaskId: value.rootTaskId,
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    status: value.status,
    targets: value.targets.map((target) => {
      if (!isPlainObject(target) || !identity(target.sessionId) || !identity(target.taskId))
        throw new AppError('TASK_STATE', '模型结算回执无效')
      return { sessionId: target.sessionId, taskId: target.taskId }
    }),
  }
  if (
    new Set(receipt.targets.map((target) => target.sessionId)).size !== receipt.targets.length ||
    !receipt.targets.some(
      (target) => target.sessionId === rootSessionId && target.taskId === receipt.rootTaskId
    )
  )
    throw new AppError('TASK_STATE', '模型结算回执祖先归属无效')
  return receipt
}

/** 只读模型准备可立即取消；迟到结果不会进入后续发布流程。 */
export async function awaitModelPreparation<T>(
  pending: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  let cancel!: () => void
  const aborted = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(signal.reason ?? new AppError('CANCELLED', '模型准备已取消'))
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
  })
  try {
    return await Promise.race([pending, aborted])
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}

/** 预留完成后再次检查取消，只归还确认预留但尚未派发的模型调用。 */
export async function* reservedModelStream(
  parent: ModelBudgetPort,
  tokens: number,
  signal: AbortSignal,
  dispatch: (beforeDispatch: () => Promise<void>) => AsyncIterable<ModelTurnDelta>,
  accounting?: Set<Promise<void>>,
  requestId?: string,
  beforeDispatch?: () => Promise<void>
): AsyncIterable<ModelTurnDelta> {
  signal.throwIfAborted()
  let resolve!: () => void
  let reject!: (reason: unknown) => void
  const settled = new Promise<void>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  accounting?.add(settled)
  void settled.catch(() => {
    Log.tag('ActRuntime').debug('model-budget 已进入异常处理或降级分支')
  })
  let reserved = false
  let dispatched = false
  try {
    // 父任务到了每小时用量上限就等窗口释放后再预留，不算失败
    for (;;)
      try {
        await parent.reserveModel('context', tokens, requestId)
        break
      } catch (error) {
        if ((error as { code?: string }).code !== 'MODEL_RATE') throw error
        await modelProviderRetry.wait(
          (error as { retryAfterMs?: number }).retryAfterMs ?? ActRuntimeTuning.rateRetryMs,
          signal
        )
      }
    reserved = true
    signal.throwIfAborted()
  } catch (error) {
    if (reserved)
      try {
        await parent.releaseModel('context', tokens, requestId, true)
      } catch (release) {
        const failure = Object.assign(
          new AggregateError([error, release], '模型调用未派发，但预算归还失败'),
          { code: 'MODEL_RESERVATION_RELEASE' }
        )
        reject(failure)
        throw failure
      }
    resolve()
    throw error
  }
  let refund: Promise<void> | undefined
  const release = () => {
    refund ??= parent.releaseModel('context', tokens, requestId, true).then(resolve, (error) => {
      reject(error)
      throw error
    })
    return refund
  }
  const cancelled = () => {
    if (!dispatched)
      void release().catch(() => {
        Log.tag('ActRuntime').debug('模型取消后的预算归还失败，关闭时返回结算错误')
      })
  }
  signal.addEventListener('abort', cancelled, { once: true })
  if (signal.aborted) cancelled()
  try {
    yield* dispatch(async () => {
      signal.throwIfAborted()
      if (requestId) await parent.dispatchModel?.(requestId)
      signal.throwIfAborted()
      await beforeDispatch?.()
      signal.throwIfAborted()
      dispatched = true
      resolve()
    })
  } finally {
    signal.removeEventListener('abort', cancelled)
    if (!dispatched) await release()
  }
}
