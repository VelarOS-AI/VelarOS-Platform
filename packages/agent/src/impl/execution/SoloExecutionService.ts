

import type { AgentExecutionConfig } from '../../contract/requires.js'
import type { ExecutionRecord } from '../../types/agent.js'
import type { RunSoloExecutionParams,SoloExecutionAgentRunner } from '../../types/execution.js'
import { bindAbortSignal } from '../../utils/execution/solo-execution'

import type { ExecutionService } from './ExecutionService'

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
    /** 主进程 AgentRunner；实际 multi-turn 在 Agent 的 SoloStreamLoop。 */
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



export { SoloExecutionService }
