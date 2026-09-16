

import type { AgentExecutionConfig } from '../../contract/requires.js'
import type { ExecutionRecord } from '../../types/agent.js'
import type { RunSoloExecutionParams, SoloExecutionAgentRunner } from '../../types/execution.js'
import { bindAbortSignal } from '../../utils/execution/solo-execution'

import type { ExecutionServiceApi } from './ExecutionService'

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
export interface SoloExecutionServiceApi {
  /**
   * 跑一轮主 Agent 聊天执行，返回终态 {@link ExecutionRecord}（`completed` / `aborted` / `failed` 都从这里正常返回）。
   *
   * 自身不管生命周期：互斥、记录、收尾全由 `ExecutionService.runManagedExecution` 负责，本方法只在它给的 run 回调里
   * 补齐 sessionId / abortController / execution API，再把外部传来的 `abortSignal` 绑到托管的 controller 上（回调结束即解绑）。
   */
  run(params: RunSoloExecutionParams): Promise<ExecutionRecord>
}

class SoloExecutionService implements SoloExecutionServiceApi {
  constructor(
    /** 执行生命周期托管：create record、session 互斥、complete/fail/abort。 */
    private readonly executionService: ExecutionServiceApi,
    /** 主进程 AgentRunner；实际 multi-turn 在 Agent 的 SoloStreamLoop。 */
    private readonly agentRunner: SoloExecutionAgentRunner
  ) {}

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

/** 建一台 Solo 执行服务：主会话回合的入口。 */
export function createSoloExecutionService(executionService: ExecutionServiceApi, agentRunner: SoloExecutionAgentRunner): SoloExecutionServiceApi {
  return new SoloExecutionService(executionService, agentRunner)
}
