import { Log } from '@velaros-ai/core'
import { isPlainObject, isString, isUndefined } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { ModelDriver, ModelTurnDelta, ModelTurnRequest } from '@velaros-ai/kernel'
import { modelRequestEncoder } from '@velaros-ai/kernel'

/** 先校验供应商事实，再交给持久账本；取消也不能绕过协议检查。 */
function checkUsage(delta: Extract<ModelTurnDelta, { type: 'usage' }>): void {
  if (
    ![delta.inputTokens, delta.outputTokens].every(
      (value) => Number.isSafeInteger(value) && value >= 0
    ) ||
    !Number.isSafeInteger(delta.inputTokens + delta.outputTokens) ||
    [delta.cacheReadTokens, delta.cacheWriteTokens].some(
      (value) => !isUndefined(value) && (!Number.isSafeInteger(value) || value < 0)
    ) ||
    (delta.cacheReadTokens ?? 0) + (delta.cacheWriteTokens ?? 0) > delta.inputTokens
  )
    throw new AppError('PROTOCOL', '模型用量不符合实际计数契约')
}

/** 模型准备阶段也服从运行期限，驱动估算不能无限阻塞取消。 */
export async function boundedModelOperation<T>(
  pending: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  let cancel: () => void = () => {}
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

/** 即使驱动没有及时响应取消，也不允许迟到的响应进入任务状态。 */
export async function* boundedModelStream(
  driver: ModelDriver,
  request: ModelTurnRequest,
  signal: AbortSignal,
  beforeDispatch?: () => Promise<void>,
  onUsage?: (usage: Extract<ModelTurnDelta, { type: 'usage' }>) => Promise<void>
): AsyncIterable<ModelTurnDelta> {
  // 保留直接驱动的增量顺序；增加生成器转发层会改变同步取消与 usage 的先后。
  let dispatched = false
  let registration: Promise<void> | undefined
  const dispatch = () =>
    (registration ??= (async () => {
      signal.throwIfAborted()
      await beforeDispatch?.()
      dispatched = true
    })())
  if (!driver.dispatchAware) await dispatch()
  const iterator = driver
    .stream(request, signal, driver.dispatchAware ? dispatch : undefined)
    [Symbol.asyncIterator]()
  try {
    for (;;) {
      signal.throwIfAborted()
      let cancel: () => void = () => {}
      const aborted = new Promise<never>((_resolve, reject) => {
        cancel = () => reject(signal.reason ?? new AppError('CANCELLED', '模型调用已取消'))
        signal.addEventListener('abort', cancel, { once: true })
      })
      let result: IteratorResult<ModelTurnDelta>
      let receivedUsage: Extract<ModelTurnDelta, { type: 'usage' }> | undefined
      let recordedUsage: Promise<void> | undefined
      try {
        const pending = iterator.next().then(async (next) => {
          if (!next.done && !dispatched)
            throw new AppError('PROTOCOL', '模型驱动在派发确认前返回响应')
          // 取消后的用量是已经发生的请求事实；按原身份记账，不恢复任务或执行响应。
          if (!next.done && next.value?.type === 'usage') {
            checkUsage(next.value)
            receivedUsage = next.value
            recordedUsage = onUsage?.(next.value) ?? Promise.resolve()
            await recordedUsage
          }
          return next
        })
        result = await Promise.race([pending, aborted])
      } catch (error) {
        if (signal.aborted && receivedUsage) {
          await recordedUsage
          yield receivedUsage
        }
        throw error
      } finally {
        signal.removeEventListener('abort', cancel)
      }
      if (result.done) {
        signal.throwIfAborted()
        return
      }
      const delta = result.value
      // 取消后已取到的用量仍是本次请求事实；其他增量不能再进入任务状态。
      if (delta?.type !== 'usage') signal.throwIfAborted()
      if (
        !delta ||
        ![
          'output',
          'text',
          'tool-call',
          'reasoning',
          'continuation',
          'usage',
          'error',
          'finish',
        ].includes(delta.type)
      )
        throw new AppError('PROTOCOL', '模型响应包含契约之外的事件')
      if (delta.type === 'text' && (request.response.type === 'json' || !isString(delta.text)))
        throw new AppError('PROTOCOL', '模型文本增量不符合响应模式')
      if (delta.type === 'reasoning' && !isString(delta.text))
        throw new AppError('PROTOCOL', '模型思考增量不是文本')
      if (delta.type === 'continuation') {
        modelRequestEncoder.continuation(delta.value)
        if (request.response.type === 'json' || delta.value.model !== driver.id)
          throw new AppError('PROTOCOL', '模型延续状态与当前请求不匹配')
      }
      if (
        delta.type === 'tool-call' &&
        (request.response.type !== 'tools' ||
          !isPlainObject(delta.value) ||
          !isString(delta.value.id) ||
          !isString(delta.value.name))
      )
        throw new AppError('PROTOCOL', '模型工具调用与当前请求不匹配')
      if (delta.type === 'output' && request.response.type !== 'json')
        throw new AppError('PROTOCOL', '文本模式不能返回结构化响应事件')
      if (delta.type === 'finish' && !['stop', 'length'].includes(delta.reason))
        throw new AppError('PROTOCOL', '模型响应结束原因不符合契约')
      yield delta.type === 'output'
        ? { type: 'output', value: modelRequestEncoder.output(request.response, delta.value) }
        : delta.type === 'continuation'
          ? { type: 'continuation', value: modelRequestEncoder.continuation(delta.value) }
          : delta
    }
  } finally {
    void Promise.resolve(iterator.return?.()).catch(() => {
      Log.tag('ActRuntime').debug('model-stream 已进入异常处理或降级分支')
    })
  }
}
