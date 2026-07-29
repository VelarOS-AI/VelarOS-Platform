import { AppError } from '@velaros-ai/core/error'

import type { StreamFinishReasonDiagnostic } from './types'

const RecoverableOutputTruncationFinishReasons = new Set(['length', 'repetition_truncation'])
const ModelOutputTruncatedErrorCode = 'MODEL_OUTPUT_TRUNCATED'

interface OutputTruncationErrorContext {
  model: string
  turn: Nullable<number>
}

export function isRecoverableOutputTruncationDiagnostic(
  diagnostic: Nullable<StreamFinishReasonDiagnostic>
): diagnostic is StreamFinishReasonDiagnostic {
  return (
    !!diagnostic &&
    RecoverableOutputTruncationFinishReasons.has(diagnostic.details.normalizedFinishReason)
  )
}

export function createOutputTruncationError(
  diagnostic: StreamFinishReasonDiagnostic,
  context: OutputTruncationErrorContext
): AppError {
  return new AppError(
    ModelOutputTruncatedErrorCode,
    '模型输出达到长度限制，正在从截断处自动续写。',
    undefined,
    {
      source: 'stream-output-truncated',
      model: context.model,
      turn: context.turn,
      ...diagnostic.details,
    }
  )
}

export function isOutputTruncationError(error: unknown): boolean {
  return AppError.from(error).code === ModelOutputTruncatedErrorCode
}

export function buildOutputTruncationContinuationPrompt(appendedAssistant: boolean): string {
  const lines = [
    'The previous assistant response stopped because the provider hit an output limit.',
  ]

  if (appendedAssistant) {
    lines.push(
      'The visible text already streamed to the user has been preserved in conversation history.',
      'Continue exactly from the cutoff point without repeating, restarting, or summarizing the preserved text.'
    )
  } else {
    lines.push('Continue the response now without restarting it from the beginning.')
  }

  lines.push(
    'Complete the remaining answer in normal visible assistant text.',
    'Keep any still-needed tool call complete and valid; do not emit a partial tool call.'
  )
  return lines.join('\n')
}
