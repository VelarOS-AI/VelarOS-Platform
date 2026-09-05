import type { ToolSet } from 'ai'

import { AiSdkModelRequestTransport } from './AiSdkModelRequestTransport'
import type { ModelRequestOptions } from './ModelContracts'
import { applyModelRequestPolicy } from './ModelRequestPolicy'
import type {
  ModelRequestGenerateText,
  ModelRequestObjectInput,
  ModelRequestOpenStreamInput,
  ModelRequestStreamText,
  ModelRequestStreamTextInput,
  ModelRequestStreamTextInputToString,
  ModelRequestStreamTextResult,
  ModelRequestTextInput,
  ModelRequestTransport,
} from './ModelRequestTypes'

export interface ModelRequestClientOptions {
  transport?: ModelRequestTransport
  generateText?: ModelRequestGenerateText
  streamText?: ModelRequestStreamText
}

/**
 * 通用模型请求客户端。
 *
 * 宿主只需注入 `ModelRequestTransport`；endpoint 是调用方定义的可观测标签，不要求
 * 使用任何 VelarOS 产品协议。
 */
class ModelRequestClient {
  protected readonly transport: ModelRequestTransport

  constructor(options: ModelRequestClientOptions = {}) {
    this.transport =
      options.transport ??
      new AiSdkModelRequestTransport({
        generateText: options.generateText,
        streamText: options.streamText,
      })
  }

  public async generateText(input: ModelRequestTextInput): Promise<string> {
    const { endpoint, modelRequestOptions, ...request } = input
    const result = await this.transport.generateText({
      endpoint,
      request: applyModelRequestPolicy(request, modelRequestOptions),
    })
    return result.text
  }

  public streamText<TToolSet extends ToolSet = ToolSet>(
    input: ModelRequestOpenStreamInput<TToolSet>,
    modelRequestOptions?: ModelRequestOptions
  ): ModelRequestStreamTextResult<TToolSet> {
    const { endpoint, ...request } = input
    return this.transport.streamText<TToolSet>({
      endpoint,
      request: applyModelRequestPolicy(
        request as ModelRequestStreamTextInput<TToolSet>,
        modelRequestOptions
      ),
    })
  }

  public async generateObject<TOutput = unknown>(
    input: ModelRequestObjectInput<TOutput>
  ): Promise<TOutput> {
    const result = await this.transport.generateText({
      endpoint: input.endpoint,
      request: applyModelRequestPolicy(
        {
          model: input.model,
          system: input.system,
          messages: input.messages,
          output: this.transport.createObjectOutput({
            schema: input.schema,
            schemaName: input.schemaName,
            schemaDescription: input.schemaDescription,
          }),
          maxRetries: input.maxRetries,
          maxOutputTokens: input.maxOutputTokens,
          abortSignal: input.abortSignal,
        },
        input.modelRequestOptions
      ),
    })

    return input.mapOutput ? input.mapOutput(result.output) : (result.output as TOutput)
  }

  public async collectTextStream(input: ModelRequestStreamTextInputToString): Promise<string> {
    const { modelRequestOptions, stopWhen, ...streamInput } = input
    const stream = this.streamText(streamInput, modelRequestOptions)

    let text = ''
    for await (const chunk of stream.textStream) {
      text += chunk
      if (stopWhen?.(text)) break
    }

    return text
  }
}

export { ModelRequestClient }
