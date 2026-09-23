import { Log } from '@velaros-ai/core'
import { isString } from '@velaros-ai/core'
import type { ModelDriver, ModelTurnDelta, ModelTurnRequest } from '@velaros-ai/kernel'
import { modelRequestEncoder } from '@velaros-ai/kernel'

/** 模型准备阶段也服从运行期限，驱动估算不能无限阻塞取消。 */
export async function boundedModelOperation<T>(
  pending: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  let cancel: () => void = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(signal.reason ?? new Error('模型准备已取消'))
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
        cancel = () => reject(signal.reason ?? new Error('模型调用已取消'))
        signal.addEventListener('abort', cancel, { once: true })
      })
      let result: IteratorResult<ModelTurnDelta>
      try {
        result = await Promise.race([iterator.next(), aborted])
      } finally {
        signal.removeEventListener('abort', cancel)
      }
      signal.throwIfAborted()
      if (result.done) return
      const delta = result.value
      if (!delta || !['output', 'text', 'usage', 'error', 'finish'].includes(delta.type))
        throw new Error('模型响应包含契约之外的事件')
      if (delta.type === 'text' && (request.response.type !== 'text' || !isString(delta.text)))
        throw new Error('模型文本增量不符合响应模式')
      if (delta.type === 'output' && request.response.type !== 'json')
        throw new Error('文本模式不能返回结构化响应事件')
      if (delta.type === 'finish' && !['stop', 'length'].includes(delta.reason))
        throw new Error('模型响应结束原因不符合契约')
      yield delta.type === 'output'
        ? { type: 'output', value: modelRequestEncoder.output(request.response, delta.value) }
        : delta
    }
  } finally {
    void Promise.resolve(iterator.return?.()).catch(() => {
      Log.tag('ActRuntime').debug('model-stream 已进入异常处理或降级分支')
    })
  }
}
