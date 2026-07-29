import type { generateText, streamText, ToolSet } from 'ai'

import type { ModelRequestOptions } from './ModelContracts'

type ModelRequestGenerateTextFunction = typeof generateText
type ModelRequestStreamTextFunction = typeof streamText

export type ModelRequestGenerateTextInput = Parameters<ModelRequestGenerateTextFunction>[0]
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

export interface ModelRequestObjectOutputInput {
  schema: unknown
  schemaName: string
  schemaDescription: string
}

export interface ModelRequestTransport {
  generateText(
    envelope: ModelRequestEnvelope<ModelRequestGenerateTextInput>
  ): ReturnType<ModelRequestGenerateTextFunction>
  streamText<TToolSet extends ToolSet = ToolSet>(
    envelope: ModelRequestEnvelope<ModelRequestStreamTextInput<TToolSet>>
  ): ModelRequestStreamTextResult<TToolSet>
  createObjectOutput(input: ModelRequestObjectOutputInput): ModelRequestGenerateTextInput['output']
}

export type ModelRequestTextInput = ModelRequestGenerateTextInput & {
  endpoint: ModelRequestEndpoint
  modelRequestOptions?: ModelRequestOptions
}

export type ModelRequestOpenStreamInput<TToolSet extends ToolSet = ToolSet> =
  ModelRequestStreamTextInput<TToolSet> & {
    endpoint: ModelRequestEndpoint
  }

export interface ModelRequestObjectInput<TOutput> {
  endpoint: ModelRequestEndpoint
  model: ModelRequestLanguageModel
  system: string
  messages: ModelRequestMessages
  schema: unknown
  schemaName: string
  schemaDescription: string
  maxRetries?: ModelRequestGenerateTextInput['maxRetries']
  maxOutputTokens?: ModelRequestGenerateTextInput['maxOutputTokens']
  modelRequestOptions?: ModelRequestOptions
  abortSignal?: ModelRequestGenerateTextInput['abortSignal']
  mapOutput?: (output: unknown) => TOutput
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
