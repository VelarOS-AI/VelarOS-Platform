import { toOptional } from './nullish'
import { TimerScope } from './TimerScope'

/** 宿主可注入支持 AbortSignal 的 Fetch 实现。 */
export type FetchTransport = (url: string | URL, init?: RequestInit) => Promise<Response>

export interface FetchTimeoutOptions {
  readonly timeoutMs: number
  readonly timeoutMessage?: string
  readonly fetch?: FetchTransport
}

/**
 * 在同一截止时间内发送请求并消费响应正文；状态码与解析规则由调用方决定。
 * consume 必须在返回前完成正文读取。调用方取消和超时都会中止底层 Fetch。
 */
export async function fetchWithTimeout<T>(
  url: string | URL,
  init: RequestInit,
  consume: (response: Response) => T | Promise<T>,
  options: FetchTimeoutOptions
): Promise<T> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)
    throw new RangeError('Fetch timeout must be a finite non-negative number')
  const timers = new TimerScope({ name: 'fetchWithTimeout' })
  try {
    return await timers.withTimeout(
      options.timeoutMs,
      async (signal) => {
        const response = await (options.fetch ?? fetch)(url, { ...init, signal })
        signal.throwIfAborted()
        return consume(response)
      },
      {
        signal: toOptional(init.signal),
        timeoutMessage: options.timeoutMessage,
      }
    )
  } finally {
    timers.dispose()
  }
}
