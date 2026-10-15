import { jsonSchema, Output, streamText } from 'ai'

import { Log } from '@velaros-ai/core'
import { isEmpty, isUndefined } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { modelRequestEncoder } from '@velaros-ai/kernel'

import type { AiSdkDriverOptions, ModelDriver } from '../../contract/requires.js'
import type {
  ModelDriverLimits,
  ModelInputEstimate,
  ModelToolCall,
  ModelTurnDelta,
  ModelTurnRequest,
} from '../../types/driver.js'
import type { ModelInputSample } from '../../types/requests.js'
import { planProviderRetry, providerErrorMessage } from '../../utils/retry.js'
import { ModelTuning } from '../../utils/tuning.js'
import {
  responseContinuation,
  restoreResponseContinuations,
  usesResponseContinuation,
} from '../../utils/wire/continuation.js'
import { withPromptCacheKey } from '../../utils/wire/prompt-cache.js'
import { readChatCompletionReasoning } from '../../utils/wire/reasoning.js'
import { awaitModelStreamValue } from '../../utils/wire/stream-cancel.js'
import {
  responseTerminalFailure,
  responseTerminalKind,
  responseTerminalUsage,
} from '../../utils/wire/stream-terminal.js'

import { ModelInputEstimator } from './ModelInputEstimator.js'

class AiSdkModelDriver implements ModelDriver {
  public readonly dispatchAware = true
  public readonly nativeTools = true
  public readonly id: string
  public readonly limits: ModelDriverLimits
  private readonly inputEstimator: ModelInputEstimator

  public constructor(private readonly options: AiSdkDriverOptions) {
    this.id = options.id
    this.limits = Object.freeze({ ...options.limits })
    this.inputEstimator = new ModelInputEstimator(options.model)
  }

  public async estimate(request: ModelTurnRequest): Promise<ModelInputEstimate> {
    return (await this.inputSample(request)).estimate
  }

  private inputSample(request: ModelTurnRequest): Promise<ModelInputSample> {
    return this.inputEstimator.prepare(
      request,
      restoreResponseContinuations(
        modelRequestEncoder.messages(request),
        this.options.model,
        this.id
      )
    )
  }

