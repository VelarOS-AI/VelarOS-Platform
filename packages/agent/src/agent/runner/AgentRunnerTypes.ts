import type { AgentRuntimeCapabilityPorts } from '../../capabilities'
import type { ExecutionEventBus } from '../../kernel/execution/ExecutionEventBus'
import type { AgentExecutionLimitOverrides } from '../ExecutionLimits'
import type { PrimaryAgentProfile } from '../PrimaryAgentProfile'
import type { QueryLoop } from '../QueryLoop'
import type { SoloStreamLoop } from '../SoloLoop'

import type { AgentSurfaceProfileProvider } from './AgentSurfaceProfile'
import type {
  RunnerCodingSessionPolicyBundle,
  RunnerConfigService,
  RunnerExecutionEnvironmentPort,
  RunnerModelRuntimePort,
  RunnerSubAgentDispatcher,
  RunnerToolContext,
  RunnerToolContextBuilder,
  RunnerToolRegistry,
} from './host-ports'

export interface AgentRunnerComponents<TToolContext extends RunnerToolContext> {
  runtimeHelper: RunnerModelRuntimePort
  contextHelper: RunnerToolContextBuilder<TToolContext>
  primaryAgentStreamLoop: SoloStreamLoop<TToolContext, ExecutionEventBus>
  queryLoop: QueryLoop<TToolContext, ExecutionEventBus>
  primaryAgentProfile: PrimaryAgentProfile
  subAgentDispatcher: RunnerSubAgentDispatcher<TToolContext>
}

export interface AgentRunnerDomainServices {
  executionEnvironment?: RunnerExecutionEnvironmentPort
}

export interface AgentRunnerInfrastructure {
  capabilityPorts?: AgentRuntimeCapabilityPorts
  executionLimitOverrides?: AgentExecutionLimitOverrides
  configService: RunnerConfigService
  toolRegistry: RunnerToolRegistry
  codingSessionPolicy: RunnerCodingSessionPolicyBundle
  surfaceProfileProvider: AgentSurfaceProfileProvider
}
