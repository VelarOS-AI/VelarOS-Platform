import {
  generateText,
  streamText,
  type ToolSet,
} from 'ai'

import { isFiniteNumber } from '@velaros-ai/core'

import type { AgentModelRequestOptions } from './ModelContracts'

type AgentModelStreamInput<TToolSet extends ToolSet = ToolSet> = Parameters<
  typeof streamText<TToolSet>
>[0]

type AgentModelStreamResult<TToolSet extends ToolSet = ToolSet> = ReturnType<
  typeof streamText<TToolSet>
>

interface AgentContextSemanticSummaryInput {
  model: Parameters<typeof generateText>[0]['model']
  system: string
  prompt: string
  abortSignal?: Parameters<typeof generateText>[0]['abortSignal']
  maxOutputTokens?: Parameters<typeof generateText>[0]['maxOutputTokens']
  modelRequestOptions?: AgentModelRequestOptions
}

/**
 * Agent 消费的最小模型请求端口。
 *
 * Provider 解析和 LanguageModel 创建属于 Model 模块；Agent 只接收已解析模型并发起自己的
 * turn/summary 请求。宿主可以注入远程 transport，默认实现直接使用 AI SDK。
 */
interface AgentModelRequestPort {
  openAgentStreamTurn<TToolSet extends ToolSet = ToolSet>(
    input: AgentModelStreamInput<TToolSet>
  ): AgentModelStreamResult<TToolSet>
  openAgentQueryTurn<TToolSet extends ToolSet = ToolSet>(
    input: AgentModelStreamInput<TToolSet>
  ): AgentModelStreamResult<TToolSet>
  summarizeContextSemantics(input: AgentContextSemanticSummaryInput): Promise<string>
}

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

type ModelRequestPolicyTarget = {
  temperature?: number
  topP?: number
  maxOutputTokens?: number
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
export type {
  AgentContextSemanticSummaryInput,
  AgentModelRequestPort,
  AgentModelStreamInput,
  AgentModelStreamResult,
  AiSdkAgentModelRequestPortOptions,
}
