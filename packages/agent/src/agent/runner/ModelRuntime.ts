import { AppError } from '@velaros-ai/core/error'
import type { ScopedLog } from '@velaros-ai/core/logger'

import type { ExecutionEventBus } from '../../kernel/execution/ExecutionEventBus'
import { AgentRuntimeEvents } from '../RuntimeEvents'

import type {
  RunnerAgentProvider,
  RunnerModelCapabilityPort,
  RunnerModelRuntimePort,
  RunnerResolvedAgentRuntime,
} from './host-ports'

/**
 * Agent 运行事件与注入 Model capability 的组合桥。
 *
 * Provider 创建、密钥读取和角色模型解析由 Model 模块实现。兼容期允许无参构造以保持旧产品编译，
 * 但任何模型操作都会立即给出可读错误，避免静默回退到全局 registry。
 */
class ModelRuntime implements RunnerModelRuntimePort {
  private readonly runtimeEvents = new AgentRuntimeEvents()

  constructor(private readonly modelCapability?: RunnerModelCapabilityPort) {}

  public createAgentProvider(
    config: Parameters<RunnerModelCapabilityPort['createAgentProvider']>[0]
  ): RunnerAgentProvider {
    return this.requireModelCapability().createAgentProvider(config)
  }

  public resolveRoleRuntime(
    config: Parameters<RunnerModelCapabilityPort['resolveRoleRuntime']>[0],
    systemRuntimeConfig: Parameters<RunnerModelCapabilityPort['resolveRoleRuntime']>[1]
  ): Promise<RunnerResolvedAgentRuntime> {
    return this.requireModelCapability().resolveRoleRuntime(config, systemRuntimeConfig)
  }

  public handleStreamError(
    error: unknown,
    turn: number,
    abortSignal: AbortSignal,
    events: ExecutionEventBus,
    log: ScopedLog
  ): void {
    this.runtimeEvents.handleStreamError(error, turn, abortSignal, events, log)
  }

  public emitDone(events: ExecutionEventBus): void {
    this.runtimeEvents.emitDone(events)
  }

  public emitContextCompaction(
    input: {
      turn: number
      estimatedTokensBefore: number
      estimatedTokensAfter: number
      percentBefore: number
      percentAfter: number
      removedMessages: number
      passes: number
      targetPercent: number
    },
    events: ExecutionEventBus
  ): void {
    this.runtimeEvents.emitContextCompaction(input, events)
  }

  public emitAbort(events: ExecutionEventBus, message = '运行被终止'): void {
    this.runtimeEvents.emitAbort(events, message)
  }

  private requireModelCapability(): RunnerModelCapabilityPort {
    if (this.modelCapability) return this.modelCapability

    throw new AppError(
      'INTERNAL',
      'Agent Model capability 未注入。请由产品 composition root 提供 Model 模块端口。'
    )
  }
}

export { ModelRuntime }
export type {
  RunnerAgentProvider as AgentProvider,
  RunnerResolvedAgentRuntime as ResolvedAgentRuntime,
}
export { ModelRuntime as AgentRuntimeHelper }
