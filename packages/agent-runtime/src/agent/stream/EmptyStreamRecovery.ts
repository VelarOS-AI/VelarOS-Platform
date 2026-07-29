import { isFiniteNumber,isTrue } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { StreamDiagnostics } from './types'

export interface EmptyStreamContextPressure {
  percent: number
  usableContextWindow: number
}

export interface EmptyAssistantStreamErrorInput {
  diagnostics: StreamDiagnostics
  contextPressure?: EmptyStreamContextPressure
  fallbackText?: string
  requestFingerprint?: unknown
  source: 'stream' | 'query'
  turn: Nullable<number>
}

function isReasoningOnlyEmptyStream(diagnostics: StreamDiagnostics): boolean {
  if (diagnostics.textDeltaChars > 0) return false
  if (diagnostics.rawVisibleChars > 0) return false
  if (diagnostics.toolCallCount > 0) return false

  return diagnostics.reasoningDeltaChars > 0 || diagnostics.rawReasoningChars > 0
}

function isReasoningOnlyEmptyResponseError(
  error: unknown,
  source: EmptyAssistantStreamErrorInput['source']
): boolean {
  const appError = AppError.from(error)
  if (appError.code !== 'MODEL_EMPTY_RESPONSE') return false

  const expectedSource =
    source === 'query' ? 'query-stream-empty-response' : 'stream-empty-response'
  return appError.context?.source === expectedSource && isTrue(appError.context?.reasoningOnly)
}

export function shouldRecoverEmptyStreamAsContextPressure(
  diagnostics: StreamDiagnostics,
  contextPressure?: EmptyStreamContextPressure
): boolean {
  const outputTokens = diagnostics.outputTokens ?? 0
  if (outputTokens > 2) return false

  const usableContextWindow = contextPressure?.usableContextWindow
  if (
    isFiniteNumber(diagnostics.inputTokens) && isFiniteNumber(usableContextWindow) && usableContextWindow > 0
  ) return (diagnostics.inputTokens / usableContextWindow) * 100 >= 85

  const percent = contextPressure?.percent
  return isFiniteNumber(percent) && percent >= 85
}

function buildEmptyStreamSource(
  source: EmptyAssistantStreamErrorInput['source'],
  kind: 'before-first-chunk' | 'context-pressure' | 'response'
): string {
  if (kind === 'before-first-chunk') return source === 'query'
      ? 'query-empty-before-first-chunk'
      : 'stream-empty-before-first-chunk'

  if (source === 'query') return kind === 'context-pressure'
      ? 'query-stream-empty-context-pressure'
      : 'query-stream-empty-response'

  return kind === 'context-pressure' ? 'stream-empty-context-pressure' : 'stream-empty-response'
}

export function buildEmptyAssistantStreamError(
  input: EmptyAssistantStreamErrorInput
): AppError {
  if (input.diagnostics.totalChunks > 0) {
    const reasoningOnly = isReasoningOnlyEmptyStream(input.diagnostics)
    if (shouldRecoverEmptyStreamAsContextPressure(input.diagnostics, input.contextPressure)) return new AppError(
        'context_length_exceeded',
        '模型在高上下文压力下返回空流，将先压缩上下文后重试。',
        undefined,
        {
          source: buildEmptyStreamSource(input.source, 'context-pressure'),
          turn: input.turn,
          contextPercent: input.contextPressure?.percent,
          inputTokens: input.diagnostics.inputTokens,
          outputTokens: input.diagnostics.outputTokens,
          requestFingerprint: input.requestFingerprint,
        }
      )

    return new AppError(
      'MODEL_EMPTY_RESPONSE',
      input.fallbackText ??
        '模型完成了请求，但没有返回任何可见内容。请切换模型或稍后重试。',
      undefined,
      {
        source: buildEmptyStreamSource(input.source, 'response'),
        turn: input.turn,
        inputTokens: input.diagnostics.inputTokens,
        outputTokens: input.diagnostics.outputTokens,
        finishReasons: input.diagnostics.finishReasons,
        rawFinishReasons: input.diagnostics.rawFinishReasons,
        reasoningOnly,
        reasoningDeltaChars: input.diagnostics.reasoningDeltaChars,
        rawReasoningChars: input.diagnostics.rawReasoningChars,
        requestFingerprint: input.requestFingerprint,
      }
    )
  }

  return new AppError(
    'MODEL_EMPTY_RESPONSE',
    '模型完成了请求，但没有返回任何可见内容。请切换模型或稍后重试。',
    undefined,
    {
      turn: input.turn,
      source: buildEmptyStreamSource(input.source, 'before-first-chunk'),
      requestFingerprint: input.requestFingerprint,
    }
  )
}

export { isReasoningOnlyEmptyResponseError, isReasoningOnlyEmptyStream }
