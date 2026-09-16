import { gzipSync } from 'node:zlib'

import type { BrowserParsedTraceRecording } from '../types/runtime.js'


/** 把原始 trace 事件序列化成 .json.gz 字节，供落盘归档（可被 DevTools 面板直接打开）。 */
export function serializeBrowserTraceToGzip(recording: BrowserParsedTraceRecording): Buffer {
  return gzipSync(JSON.stringify({ traceEvents: recording.rawEvents }))
}
