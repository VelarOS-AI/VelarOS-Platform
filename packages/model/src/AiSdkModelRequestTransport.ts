import {
  generateText,
  Output as AiOutput,
  streamText,
  type ToolSet,
} from 'ai'

import type {
  ModelRequestEnvelope,
  ModelRequestGenerateText,
  ModelRequestGenerateTextInput,
  ModelRequestGenerateTextResult,
  ModelRequestObjectOutput,
  ModelRequestObjectOutputInput,
  ModelRequestOutput,
  ModelRequestStreamText,
  ModelRequestStreamTextInput,
  ModelRequestStreamTextResult,
  ModelRequestTextOutput,
  ModelRequestTransport,
} from './ModelRequestTypes'

interface AiSdkModelRequestTransportOptions {
  generateText?: ModelRequestGenerateText
  streamText?: ModelRequestStreamText
}

class AiSdkModelRequestTransport implements ModelRequestTransport {
  private readonly generateTextImpl: ModelRequestGenerateText
  private readonly streamTextImpl: ModelRequestStreamText

  constructor(options: AiSdkModelRequestTransportOptions = {}) {
    this.generateTextImpl = options.generateText ?? generateText
    this.streamTextImpl = options.streamText ?? streamText
  }

  public generateText<TOutput extends ModelRequestOutput = ModelRequestTextOutput>(
    envelope: ModelRequestEnvelope<ModelRequestGenerateTextInput<TOutput>>
  ): ModelRequestGenerateTextResult<TOutput> {
    return this.generateTextImpl<ToolSet, TOutput>(envelope.request)
  }

  public streamText<TToolSet extends ToolSet = ToolSet>(
    envelope: ModelRequestEnvelope<ModelRequestStreamTextInput<TToolSet>>
  ): ModelRequestStreamTextResult<TToolSet> {
    return this.streamTextImpl<TToolSet>(envelope.request)
  }

  public createObjectOutput<TOutput>(
    input: ModelRequestObjectOutputInput<TOutput>
  ): ModelRequestObjectOutput<TOutput> {
    return AiOutput.object({
      schema: input.schema,
      name: input.schemaName,
      description: input.schemaDescription,
    })
  }
}

export { AiSdkModelRequestTransport }
export type { AiSdkModelRequestTransportOptions }
