import { generateText, Output as AiOutput, streamText, type ToolSet } from 'ai'

import type {
  ModelRequestEnvelope,
  ModelRequestGenerateText,
  ModelRequestGenerateTextInput,
  ModelRequestObjectOutputInput,
  ModelRequestStreamText,
  ModelRequestStreamTextInput,
  ModelRequestStreamTextResult,
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

  public generateText(
    envelope: ModelRequestEnvelope<ModelRequestGenerateTextInput>
  ): ReturnType<ModelRequestGenerateText> {
    return this.generateTextImpl(envelope.request)
  }

  public streamText<TToolSet extends ToolSet = ToolSet>(
    envelope: ModelRequestEnvelope<ModelRequestStreamTextInput<TToolSet>>
  ): ModelRequestStreamTextResult<TToolSet> {
    return this.streamTextImpl<TToolSet>(envelope.request)
  }

  public createObjectOutput(
    input: ModelRequestObjectOutputInput
  ): ModelRequestGenerateTextInput['output'] {
    return AiOutput.object({
      schema: input.schema as Parameters<typeof AiOutput.object>[0]['schema'],
      name: input.schemaName,
      description: input.schemaDescription,
    })
  }
}

export { AiSdkModelRequestTransport }
export type { AiSdkModelRequestTransportOptions }
