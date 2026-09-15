/**
 * 稳定的高层 Agent 执行面。
 *
 * 产品宿主应通过此入口装配运行，避免从包根入口逐项导入循环、回合、上下文或结束辅助实现。
 */
export type {
  AgentExecutionStack,
  AgentExecutionStackOptions,
  AgentExecutionStackRunnerOptions,
  AgentExecutionStackToolContext,
  AgentExecutionStackToolRegistry,
  AgentExecutionStackWithQuery,
} from '../impl/assembly/AgentExecutionStack'
export { createAgentExecutionStack } from '../impl/assembly/AgentExecutionStack'
export type { PromptRegistry } from '../impl/guidance/PromptRegistry'
export type {
  ExecutionClock,
  ExecutionIdFactory,
} from '../impl/records/MonotonicExecutionIdFactory'
export { MonotonicExecutionIdFactory } from '../impl/records/MonotonicExecutionIdFactory'
export type {
  AgentModelRetryPolicy,
  AgentRunLifecycle,
  AgentTurnBoundary,
  AgentTurnSettlement,
} from '../types/run-lifecycle'
export type {
  AgentChatRuntimeConfig,
  AgentExecutionConfig,
  AgentSystemRuntimeConfig,
} from '../types/runtime-configuration'
export type { BuiltInPromptOptions } from '../utils/guidance/catalog'
export { createBuiltInPromptRegistry } from '../utils/guidance/catalog'
export type {
  AgentExecutionLimitOverrides,
  AgentExecutionLimits,
} from '../utils/loop/execution-limits'
export {
  DefaultAgentExecutionLimits,
  resolveAgentExecutionLimits,
} from '../utils/loop/execution-limits'
export type { AgentRunProfileCatalogSnapshot } from '../utils/runner/runtime-profiles'
export {
  describeRunProfiles,
  resolveRunProfileForRuntime,
  resolveRunProfilePolicyForRuntime,
  RunProfileDefinitions,
} from '../utils/runner/runtime-profiles'
