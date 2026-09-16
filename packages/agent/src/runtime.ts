/**
 * 稳定的高层 Agent 执行面。
 *
 * 产品宿主应通过此入口装配运行，避免从包根入口逐项导入循环、回合、上下文或结束辅助实现。
 */
export type { AgentExecutionStack, AgentExecutionStackApi, AgentExecutionStackWithQuery, AgentExecutionStackWithQueryApi } from './contract/provides.js'
export type { AgentChatRuntimeConfig, AgentExecutionConfig, AgentSystemRuntimeConfig } from './contract/requires.js'
export type { AgentModelRetryPolicy, AgentRunLifecycle } from './contract/requires.js'
export type { ExecutionClock, ExecutionIdFactory } from './contract/requires.js'
export type { AgentExecutionStackToolRegistry } from './contract/requires.js'
export { createAgentExecutionStack } from './impl/assembly/AgentExecutionStack'
export type { PromptRegistry } from './impl/guidance/PromptRegistry'
export { createBuiltInPromptRegistry } from './impl/guidance/PromptRegistry'
export { MonotonicExecutionIdFactory } from './impl/records/MonotonicExecutionIdFactory'
export type { BuiltInPromptOptions } from './types/guidance.js'
export type { AgentExecutionLimitOverrides, AgentExecutionLimits } from './types/loop.js'
export type { AgentTurnBoundary, AgentTurnSettlement } from './types/runner.js'
export type { AgentExecutionStackOptions, AgentExecutionStackRunnerOptions, AgentExecutionStackToolContext } from './types/runner.js'
export type { AgentRunProfileCatalogSnapshot } from './types/runner.js'
export {
  DefaultAgentExecutionLimits,
  resolveAgentExecutionLimits,
} from './utils/loop/execution-limits'
export {
  describeRunProfiles,
  resolveRunProfileForRuntime,
  resolveRunProfilePolicyForRuntime,
  RunProfileDefinitions,
} from './utils/runner/runtime-profiles'
