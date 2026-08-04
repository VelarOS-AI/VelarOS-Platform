import type { ScopedLog } from '@velaros-ai/core/logger'
import { asRecord } from '@velaros-ai/core/utils/unknownJsonRecord'

import type { ExecutionEventBus } from '../../kernel/execution/ExecutionEventBus'
import { AgentRuntimeEvents } from '../RuntimeEvents'

import type {
  RunnerAgentProvider,
  RunnerModelCapabilityPort,
  RunnerModelRuntimePort,
  RunnerResolvedAgentRuntime,
} from './host-ports'

/**
 * Agent 运行配置、运行事件与注入 Model capability 的唯一组合桥。
 *
 * Agent 自己拥有 `modelSelection` / `modelRuntimeContext` 外层配置字段，因此也必须在这里统一
 * 剥壳后交给 Model domain。Host 只负责注入 capability，不得各自复制这条映射规则。
 */
class ModelRuntime implements RunnerModelRuntimePort {
  private readonly runtimeEvents = new AgentRuntimeEvents()

  constructor(private readonly modelCapability: RunnerModelCapabilityPort) {}

  public createAgentProvider(
    config: Parameters<RunnerModelCapabilityPort['createAgentProvider']>[0]
  ): RunnerAgentProvider {
    return this.modelCapability.createAgentProvider(
      asRecord(config)?.modelSelection ?? config
    )
  }

  public resolveRoleRuntime(
    config: Parameters<RunnerModelCapabilityPort['resolveRoleRuntime']>[0],
    systemRuntimeConfig: Parameters<RunnerModelCapabilityPort['resolveRoleRuntime']>[1]
  ): Promise<RunnerResolvedAgentRuntime> {
    return this.modelCapability.resolveRoleRuntime(
      asRecord(config)?.modelSelection ?? config,
      asRecord(systemRuntimeConfig)?.modelRuntimeContext ?? systemRuntimeConfig
    )
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

  public emitAbort(events: ExecutionEventBus, message = '运行被终止'): void {
    this.runtimeEvents.emitAbort(events, message)
  }
}

export { ModelRuntime }
export type {
  RunnerAgentProvider as AgentProvider,
  RunnerResolvedAgentRuntime as ResolvedAgentRuntime,
}
export { ModelRuntime as AgentRuntimeHelper }
