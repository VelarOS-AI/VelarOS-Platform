import { AppError } from '@velaros-ai/core/error'

import type { OutputTruncationErrorContext,StreamFinishReasonDiagnostic } from '../../types/loop.js'


const RecoverableOutputTruncationFinishReasons = new Set(['length', 'repetition_truncation'])
const ModelOutputTruncatedErrorCode = 'MODEL_OUTPUT_TRUNCATED'

/**
 * 判断这次收流是不是"被输出长度掐断、可以续写"的那一类：归一后的 finishReason 是 `length`
 * 或 `repetition_truncation` 时为真。其余结束原因（stop / tool-calls / error / content-filter 等）一律为假——
 * 那些是模型自己收的尾，续写只会重复或跑偏。
 */
export function isRecoverableOutputTruncationDiagnostic(
  diagnostic: Nullable<StreamFinishReasonDiagnostic>
): diagnostic is StreamFinishReasonDiagnostic {
  return (
    !!diagnostic &&
    RecoverableOutputTruncationFinishReasons.has(diagnostic.details.normalizedFinishReason)
  )
}

/**
 * 造一个 `MODEL_OUTPUT_TRUNCATED` 信号错误，作为"从截断处自动续写"这条恢复路径的载体。
 * 它不是给用户看的故障——文案就写明正在自动续写；诊断细节（finishReason、模型、轮次）原样并进 context 供排查。
 */
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

/**
 * 认出上面那个截断续写信号：任意错误归一后 code 是 `MODEL_OUTPUT_TRUNCATED` 才为真。
 * 循环据此把它分流到续写路径而不是当本轮失败上报。
 */
export function isOutputTruncationError(error: unknown): boolean {
  return AppError.from(error).code === ModelOutputTruncatedErrorCode
}

/**
 * 拼续写轮要追加的提示词，告诉模型上一段是被供应方的输出上限掐断的、请接着写。
 *
 * `appendedAssistant` 指截断前已流给用户的那段文本是否已作为 assistant 消息进了历史：
 * 进了就要求**从断点接着写、不要重复或重述**（否则用户会看到同一段被写两遍）；
 * 没进则只要求"继续，别从头重来"。两种情况都强调剩余内容用正常可见文本写完，
 * 且工具调用要么完整要么不发——半个工具调用比没有更糟。
 */
export function buildOutputTruncationContinuationPrompt(appendedAssistant: boolean): string {
  const lines = [
    '上一条回复是因为供应方的输出上限被掐断的，不是答完了。',
  ]

  if (appendedAssistant) {
    lines.push(
      '已经流给用户的可见正文保留在对话历史里。',
      '从断点处接着写，不要重复、不要从头再来、也不要把保留的那段重述一遍。'
    )
  } else {
    lines.push('现在继续这条回复，不要从头重写。')
  }

  lines.push(
    '剩下的内容用普通可见正文写完。',
    '还需要的工具调用要发就发完整合法的一次，不要发半截调用。'
  )
  return lines.join('\n')
}
