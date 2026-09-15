import type { QueryLoop } from '../impl/loop/QueryLoop'
import type { SoloStreamLoop } from '../impl/loop/SoloStreamLoop'
import type { ExecutionEventBus } from '../impl/records/ExecutionEventBus'
import type { PrimaryAgentProfile } from '../impl/runner/PrimaryAgentProfile'
import type { AgentRuntimeCapabilityPorts } from '../utils/capabilities'
import type { AgentExecutionLimitOverrides } from '../utils/loop/execution-limits'

import type { AgentSurfaceProfileProvider } from './agent-surface-profile'
import type {
  RunnerCodingSessionPolicyBundle,
  RunnerConfigService,
  RunnerExecutionEnvironmentPort,
  RunnerSubAgentDispatcher,
  RunnerToolContext,
  RunnerToolContextBuilder,
  RunnerToolRegistry,
} from './runner-host-ports'

export interface AgentRunnerComponents<TToolContext extends RunnerToolContext> {
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
