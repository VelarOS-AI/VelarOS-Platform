/** trace 采集里用不着实例状态的那部分：事件流解析。 */

import { isArray } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

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
