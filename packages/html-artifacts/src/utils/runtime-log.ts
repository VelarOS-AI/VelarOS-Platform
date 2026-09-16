/**
 * 零依赖的迷你日志：本包不能引 `@velaros-ai/core` 的 Log，这里自带一份最小实现。
 * 只在宿主回调自己抛错、无处可报时用一次，正常路径不写日志。
 */
import type { HtmlArtifactRuntimeLog } from '../types/internals.js'

const writeDebug = globalThis.console.debug.bind(globalThis.console)
const writeError = globalThis.console.error.bind(globalThis.console)
const writeWarning = globalThis.console.warn.bind(globalThis.console)

/** 按标签取一份日志；写出来的每一行都带 `[标签]` 前缀。 */
export const Log = {
  /** 造一份带标签的日志器。 */
  tag(tag: string): HtmlArtifactRuntimeLog {
    return {
      debug: (message, context) => writeDebug(`[${tag}] ${message}`, context),
      error: (message, context) => writeError(`[${tag}] ${message}`, context),
      warn: (message, context) => writeWarning(`[${tag}] ${message}`, context),
    }
  },
}
