import {
  generateText,
  streamText,
  type ToolSet,
} from 'ai'

import { isFiniteNumber } from '@velaros-ai/core'

import type { AgentModelRequestOptions } from '../../contract/requires.js'
import type { AgentContextSemanticSummaryInput, AgentModelRequestPort, AgentModelStreamInput, AgentModelStreamResult, ModelRequestPolicyTarget } from '../../types/loop.js'

interface AiSdkAgentModelRequestPortOptions {
  generateText?: typeof generateText
  streamText?: typeof streamText
}

/**
 * Agent 模块的 AI SDK transport 适配器。
 *
 * 这里不选择 provider、不读取密钥，也不拥有全局 Model registry。
 */
class AiSdkAgentModelRequestPort implements AgentModelRequestPort {
  private readonly generateTextImpl: typeof generateText
  private readonly streamTextImpl: typeof streamText

  constructor(options: AiSdkAgentModelRequestPortOptions = {}) {
    this.generateTextImpl = options.generateText ?? generateText
    this.streamTextImpl = options.streamText ?? streamText
  }

  public openAgentStreamTurn<TToolSet extends ToolSet = ToolSet>(
    input: AgentModelStreamInput<TToolSet>
  ): AgentModelStreamResult<TToolSet> {
    return this.streamTextImpl<TToolSet>(input)
  }

  public openAgentQueryTurn<TToolSet extends ToolSet = ToolSet>(
    input: AgentModelStreamInput<TToolSet>
  ): AgentModelStreamResult<TToolSet> {
    return this.streamTextImpl<TToolSet>(input)
  }

  public async summarizeContextSemantics(
    input: AgentContextSemanticSummaryInput
  ): Promise<string> {
    const result = await this.generateTextImpl(
      applyModelRequestPolicy(
        {
          model: input.model,
          system: input.system,
          messages: [{ role: 'user', content: input.prompt }],
          abortSignal: input.abortSignal,
          maxOutputTokens: input.maxOutputTokens,
        },
        input.modelRequestOptions
      )
    )
    return result.text
  }
}

function applyPolicyNumber(
  current: Optional<number>,
  policyValue: Optional<number>
): number | undefined {
  if (isFiniteNumber(current)) return current
  return isFiniteNumber(policyValue) ? policyValue : current
}

function applyModelRequestPolicy<TRequest extends object>(
  request: TRequest,
  modelRequestOptions?: LooseOptional<AgentModelRequestOptions>
): TRequest {
  const policy = modelRequestOptions?.requestPolicy
  if (!policy) return request

  const target = request as TRequest & ModelRequestPolicyTarget
  return {
    ...target,
    temperature: applyPolicyNumber(target.temperature, policy.temperature),
    topP: applyPolicyNumber(target.topP, policy.topP),
    maxOutputTokens: applyPolicyNumber(target.maxOutputTokens, policy.maxOutputTokens),
  } as TRequest
}

export {
  AiSdkAgentModelRequestPort,
  applyModelRequestPolicy,
}
export type { AiSdkAgentModelRequestPortOptions }
