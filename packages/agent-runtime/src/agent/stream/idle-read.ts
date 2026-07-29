import type { TextStreamPart, ToolSet } from 'ai'

import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import { DefaultAgentExecutionLimits } from '../ExecutionLimits'

const DefaultStreamIdleStallTimeoutMs =
  DefaultAgentExecutionLimits.modelStreamIdleTimeoutMs
const log = logRuntime.tag('StreamIdleReader')

interface ReadNextStreamPartIdleTimeoutOptions {
  abortSignal: AbortSignal
  idleStallTimeoutMs?: LooseOptional<number>
  model: string
  requestFingerprint?: unknown
  source: string
  timerName: string
  turn: Nullable<number>
}

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
        unref: true,
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
export type { ReadNextStreamPartIdleTimeoutOptions }
