import type {
  FlexibleSchema,
  generateText,
  Output as AiOutput,
  streamText,
  ToolSet,
} from 'ai'

import type { ModelRequestOptions } from './ModelContracts'

type ModelRequestGenerateTextFunction = typeof generateText
type ModelRequestStreamTextFunction = typeof streamText

export type ModelRequestGenerateTextInput<
  TOutput extends ModelRequestOutput = ModelRequestTextOutput,
> = Parameters<typeof generateText<ToolSet, TOutput>>[0]
export type ModelRequestGenerateTextResult<
  TOutput extends ModelRequestOutput = ModelRequestTextOutput,
> = ReturnType<typeof generateText<ToolSet, TOutput>>
export type ModelRequestOutput = NonNullable<
  Parameters<typeof generateText>[0]['output']
>
export type ModelRequestTextOutput = ReturnType<typeof AiOutput.text>
export type ModelRequestObjectOutput<TOutput> = ReturnType<
  typeof AiOutput.object<TOutput>
>
export type ModelRequestStreamTextInput<TToolSet extends ToolSet = ToolSet> = Parameters<
  typeof streamText<TToolSet>
>[0]
export type ModelRequestStreamTextResult<TToolSet extends ToolSet = ToolSet> = ReturnType<
  typeof streamText<TToolSet>
>

export type ModelRequestLanguageModel = ModelRequestGenerateTextInput['model']
export type ModelRequestMessages = NonNullable<ModelRequestGenerateTextInput['messages']>
export type ModelRequestGenerateText = ModelRequestGenerateTextFunction
export type ModelRequestStreamText = ModelRequestStreamTextFunction
export type ModelRequestEndpoint = string

export interface ModelRequestEnvelope<TRequest> {
  endpoint: ModelRequestEndpoint
  request: TRequest
}

export interface ModelRequestObjectOutputInput<TOutput = unknown> {
  schema: FlexibleSchema<TOutput>
  schemaName: string
  schemaDescription: string
}

export interface ModelRequestTransport {
  generateText<TOutput extends ModelRequestOutput = ModelRequestTextOutput>(
    envelope: ModelRequestEnvelope<ModelRequestGenerateTextInput<TOutput>>
  ): ModelRequestGenerateTextResult<TOutput>
  streamText<TToolSet extends ToolSet = ToolSet>(
    envelope: ModelRequestEnvelope<ModelRequestStreamTextInput<TToolSet>>
  ): ModelRequestStreamTextResult<TToolSet>
  createObjectOutput<TOutput>(
    input: ModelRequestObjectOutputInput<TOutput>
  ): ModelRequestObjectOutput<TOutput>
}

export type ModelRequestTextInput = ModelRequestGenerateTextInput & {
  endpoint: ModelRequestEndpoint
  modelRequestOptions?: ModelRequestOptions
}

export type ModelRequestOpenStreamInput<TToolSet extends ToolSet = ToolSet> =
  ModelRequestStreamTextInput<TToolSet> & {
    endpoint: ModelRequestEndpoint
  }

interface ModelRequestObjectBaseInput<TSchemaOutput> {
  endpoint: ModelRequestEndpoint
  model: ModelRequestLanguageModel
  system: string
  messages: ModelRequestMessages
  schema: FlexibleSchema<TSchemaOutput>
  schemaName: string
  schemaDescription: string
  maxRetries?: ModelRequestGenerateTextInput['maxRetries']
  maxOutputTokens?: ModelRequestGenerateTextInput['maxOutputTokens']
  modelRequestOptions?: ModelRequestOptions
  abortSignal?: ModelRequestGenerateTextInput['abortSignal']
}

/**
 * 结构化输出请求。返回类型由 schema 的输出类型决定，调用方不能通过一个无关泛型改写它。
 */
export type ModelRequestObjectInput<TOutput = unknown> = ModelRequestObjectBaseInput<TOutput> & {
  /**
   * @deprecated 需要改变输出类型时使用 ModelRequestClient.generateDecodedObject。
   * 这里仅保留同类型归一化兼容能力。
   */
  mapOutput?: ModelRequestOutputDecoder<TOutput, TOutput>
}

export type ModelRequestOutputDecoder<TSchemaOutput, TOutput> = (
  output: TSchemaOutput
) => TOutput | PromiseLike<TOutput>

/**
 * 需要领域转换时使用显式 decoder；decoder 的输入仍由 schema 决定。
 */
export type ModelRequestDecodedObjectInput<TSchemaOutput, TOutput> =
  ModelRequestObjectBaseInput<TSchemaOutput> & {
    decodeOutput: ModelRequestOutputDecoder<TSchemaOutput, TOutput>
  }

export interface ModelRequestStreamTextInputToString {
  endpoint: ModelRequestEndpoint
  model: ModelRequestStreamTextInput['model']
  system: NonNullable<ModelRequestStreamTextInput['system']>
  messages: NonNullable<ModelRequestStreamTextInput['messages']>
  maxRetries?: ModelRequestStreamTextInput['maxRetries']
  maxOutputTokens?: ModelRequestStreamTextInput['maxOutputTokens']
  modelRequestOptions?: ModelRequestOptions
  abortSignal?: ModelRequestStreamTextInput['abortSignal']
  onError?: ModelRequestStreamTextInput['onError']
  stopWhen?: (text: string) => boolean
}
