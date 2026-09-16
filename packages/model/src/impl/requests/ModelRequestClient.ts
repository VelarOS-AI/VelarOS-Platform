import type { ToolSet } from 'ai'

import type {
  ModelRequestTransport,
} from '../../contract/requires'
import type { ModelRequestOptions } from '../../types/model'
import type {
  ModelRequestDecodedObjectInput,
  ModelRequestGenerateText,
  ModelRequestObjectInput,
  ModelRequestOpenStreamInput,
  ModelRequestStreamText,
  ModelRequestStreamTextInput,
  ModelRequestStreamTextInputToString,
  ModelRequestStreamTextResult,
  ModelRequestTextInput,
} from '../../types/requests'
import { applyRequestPolicy } from '../../utils/wire/request-policy'

import { AiSdkModelRequestTransport } from './AiSdkModelRequestTransport'

/** 建一个请求客户端要什么，三样都可选。 */
export interface ModelRequestClientOptions {
  /** 宿主自带的 transport；给了就完全替换内置的那套。 */
  transport?: ModelRequestTransport
  /** 只替换非流式实现，其余仍走内置 transport。 */
  generateText?: ModelRequestGenerateText
  /** 只替换流式实现，其余仍走内置 transport。 */
  streamText?: ModelRequestStreamText
}

/**
 * 通用模型请求客户端。
 *
 * 宿主只需注入 `ModelRequestTransport`；endpoint 是调用方定义的可观测标签，不要求
 * 使用任何 VelarOS 产品协议。
 */
export interface ModelRequestClientApi {
  /** 发一次非流式请求，只要文本。 */
  generateText(input: ModelRequestTextInput): Promise<string>
  /** 开一条流式请求；请求策略从第二个参数带进来。 */
  streamText<TToolSet extends ToolSet = ToolSet>(
    input: ModelRequestOpenStreamInput<TToolSet>,
    modelRequestOptions?: ModelRequestOptions
  ): ModelRequestStreamTextResult<TToolSet>
  /** 按 schema 发一次结构化输出请求。 */
  generateObject<TOutput = unknown>(input: ModelRequestObjectInput<TOutput>): Promise<TOutput>
  /** 按 schema 发一次结构化输出请求，再用显式 decoder 转成领域类型。 */
  generateDecodedObject<TSchemaOutput, TOutput>(
    input: ModelRequestDecodedObjectInput<TSchemaOutput, TOutput>
  ): Promise<TOutput>
  /** 开一条流式请求并把文本收齐；`stopWhen` 命中就提前收。 */
  collectTextStream(input: ModelRequestStreamTextInputToString): Promise<string>
}

class ModelRequestClient implements ModelRequestClientApi {
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
      request: applyRequestPolicy(request, modelRequestOptions),
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
      request: applyRequestPolicy(
        request as ModelRequestStreamTextInput<TToolSet>,
        modelRequestOptions
      ),
    })
  }

  public async generateObject<TOutput = unknown>(
    input: ModelRequestObjectInput<TOutput>
  ): Promise<TOutput> {
    const output = await this.#requestObject(input)
    return input.mapOutput ? input.mapOutput(output) : output
  }

  public async generateDecodedObject<TSchemaOutput, TOutput>(
    input: ModelRequestDecodedObjectInput<TSchemaOutput, TOutput>
  ): Promise<TOutput> {
    return input.decodeOutput(await this.#requestObject(input))
  }

  async #requestObject<TSchemaOutput>(
    input: ModelRequestObjectInput<TSchemaOutput> | ModelRequestDecodedObjectInput<TSchemaOutput, unknown>
  ): Promise<TSchemaOutput> {
    const output = this.transport.createObjectOutput({
      schema: input.schema,
      schemaName: input.schemaName,
      schemaDescription: input.schemaDescription,
    })
    const result = await this.transport.generateText({
      endpoint: input.endpoint,
      request: applyRequestPolicy(
        {
          model: input.model,
          system: input.system,
          messages: input.messages,
          output,
          maxRetries: input.maxRetries,
          maxOutputTokens: input.maxOutputTokens,
          abortSignal: input.abortSignal,
        },
        input.modelRequestOptions
      ),
    })

    return result.output
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

/** 建一个模型请求客户端；宿主整个进程可以建多份，各自带自己的 transport。 */
export function createModelRequestClient(
  options: ModelRequestClientOptions = {}
): ModelRequestClientApi {
  return new ModelRequestClient(options)
}
