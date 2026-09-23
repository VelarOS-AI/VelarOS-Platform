/** trace 采集里用不着实例状态的那部分：事件流解析。 */

import { isArray, isEmpty, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type {
  CdpHeapSnapshotChunkEvent,
  CdpTraceTransport,
  WebContentsDebuggerLike,
} from '../../types/cdp.js'

/** 解析 trace 数据流里的事件数组。 */
export function parseTraceEvents(raw: string): unknown[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new AppError('EXECUTION_FAILED', 'trace 数据不是合法 JSON。')
  }

  if (isArray(parsed)) return parsed
  const events = (parsed as { traceEvents?: unknown }).traceEvents
  if (isArray(events)) return events
  throw new AppError('EXECUTION_FAILED', 'trace 数据里没有 traceEvents。')
}

/** 把 webContents.debugger 适配成采集器需要的 CDP 会话面。 */
export function createWebContentsCdpTraceTransport(
  webContents: WebContentsDebuggerLike
): CdpTraceTransport {
  return {
    send: <T = unknown>(method: string, params?: Record<string, unknown>) =>
      webContents.debugger.sendCommand(method, params) as Promise<T>,
    onEvent: <T = unknown>(method: string, listener: (params: T) => void) => {
      const handler = (
        _event: unknown,
        eventMethod: string,
        params: unknown,
        sessionId?: string
      ): void => {
        // 子会话（模型自己的那条 CDP 会话与它挂出来的）的事件不是宿主这条的，别混进来。
        if (sessionId) return
        if (eventMethod === method) listener(params as T)
      }
      webContents.debugger.on('message', handler)
      return () => {
        webContents.debugger.off('message', handler)
      }
    },
  }
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
      if (!isString(chunk) || isEmpty(chunk)) return
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
