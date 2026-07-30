import { AppError } from '@velaros-ai/core/error'

/**
 * CDP Tracing 采集器：与传输层解耦，供外部 CDP driver（WebSocket transport）
 * 和嵌入 webview（webContents.debugger）两条路径复用。
 *
 * trace 类别清单吸收自 chrome-devtools-mcp（与 DevTools Performance 面板 /
 * Lighthouse 保持同步），保证录出来的 trace 能被 DevTools trace 引擎完整解析。
 */

export const BrowserPerformanceTraceCategories = [
  '-*',
  'blink.console',
  'blink.user_timing',
  'devtools.timeline',
  'disabled-by-default-devtools.screenshot',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.invalidationTracking',
  'disabled-by-default-devtools.timeline.frame',
  'disabled-by-default-devtools.timeline.stack',
  'disabled-by-default-v8.cpu_profiler',
  'disabled-by-default-v8.cpu_profiler.hires',
  'latencyInfo',
  'loading',
  'disabled-by-default-lighthouse',
  'v8.execute',
  'v8',
] as const

/** 采集器需要的最小 CDP 会话面。 */
export interface CdpTraceTransport {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  /** 订阅 CDP 事件；返回退订函数。 */
  onEvent<T = unknown>(method: string, listener: (params: T) => void): () => void
}

/** electron.WebContents 的最小 debugger 面（避免此文件依赖 electron 类型）。 */
interface WebContentsDebuggerLike {
  debugger: {
    sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>
    on(event: 'message', listener: (event: unknown, method: string, params: unknown) => void): void
    off(event: 'message', listener: (event: unknown, method: string, params: unknown) => void): void
  }
}

/** 把 webContents.debugger 适配成采集器需要的 CDP 会话面。 */
export function createWebContentsCdpTraceTransport(
  webContents: WebContentsDebuggerLike
): CdpTraceTransport {
  return {
    send: <T = unknown>(method: string, params?: Record<string, unknown>) =>
      webContents.debugger.sendCommand(method, params) as Promise<T>,
    onEvent: <T = unknown>(method: string, listener: (params: T) => void) => {
      const handler = (_event: unknown, eventMethod: string, params: unknown): void => {
        if (eventMethod === method) listener(params as T)
      }
      webContents.debugger.on('message', handler)
      return () => {
        webContents.debugger.off('message', handler)
      }
    },
  }
}

interface CdpTracingCompleteEvent {
  stream?: string
  dataLossOccurred?: boolean
}

interface CdpIoReadResult {
  data: string
  base64Encoded?: boolean
  eof: boolean
}

const TraceStreamReadChunkSize = 1024 * 1024
const TraceCompleteTimeoutMs = 30_000

export class CdpTraceCollector {
  private tracingCompleteEvent: Nullable<Promise<CdpTracingCompleteEvent>> = null
  private unsubscribe: Nullable<() => void> = null
  private started = false

  constructor(private readonly transport: CdpTraceTransport) {}

  public isRunning(): boolean {
    return this.started
  }

  public async start(): Promise<void> {
    if (this.started) {
      throw new AppError('VALIDATION', '性能 trace 已在录制中，请先 stop_trace。')
    }

    // 先订阅再启动，避免 tracingComplete 事件竞态丢失。
    this.tracingCompleteEvent = new Promise<CdpTracingCompleteEvent>((resolve) => {
      this.unsubscribe = this.transport.onEvent<CdpTracingCompleteEvent>(
        'Tracing.tracingComplete',
        (params) => resolve(params ?? {})
      )
    })

    try {
      await this.transport.send('Tracing.start', {
        categories: BrowserPerformanceTraceCategories.join(','),
        transferMode: 'ReturnAsStream',
        streamFormat: 'json',
      })
      this.started = true
    } catch (error) {
      this.cleanup()
      throw AppError.from(error)
    }
  }

