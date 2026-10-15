import { AppError } from '@velaros-ai/core/error'

import type { ExecutionOutputChunk } from '../../system/types/executions.js'
import { ExecutionObservabilityLimits } from '../contract/constants.js'
import type { ExecutionOutputState } from '../types/execution-output.js'

/** 只保留最近 32768 字符和 512 段，流标记与绝对游标不因截断改变。 */
export function appendExecutionOutput(
  state: ExecutionOutputState,
  text: string,
  stream: ExecutionOutputChunk['stream']
): ExecutionOutputState {
  if (!text) return state
  const chunks = [...state.chunks]
  const last = chunks.at(-1)
  if (last?.stream === stream && last.offset + last.text.length === state.totalChars)
    chunks[chunks.length - 1] = { ...last, text: last.text + text }
  else chunks.push({ stream, offset: state.totalChars, text })
  const totalChars = state.totalChars + text.length
  const first = Math.max(0, totalChars - ExecutionObservabilityLimits.retainedChars)
  return {
    totalChars,
    chunks: chunks
      .filter((chunk) => chunk.offset + chunk.text.length > first)
      .slice(-ExecutionObservabilityLimits.chunks)
      .map((chunk) =>
        chunk.offset < first
          ? { ...chunk, offset: first, text: chunk.text.slice(first - chunk.offset) }
          : chunk
      ),
  }
}

/** 重复读取同一游标稳定；读取窗口不把尚未结束的输出当成完整。 */
export function readExecutionOutput(
  state: ExecutionOutputState,
  cursor = 0,
  limit: number = ExecutionObservabilityLimits.pageChars
) {
  if (
    !Number.isSafeInteger(cursor) ||
    cursor < 0 ||
    cursor > state.totalChars ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > ExecutionObservabilityLimits.maxPageChars
  )
    throw new AppError('VALIDATION', '执行输出游标或读取数量无效')
  const start = Math.max(cursor, state.chunks[0]?.offset ?? state.totalChars)
  const end = Math.min(state.totalChars, start + limit)
  const output = state.chunks
    .filter((chunk) => chunk.offset < end && chunk.offset + chunk.text.length > start)
    .map((chunk) => ({
      ...chunk,
      offset: Math.max(chunk.offset, start),
      text: chunk.text.slice(Math.max(0, start - chunk.offset), end - chunk.offset),
    }))
  return { output, nextCursor: end, totalChars: state.totalChars, truncated: start > cursor }
}
