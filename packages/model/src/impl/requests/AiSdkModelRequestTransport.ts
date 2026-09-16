import {
  generateText,
  Output as AiOutput,
  streamText,
  type ToolSet,
} from 'ai'

import type { ModelRequestTransport } from '../../contract/requires'
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
} from '../../types/requests'

/** 内置 transport 要什么：两个实现都可选，不给就用 AI SDK 的。 */
export interface AiSdkModelRequestTransportOptions {
  /** 替换非流式实现，测试与录制回放靠它。 */
  generateText?: ModelRequestGenerateText
  /** 替换流式实现，测试与录制回放靠它。 */
  streamText?: ModelRequestStreamText
}

/** 直接落在 AI SDK 上的默认 transport；宿主不注入自己的 transport 时用它。 */
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
