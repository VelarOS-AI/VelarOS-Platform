import type { TextStreamPart, ToolSet } from 'ai'

import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type { ReadNextStreamPartIdleTimeoutOptions } from '../../types/loop.js'
import { DefaultAgentExecutionLimits } from '../loop/execution-limits'

const DefaultStreamIdleStallTimeoutMs =
  DefaultAgentExecutionLimits.modelStreamIdleTimeoutMs
const log = logRuntime.tag('StreamIdleReader')

/**
 * 读模型流的下一个分片，并给「两个分片之间的静默」加一道上限。
 *
 * 针对的供应方行为：连接还开着、TCP 层没断，但服务端再也不发新分片——`for await` 会无限期挂住，
 * 整轮既不成功也不失败。这里让 `iterator.next()` 与一个空闲计时器、一个中止信号三方赛跑：
 * 计时器先到就抛 `MODEL_STREAM_STALLED`（上下文带 source/turn/model/requestFingerprint 便于定位是哪次请求），
 * 中止先到就返回 `{ done: true }` 当正常收流。**计时器每次调用重开**，所以量的是"距上一个分片的间隔"而非整流总时长。
 * 超时与中止两条路都会顺手把迭代器静默关掉，避免上游连接泄漏；正常拿到分片时不动它，由调用方继续读。
 * `idleStallTimeoutMs` 非正数或非有限值时不挂计时器，退化成只受中止信号约束的普通读。
 */
async function readNextStreamPartWithIdleTimeout<TPart = TextStreamPart<ToolSet>>(
  iterator: AsyncIterator<TPart>,
  options: ReadNextStreamPartIdleTimeoutOptions
): Promise<IteratorResult<TPart>> {
  if (options.abortSignal.aborted) return { done: true, value: undefined }

  const cleanup: Array<() => void> = []
  let didTimeout = false
  let didAbort = false
  const timeoutMs = options.idleStallTimeoutMs ?? DefaultStreamIdleStallTimeoutMs
  const racers: Array<Promise<IteratorResult<TPart>>> = [iterator.next()]
  const timers = new TimerScope({ name: options.timerName })
  cleanup.push(() => timers.dispose())

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    racers.push(new Promise<IteratorResult<TPart>>((_resolve, reject) => {
      timers.after(timeoutMs, () => {
        didTimeout = true
        reject(new AppError(
          'MODEL_STREAM_STALLED',
          `模型流已超过 ${timeoutMs}ms 没有返回新数据，已中止本轮请求。`,
          undefined,
          {
            source: options.source,
            turn: options.turn,
            model: options.model,
            idleTimeoutMs: timeoutMs,
            requestFingerprint: options.requestFingerprint,
          }
        ))
      }, {
        label: options.source,
        signal: options.abortSignal,
      })
    }))
  }

  racers.push(new Promise<IteratorResult<TPart>>((resolve) => {
    const onAbort = (): void => {
      didAbort = true
      resolve({ done: true, value: undefined })
    }
    options.abortSignal.addEventListener('abort', onAbort, { once: true })
    cleanup.push(() => options.abortSignal.removeEventListener('abort', onAbort))
  }))

  try {
    const result = await Promise.race(racers)
    if (didAbort) {
      void returnStreamIteratorQuietly(iterator, options.source)
    }
    return result
  } catch (error) {
    if (didTimeout) {
      void returnStreamIteratorQuietly(iterator, options.source)
    }
    throw error
  } finally {
    for (const dispose of cleanup) dispose()
  }
}

/**
 * 尽力关掉一条不再读的模型流迭代器（调用它的 `return()`），失败只记 warn 不抛。
 * 它总是在"本轮已经因超时或中止收场"之后才被调用，清理过程再抛异常只会盖掉真正的失败原因；
 * 迭代器没有实现 `return` 时什么也不做。
 */
async function returnStreamIteratorQuietly<TPart>(
  iterator: AsyncIterator<TPart>,
  source: string
): Promise<void> {
  try {
    await iterator.return?.()
  } catch (error) {
    log.warn('stream iterator cleanup failed', {
      source,
      error: AppError.getMessage(error),
    })
  }
}

export {
  DefaultStreamIdleStallTimeoutMs,
  readNextStreamPartWithIdleTimeout,
  returnStreamIteratorQuietly,
}
