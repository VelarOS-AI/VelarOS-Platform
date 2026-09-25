import { jsonSchema, Output, streamText } from 'ai'

import { Log } from '@velaros-ai/core'
import { isEmpty, isUndefined } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { modelRequestEncoder } from '@velaros-ai/kernel'

import type { AiSdkDriverOptions, ModelDriver } from '../../contract/requires.js'
import type {
  ModelDriverLimits,
  ModelInputEstimate,
  ModelTurnDelta,
  ModelTurnRequest,
} from '../../types/driver.js'
import { estimateRequestInput } from '../../utils/request-estimate.js'
import { planProviderRetry } from '../../utils/retry.js'
import { ModelTuning } from '../../utils/tuning.js'
import { markPromptCacheBreakpoints, withPromptCacheKey } from '../../utils/wire/prompt-cache.js'
import { readChatCompletionReasoning } from '../../utils/wire/reasoning.js'

class AiSdkModelDriver implements ModelDriver {
  public readonly id: string
  public readonly limits: ModelDriverLimits

  public constructor(private readonly options: AiSdkDriverOptions) {
    this.id = options.id
    this.limits = Object.freeze({ ...options.limits })
  }

  public async estimate(request: ModelTurnRequest): Promise<ModelInputEstimate> {
    return estimateRequestInput(request)
  }

  public async *stream(
    request: ModelTurnRequest,
    signal: AbortSignal
  ): AsyncIterable<ModelTurnDelta> {
    try {
      const format = modelRequestEncoder.response(request)
      const result = streamText({
        model: this.options.model,
        system: request.instructions,
        messages: markPromptCacheBreakpoints(modelRequestEncoder.messages(request)),
        maxOutputTokens: request.outputTokens,
        maxRetries: 0,
        // Chat Completions 通道的思考摘要只在原始分块里（见 readChatCompletionReasoning）。
        includeRawChunks: true,
        // 完整 JSON Schema 允许可选字段和动态 input；本地校验是接收门。
        providerOptions: withPromptCacheKey(
          format.type === 'json' ? { openai: { strictJsonSchema: false } } : undefined,
          request.cacheKey
        ),
        abortSignal: signal,
        output:
          format.type === 'json'
            ? Output.object({
                name: format.name,
                description: format.description,
                schema: jsonSchema(format.schema, {
                  validate: async (value) => {
                    try {
                      return { success: true, value: modelRequestEncoder.output(format, value) }
                    } catch (error) {
                      return {
                        success: false,
                        error:
                          error instanceof Error
                            ? error
                            : new AppError('VALIDATION', String(error), error),
                      }
                    }
                  },
                }),
              })
            : undefined,
      })
      let finish: Optional<Extract<ModelTurnDelta, { type: 'finish' }>>
      let chars = 0
      let textSegments = 0
      let separator = false
      let endedWithNewline = true
      // 思考摘要只作展示：同一条响应只认先到的那一路来源，分段之间空一行，超出上限就不再转发。
      let reasoningSource: Optional<'parts' | 'raw'>
      let reasoningChars = 0
      let reasoningBreak = false
      for await (const part of result.fullStream) {
        signal.throwIfAborted()
        if (finish) throw new AppError('PROTOCOL', '供应商在结束响应后继续发送内容')
        if (part.type === 'reasoning-start' && reasoningChars > 0) reasoningBreak = true
        let reasoning = ''
        if (part.type === 'reasoning-delta' && reasoningSource !== 'raw') {
          reasoningSource = 'parts'
          reasoning = part.text
        }
        if (part.type === 'raw' && reasoningSource !== 'parts') {
          reasoning = readChatCompletionReasoning(part.rawValue)
          if (reasoning) reasoningSource = 'raw'
        }
        if (reasoning && reasoningChars < ModelTuning.stream.reasoningChars) {
          const text = (reasoningBreak ? '\n\n' : '') + reasoning
          reasoningBreak = false
          reasoningChars += text.length
          yield { type: 'reasoning', text }
        }
        if (part.type === 'text-start' && format.type === 'text') {
          // Responses 可把说明和正式答复放在不同消息里；消息边界不能把两行粘成一行。
          separator = chars > 0 && !endedWithNewline
          Log.tag('AiSdkModelDriver').debug('接收模型文本分段', {
            segment: ++textSegments,
            id: part.id,
          })
        }
        if (part.type === 'text-delta') {
          const text =
            (format.type === 'text' && separator && !isEmpty(part.text) ? '\n' : '') + part.text
          chars += text.length
          if (chars > (format.type === 'text' ? 2_000_000 : 512_000))
            throw new AppError('LIMIT', '模型响应超过协议上限')
          if (!isEmpty(part.text)) {
            separator = false
            endedWithNewline = part.text.endsWith('\n')
          }
          if (format.type === 'text') yield { type: 'text', text }
        }
        if (part.type === 'tool-call' || part.type === 'tool-input-start')
          throw new AppError('PROTOCOL', '供应商返回了本请求未声明的工具调用')
        if (part.type === 'error') throw part.error
        if (part.type === 'abort') throw new AppError('CANCELLED', '供应商响应已中止')
        if (part.type === 'finish') {
          if (
            !isUndefined(part.totalUsage.inputTokens) &&
            !isUndefined(part.totalUsage.outputTokens)
          )
            yield {
              type: 'usage',
              inputTokens: part.totalUsage.inputTokens,
              outputTokens: part.totalUsage.outputTokens,
              cacheReadTokens: part.totalUsage.inputTokenDetails.cacheReadTokens,
              cacheWriteTokens: part.totalUsage.inputTokenDetails.cacheWriteTokens,
            }
          if (!['stop', 'length'].includes(part.finishReason))
            throw new AppError('PROTOCOL', `供应商响应未成功结束：${part.finishReason}`)
          finish = { type: 'finish', reason: part.finishReason === 'length' ? 'length' : 'stop' }
        }
      }
      signal.throwIfAborted()
      if (!finish) throw new AppError('PROTOCOL', '供应商没有返回完整结束标记')
      if (finish.reason === 'stop' && format.type === 'json') {
        const value = await result.output
        signal.throwIfAborted()
        yield { type: 'output', value }
      }
      yield finish
    } catch (error) {
      Log.tag('ActRuntime').debug('AiSdkModelDriver 已进入异常处理或降级分支')
      signal.throwIfAborted()
      const message = error instanceof Error ? error.message : String(error)
      const code =
        /context.{0,30}(?:length|window|limit)|maximum.{0,20}tokens|too many tokens/iu.test(message)
          ? 'context-limit'
          : 'provider'
      const retry = code === 'provider' ? planProviderRetry(error, { retryIndex: 1 }) : null
      const failure: Extract<ModelTurnDelta, { type: 'error' }> = { type: 'error', code, message }
      if (retry) Object.assign(failure, { retryAfterMs: retry.delayMs })
      yield failure
    }
  }
}

/** 把已有供应商模型接到文本流或结构化响应契约；部分响应始终不进入执行链。 */
export function createAiSdkModelDriver(options: AiSdkDriverOptions): ModelDriver {
  return new AiSdkModelDriver(options)
}
