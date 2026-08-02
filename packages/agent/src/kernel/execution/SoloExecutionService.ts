import type { ModelMessage } from 'ai'

import type { ExecutionRecord } from '@velaros-ai/core/types'

import type { AgentExecutionConfig } from '../../agent/RuntimeConfiguration'
import type { AgentRuntimeInputPort } from '../../agent/RuntimeInputPort'

import type { ExecutionEventBus } from './ExecutionEventBus'
import type { ExecutionService } from './ExecutionService'

/**
 * {@link SoloExecutionService} 需要的主 Agent 运行器端口。
 *
 * 只声明 Solo 会用到的单人主 Agent 流式执行动词。协作能力由 capability package
 * 通过普通工具/事件端口注入，不在 Kernel execution facade 维护产品专用方法。
 */
interface SoloExecutionAgentRunner {
  streamSoloWorker(
    messages: ModelMessage[],
    config: AgentExecutionConfig,
    events: ExecutionEventBus,
    options: {
      consumeGuidance?: () => Nullable<ModelMessage>
      runtimeInput?: AgentRuntimeInputPort
    }
  ): Promise<void>
}

/**
 * {@link SoloExecutionService.run} 入参。
 */
interface RunSoloExecutionParams {
  /** 宿主来源会话 id；串联 stream、ExecutionRecord 与能力作用域上下文。 */
  sourceSessionId: string
  /** 同一 renderer session 内的宿主 scope 元数据。 */
  sourceScopeMetadata?: LooseOptional<Record<string, unknown>>
  /** 已由 {@link ChatExecutionCoordinator} 转换的历史。 */
  messages: ModelMessage[]
  /** 模型、权限、skills、surface、abortController（由 ManagedRunner 注入）等。 */
  config: AgentExecutionConfig
  /** 调用方的取消信号；托管执行启动后会桥接到内部 abortController。 */
  abortSignal?: AbortSignal
  /** 事件出口；Coordinator 绑到 {@link ChatStreamBridge}。 */
  events: ExecutionEventBus
}

/**
 * 统一主 Agent 执行入口的薄包装。
 *
 * ## 在链路中的位置
 * ```
 * ChatExecutionCoordinator.run
 *   → SoloExecutionService.run
 *   → ExecutionService.runManagedExecution（互斥、记录、abort、tool API）
 *   → AgentRunner.streamSoloWorker（@velaros-ai/agent loop）
 * ```
 *
 * 复杂任务通过主 Agent 的 `agent:dispatch` 工具按需派发子 Agent。
 */
class SoloExecutionService {
  constructor(
    /** 执行生命周期托管：create record、session 互斥、complete/fail/abort。 */
    private readonly executionService: ExecutionService,
    /** 主进程 AgentRunner；实际 multi-turn 在 agent-runtime SoloStreamLoop。 */
    private readonly agentRunner: SoloExecutionAgentRunner
  ) {}

  /**
   * 启动一轮主 Agent 聊天执行并返回最终 {@link ExecutionRecord}。
   *
   * run 回调内补齐 AgentExecutionConfig.sessionId / abortController / execution API，
   * 再委托 `streamSoloWorker`；`consumeGuidance` 消费用户中途注入的 guidance 消息。
   */
  public async run(params: RunSoloExecutionParams): Promise<ExecutionRecord> {
    return this.executionService.runManagedExecution({
      sourceSessionId: params.sourceSessionId,
      sourceScopeMetadata: params.sourceScopeMetadata,
      messages: params.messages,
      events: params.events,
      collaborationActor: {
        kind: 'main-agent',
        operation: 'main agent run',
        summary: 'running agent turn',
      },
      run: async ({
        execution,
        abortController,
        executionApi,
        events,
        consumeGuidance,
        runtimeInput,
      }) => {
        const unbindAbortSignal = bindAbortSignal(params.abortSignal, abortController)
        try {
          const soloWorkerConfig: AgentExecutionConfig = {
            ...params.config,
            sessionId: execution.sourceSessionId,
            abortController,
            execution: executionApi,
          }

          await this.agentRunner.streamSoloWorker(params.messages, soloWorkerConfig, events, {
            consumeGuidance,
            runtimeInput,
          })
        } finally {
          unbindAbortSignal()
        }
      },
    })
  }

}

function bindAbortSignal(
  source: LooseOptional<AbortSignal>,
  target: AbortController
): () => void {
  if (!source) return () => {}
  const abort = (): void => {
    if (!target.signal.aborted) target.abort(source.reason)
  }
  if (source.aborted) {
    abort()
    return () => {}
  }
  source.addEventListener('abort', abort, { once: true })
  return () => source.removeEventListener('abort', abort)
}

export { SoloExecutionService }
export type { RunSoloExecutionParams, SoloExecutionAgentRunner }
