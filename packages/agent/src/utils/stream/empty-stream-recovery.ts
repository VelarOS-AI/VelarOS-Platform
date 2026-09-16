import { isFiniteNumber,isTrue } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { EmptyAssistantStreamErrorInput,EmptyStreamContextPressure, StreamDiagnostics } from '../../types/loop.js'


/**
 * 认出"只思考、没产出"的空流：可见文本、原始可见内容、工具调用三样都是 0，
 * 但思考增量或原始思考字段有内容时为真。
 *
 * 针对的供应方行为：推理模型把预算全烧在 reasoning 上就收了尾，一个可见 token 也没给。
 * 这跟"整流全空"不是一回事——前者重试往往有救，后者多半要换模型，所以要分开标记。
 */
function isReasoningOnlyEmptyStream(diagnostics: StreamDiagnostics): boolean {
  if (diagnostics.textDeltaChars > 0) return false
  if (diagnostics.rawVisibleChars > 0) return false
  if (diagnostics.toolCallCount > 0) return false

  return diagnostics.reasoningDeltaChars > 0 || diagnostics.rawReasoningChars > 0
}

/**
 * 反过来，从已经抛出的错误里认出"只思考、没产出"这一种：要求 code 是 `MODEL_EMPTY_RESPONSE`、
 * context.source 与调用侧（query / 普通流）对得上、且 `reasoningOnly` 为 true。三条缺一即为假。
 * 校验 source 是为了不把另一条链路上同码的空响应错认过来。
 */
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

/**
 * 判断这次空流该不该改判成"上下文压力"（从而走压缩后重试，而不是报模型空响应让用户自己换模型）。
 *
 * 针对的供应方行为：输入逼近窗口上限时，部分供应方不返回 context_length 类错误，而是正常收一条几乎没有
 * 输出 token 的空流。判据两条同时成立：输出 token ≤ 2（真答了内容就不算压力所致），
 * 且输入占可用窗口 ≥ 85%——优先用 inputTokens/usableContextWindow 实算，两者缺一才退回调用方给的 percent；
 * 两个口径都拿不到就返回 false，宁可按普通空响应上报也不误触发一次压缩。
 */
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

/**
 * 拼错误上下文里的 `source` 标识，把「哪条链路（query / 普通流）」× 「哪种空法（一个分片都没收到 /
 * 上下文压力 / 收到了分片但没有可见内容）」编码成一个稳定串，例如 `query-stream-empty-context-pressure`。
 * 日志与重试策略都按这个串分流，所以取值必须稳定，不要顺手改写。
 */
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

/**
 * 为"这一轮没拿到任何可见助手内容"造错误，并按空法分成三种，因为三种的下一步动作不同。
 *
 * 收到过分片、且判定为上下文压力 → `context_length_exceeded`，交给压缩后重试那条路；
 * 收到过分片但就是没可见内容 → `MODEL_EMPTY_RESPONSE`，context 里带上 finishReason、思考字符数与
 * `reasoningOnly` 标记，供上层决定是重试还是提示换模型；
 * 一个分片都没收到 → 同样 `MODEL_EMPTY_RESPONSE`，但 source 标成 before-first-chunk（更像连接/网关问题）。
 * `fallbackText` 只对第二种生效，用来让调用方替换面向用户的那句话。
 */
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