  /** 结束录制并读回全部 trace 事件。 */
  public async stop(): Promise<unknown[]> {
    if (!this.started || !this.tracingCompleteEvent) {
      throw new AppError('VALIDATION', '当前没有正在录制的性能 trace。')
    }

    try {
      await this.transport.send('Tracing.end')
      const complete = await this.waitForComplete()
      if (!complete.stream) {
        throw new AppError('EXECUTION_FAILED', '浏览器没有返回 trace 数据流。')
      }
      const raw = await this.readStream(complete.stream)
      return this.parseTraceEvents(raw)
    } finally {
      this.cleanup()
    }
  }

  /** 尽力终止录制（abort/dispose 清理用），不读数据。 */
  public async abort(): Promise<void> {
    if (!this.started) return
    try {
      await this.transport.send('Tracing.end')
      const complete = await this.waitForComplete().catch(() => null)
      if (complete?.stream) {
        await this.transport.send('IO.close', { handle: complete.stream }).catch(() => undefined)
      }
    } catch {
      // arch-guard:silent-catch-ok 停 trace 属清理路径：页面/标签页可能已销毁，此时唯一正确的
      // 行为就是继续走 finally 释放本地状态；把它抛出去只会掩盖调用方真正关心的那个错误。
    } finally {
      this.cleanup()
    }
  }

  private async waitForComplete(): Promise<CdpTracingCompleteEvent> {
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new AppError('EXECUTION_FAILED', '等待 trace 结束事件超时。')),
        TraceCompleteTimeoutMs
      ).unref?.()
    })
    return Promise.race([this.tracingCompleteEvent!, timeout])
  }

  private async readStream(handle: string): Promise<string> {
    const chunks: string[] = []
    try {
      for (;;) {
        const chunk = await this.transport.send<CdpIoReadResult>('IO.read', {
          handle,
          size: TraceStreamReadChunkSize,
        })
        chunks.push(
          chunk.base64Encoded ? Buffer.from(chunk.data, 'base64').toString('utf8') : chunk.data
        )
        if (chunk.eof) break
      }
    } finally {
      await this.transport.send('IO.close', { handle }).catch(() => undefined)
    }
    return chunks.join('')
  }

  private parseTraceEvents(raw: string): unknown[] {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new AppError('EXECUTION_FAILED', 'trace 数据不是合法 JSON。')
    }

    if (Array.isArray(parsed)) return parsed
    const events = (parsed as { traceEvents?: unknown }).traceEvents
    if (Array.isArray(events)) return events
    throw new AppError('EXECUTION_FAILED', 'trace 数据里没有 traceEvents。')
  }

  private cleanup(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.tracingCompleteEvent = null
    this.started = false
  }
}

interface CdpHeapSnapshotChunkEvent {
  chunk?: string
}

/**
 * 采集 V8 堆快照并流式写入文件（HeapProfiler domain）。
 *
 * CDP 约定：所有 addHeapSnapshotChunk 事件都会在 takeHeapSnapshot 响应之前派发，
 * 所以「先订阅 → 发命令 → 等响应 → 退订」即可拿全数据。
 * 快照可能有几百 MB，用 sink 回调流式消费，不在内存里拼接。
 */
export async function captureCdpHeapSnapshot(
  transport: CdpTraceTransport,
  sink: (chunk: string) => void
): Promise<{ chunks: number; bytes: number }> {
  let chunks = 0
  let bytes = 0
  const unsubscribe = transport.onEvent<CdpHeapSnapshotChunkEvent>(
    'HeapProfiler.addHeapSnapshotChunk',
    (params) => {
      const chunk = params?.chunk
      if (typeof chunk !== 'string' || chunk.length === 0) return
      chunks += 1
      bytes += Buffer.byteLength(chunk)
      sink(chunk)
    }
  )

  try {
    await transport.send('HeapProfiler.takeHeapSnapshot', {
      reportProgress: false,
      captureNumericValue: true,
    })
  } finally {
    unsubscribe()
  }

  if (chunks === 0) {
    throw new AppError('EXECUTION_FAILED', '浏览器没有返回堆快照数据。')
  }
  return { chunks, bytes }
}