  public async *stream(
    request: ModelTurnRequest,
    signal: AbortSignal,
    beforeDispatch?: () => Promise<void>
  ): AsyncIterable<ModelTurnDelta> {
    let reportedUsage: Optional<Extract<ModelTurnDelta, { type: 'usage' }>>
    let usagePublished = false
    let responseTerminal: Optional<string>
    let responseFailure: Optional<AppError>
    let iterator: Optional<AsyncIterator<unknown>>
    let sample: Optional<ModelInputSample>
    let dispatchFailed = false
    try {
      sample = await this.inputSample(request)
      signal.throwIfAborted()
      const format = modelRequestEncoder.response(request)
      const openaiOptions: Record<string, boolean> = {}
      if (format.type === 'json') openaiOptions.strictJsonSchema = false
      if (usesResponseContinuation(this.options.model)) openaiOptions.store = false
      const messages = restoreResponseContinuations(
        modelRequestEncoder.messages(request),
        this.options.model,
        this.id
      ).messages
      try {
        await beforeDispatch?.()
      } catch (error) {
        dispatchFailed = true
        throw error
      }
      signal.throwIfAborted()
      const result = streamText({
        model: this.options.model,
        system: request.instructions,
        messages,
        maxOutputTokens: request.outputTokens,
        maxRetries: 0,
        tools:
          format.type === 'tools'
            ? Object.fromEntries(
                format.tools.map((tool) => [
                  tool.name,
                  { description: tool.description, inputSchema: jsonSchema(tool.schema) },
                ])
              )
            : undefined,
        // fullStream 负责交付失败；替换 SDK 默认的原始对象打印，避免把请求数据写进 stderr。
        onError: ({ error }) => {
          Log.tag('AiSdkModelDriver').debug('供应商响应流失败', {
            message: providerErrorMessage(error),
          })
        },
        // Chat Completions 通道的思考摘要只在原始分块里（见 readChatCompletionReasoning）。
        includeRawChunks: true,
        // 完整 JSON Schema 允许可选字段和动态 input；本地校验是接收门。
        providerOptions: withPromptCacheKey(
          format.type === 'json' || usesResponseContinuation(this.options.model)
            ? {
                openai: openaiOptions,
              }
            : undefined,
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
      let received = ''
      const calls: ModelToolCall[] = []
      let continuationTokens = request.outputTokens
      let chars = 0
      let textSegments = 0
      let separator = false
      let endedWithNewline = true
      // 思考摘要只作展示：同一条响应只认先到的那一路来源，分段之间空一行，超出上限就不再转发。
      let reasoningSource: Optional<'parts' | 'raw'>
      let reasoningChars = 0
      let reasoningBreak = false
      const parts = result.fullStream[Symbol.asyncIterator]()
      iterator = parts
      for (;;) {
        const next = await awaitModelStreamValue(parts.next(), signal)
        if (next.done) break
        const part = next.value
        // 先保存已到达的供应商事实；取消不能抹掉终端里明确报告的用量。
        if (part.type === 'raw' && usesResponseContinuation(this.options.model)) {
          responseTerminal ??= responseTerminalKind(part.rawValue)
          reportedUsage ??= responseTerminalUsage(part.rawValue)
          if (responseTerminal === 'response.failed')
            responseFailure ??= responseTerminalFailure(part.rawValue)
        }
        if (
          part.type === 'finish' &&
          !reportedUsage &&
          !isUndefined(part.totalUsage.inputTokens) &&
          !isUndefined(part.totalUsage.outputTokens)
        )
          reportedUsage = {
            type: 'usage',
            inputTokens: part.totalUsage.inputTokens,
            outputTokens: part.totalUsage.outputTokens,
            cacheReadTokens: part.totalUsage.inputTokenDetails.cacheReadTokens,
            cacheWriteTokens: part.totalUsage.inputTokenDetails.cacheWriteTokens,
          }
        if (reportedUsage && !usagePublished) {
          usagePublished = true
          this.inputEstimator.record(sample, reportedUsage.inputTokens)
          yield reportedUsage
        }
        signal.throwIfAborted()
        if (responseFailure) throw responseFailure
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
        if (part.type === 'text-start' && format.type !== 'json') {
          // Responses 可把说明和正式答复放在不同消息里；消息边界不能把两行粘成一行。
          separator = chars > 0 && !endedWithNewline
          Log.tag('AiSdkModelDriver').debug('接收模型文本分段', {
            segment: ++textSegments,
            id: part.id,
          })
        }
        if (part.type === 'text-delta') {
          const text =
            (format.type !== 'json' && separator && !isEmpty(part.text) ? '\n' : '') + part.text
          chars += text.length
          if (chars > (format.type !== 'json' ? 2_000_000 : 512_000))
            throw new AppError('LIMIT', '模型响应超过协议上限')
          if (!isEmpty(part.text)) {
            separator = false
            endedWithNewline = part.text.endsWith('\n')
          }
          if (format.type !== 'json') {
            received += text
            yield { type: 'text', text }
          }
        }
        if (
          (part.type === 'tool-call' || part.type === 'tool-input-start') &&
          format.type !== 'tools'
        )
          throw new AppError('PROTOCOL', '供应商返回了本请求未声明的工具调用')
        if (part.type === 'tool-call') {
          if (
            format.type !== 'tools' ||
            !format.tools.some((tool) => tool.name === part.toolName) ||
            part.providerExecuted
          )
            throw new AppError('PROTOCOL', '供应商返回了本请求未声明的工具调用')
          const call = { id: part.toolCallId, name: part.toolName, input: part.input }
          chars += JSON.stringify(call).length
          if (chars > 2_000_000 || calls.length >= 32)
            throw new AppError('LIMIT', '模型工具调用超过协议上限')
          calls.push(call)
          yield { type: 'tool-call', value: call }
        }
        if (part.type === 'error') throw part.error
        if (part.type === 'abort') throw new AppError('CANCELLED', '供应商响应已中止')
        if (part.type === 'finish') {
          continuationTokens =
            part.totalUsage.outputTokenDetails.reasoningTokens ??
            part.totalUsage.outputTokens ??
            request.outputTokens
          // Responses SDK 会在普通 EOF 时合成 other；缺失终端是流中断，不能冒充供应商拒绝。
          if (
            usesResponseContinuation(this.options.model) &&
            !responseTerminal &&
            part.finishReason === 'other' &&
            isUndefined(part.rawFinishReason)
          )
            throw AppError.withFields(
              'UNAVAILABLE',
              '供应商响应流中断：未收到 Responses 终端事件',
              {
                retryable: true,
              }
            )
          if (
            !['stop', 'length', ...(format.type === 'tools' ? ['tool-calls'] : [])].includes(
              part.finishReason
            )
          )
            throw new AppError('PROTOCOL', `供应商响应未成功结束：${part.finishReason}`)
          finish = { type: 'finish', reason: part.finishReason === 'length' ? 'length' : 'stop' }
        }
      }
      signal.throwIfAborted()
      if (!finish) throw new AppError('PROTOCOL', '供应商没有返回完整结束标记')
      if (finish.reason === 'stop' && format.type === 'json') {
        const value = await awaitModelStreamValue(result.output, signal)
        signal.throwIfAborted()
        yield { type: 'output', value }
      }
      if (
        finish.reason === 'stop' &&
        format.type !== 'json' &&
        usesResponseContinuation(this.options.model)
      ) {
        const response = await awaitModelStreamValue(result.response, signal)
        signal.throwIfAborted()
        const value = responseContinuation(
          this.options.model,
          this.id,
          response.messages,
          received,
          continuationTokens,
          (await awaitModelStreamValue(result.providerMetadata, signal))?.openai?.reasoningContext,
          calls
        )
        if (value) yield { type: 'continuation', value }
      }
      yield finish
    } catch (error) {
      if (dispatchFailed) throw error
      Log.tag('ActRuntime').debug('AiSdkModelDriver 已进入异常处理或降级分支')
      if (reportedUsage && !usagePublished) {
        usagePublished = true
        if (sample) this.inputEstimator.record(sample, reportedUsage.inputTokens)
        yield reportedUsage
      }
      signal.throwIfAborted()
      const message = providerErrorMessage(error)
      const code =
        /context.{0,30}(?:length|window|limit)|maximum.{0,20}tokens|too many tokens/iu.test(message)
          ? 'context-limit'
          : 'provider'
      if (code === 'context-limit') this.inputEstimator.reset()
      // completed 后 SDK 仍可能因传输失败而缺失完整延续状态：拒绝执行，也不再生成一份已完成响应。
      const retry =
        code === 'provider' && responseTerminal !== 'response.completed'
          ? planProviderRetry(error, { retryIndex: 1 })
          : null
      const failure: Extract<ModelTurnDelta, { type: 'error' }> = { type: 'error', code, message }
      if (retry) Object.assign(failure, { retryAfterMs: retry.delayMs })
      yield failure
    } finally {
      // 清理不等待不合作的供应商；return 的迟到失败也不能变成未处理拒绝。
      void Promise.resolve(iterator?.return?.()).catch(() => {
        Log.tag('AiSdkModelDriver').debug('供应商响应流清理未正常结束')
      })
    }
  }
}

/** 把已有供应商模型接到文本流或结构化响应契约；部分响应始终不进入执行链。 */
export function createAiSdkModelDriver(options: AiSdkDriverOptions): ModelDriver {
  return new AiSdkModelDriver(options)
}
