import { Log } from '@velaros-ai/core'
import { isPlainObject, isString, isUndefined } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { ModelDriver, ModelTurnDelta, ModelTurnRequest } from '@velaros-ai/kernel'
import { modelRequestEncoder } from '@velaros-ai/kernel'

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
  signal: AbortSignal
): AsyncIterable<ModelTurnDelta> {
  const iterator = driver.stream(request, signal)[Symbol.asyncIterator]()
  try {
    for (;;) {
      signal.throwIfAborted()
      let cancel: () => void = () => {}
      const aborted = new Promise<never>((_resolve, reject) => {
        cancel = () => reject(signal.reason ?? new AppError('CANCELLED', '模型调用已取消'))
        signal.addEventListener('abort', cancel, { once: true })
      })
      let result: IteratorResult<ModelTurnDelta>
      try {
        result = await Promise.race([iterator.next(), aborted])
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
      if (
        delta.type === 'usage' &&
        (![delta.inputTokens, delta.outputTokens].every(
          (value) => Number.isSafeInteger(value) && value >= 0
        ) ||
          [delta.cacheReadTokens, delta.cacheWriteTokens].some(
            (value) => !isUndefined(value) && (!Number.isSafeInteger(value) || value < 0)
          ) ||
          (delta.cacheReadTokens ?? 0) + (delta.cacheWriteTokens ?? 0) > delta.inputTokens)
      )
        throw new AppError('PROTOCOL', '模型用量不符合实际计数契约')
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
