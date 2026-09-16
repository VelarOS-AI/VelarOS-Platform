import { generateText, streamText, type ToolSet } from 'ai'

import type { AgentContextSemanticSummaryInput, AgentModelRequestPort, AgentModelStreamInput, AgentModelStreamResult } from '../../types/loop.js'
import { applyModelRequestPolicy } from '../../utils/loop/ai-sdk-agent-model-request-port'

/** 构造参数：只为测试替身留的两个注入口，生产装配一律留空走 AI SDK 原函数。 */
interface AiSdkAgentModelRequestPortOptions {
  /** 顶掉 `generateText`（非流式一次性调用）；缺省用 AI SDK 的实现。 */
  generateText?: typeof generateText
  /** 顶掉 `streamText`（流式调用）；缺省用 AI SDK 的实现。 */
  streamText?: typeof streamText
}

/**
 * 模型请求传输口：一次回合里唯一真正把请求交给 AI SDK 的地方。
 *
 * 谁调它：`StreamTurn`（主面）与 `QueryTurn`（子 Agent 面）各自持有一个实例（构造参数缺省 new 一个），
 * 在把 system / messages / tools / abortSignal 编译完、上下文纪元校验通过之后才调，一轮最多一次。
 * 这里不选 provider、不读密钥、不持有全局 model registry：model 实例由调用方传进来。
 *
 * 失败语义：开流本身只做同步转交，网络错误在消费 `fullStream` 时才抛；中断靠入参里的
 * `abortSignal`（`LinkedAbortScope` 给的那一根）传播，本类不自己取消也不重试——重试归 `RetryPolicy`。
 */
export interface AiSdkAgentModelRequestPortApi extends AgentModelRequestPort {
  /**
   * 开一轮主面流式请求：同步返回流句柄，`fullStream` 交给 `StreamConsumer` 逐块消费。
   * 入参的 `abortSignal` 一断，流随之结束并向消费方抛中断。
   */
  openAgentStreamTurn<TToolSet extends ToolSet = ToolSet>(
    input: AgentModelStreamInput<TToolSet>
  ): AgentModelStreamResult<TToolSet>
  /**
   * 开一轮子 Agent 请求。名字叫 query，走的仍是流式接口：子 Agent 也要在流中即时排入工具调用，
   * 与主面保持同一套并发执行行为；差别只在结果不投影给界面（见 `QueryTurn` 的判词）。
   */
  openAgentQueryTurn<TToolSet extends ToolSet = ToolSet>(
    input: AgentModelStreamInput<TToolSet>
  ): AgentModelStreamResult<TToolSet>
  /**
   * 上下文语义摘要用的一次性非流式调用：不进回合轴、不产工具调用，等模型收敛后返回整段文本。
   * 请求策略（temperature / topP / maxOutputTokens）按 `modelRequestOptions` 补齐后再发。
   */
  summarizeContextSemantics(input: AgentContextSemanticSummaryInput): Promise<string>
}

/**
 * Agent 模块的 AI SDK transport 适配器。
 *
 * 这里不选择 provider、不读取密钥，也不拥有全局 Model registry。
 */
class AiSdkAgentModelRequestPort implements AiSdkAgentModelRequestPortApi {
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

export {
  AiSdkAgentModelRequestPort,
  applyModelRequestPolicy,
}
export type { AiSdkAgentModelRequestPortOptions }
