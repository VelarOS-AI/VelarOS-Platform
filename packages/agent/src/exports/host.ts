/**
 * 稳定的产品宿主集成面。
 *
 * 此入口包含注入端口、能力扩展契约和 Kernel 适配器。产品 UI、持久化、凭据与策略仍由
 * 实现这些契约的宿主持有。
 */
export type { AgentModelProvider, AgentModelRequestOptions, AgentModelRequestPolicy, AgentModelResolverPort } from '../contract/requires.js'
export type { RunnerConfigService, RunnerExecutionEnvironmentPort, RunnerModelRuntimePort, RunnerSubAgentDispatcher, RunnerToolContextBuilder, RunnerToolRegistry } from '../contract/requires.js'
export type { AgentSurfaceProfileProvider } from '../contract/requires.js'
export type { AgentCapabilityRuntime, CreateAgentKernelModuleOptions } from '../contract/requires.js'
export type { AgentRuntimeInputPort } from '../contract/requires.js'
export type { AgentRuntimeCapabilityPorts, CapabilityContextCollector, CapabilityDelegationPolicy, CapabilityIntentClassifier, CapabilityPromptContributor, CapabilityScopePolicy, CapabilityValidationInterpreter, ToolAllocationMetadata, ToolResultMiddleware, ToolValidationHintProvider } from '../contract/requires.js'
export {
  AgentCapability,
  AgentExecutionPermission,
  AgentKernelModuleId,
  createAgentKernelModule,
} from '../impl/assembly/AgentKernelModule'
export type { AgentModelInputModality } from '../types/agent.js'
export type { CapabilityCommandResult, CapabilityValidationGoal, CapabilityValidationRunResult, CapabilityValidationStatus, CapabilityValidationSuggestion, CapabilityValidationSummary } from '../types/capabilities.js'
export type { AgentRuntimeCapabilityDescriptor, AgentRuntimeCapabilityExtension, CapabilityIntentClassifierContext, CapabilityIntentSignal, CapabilityScopeCategoryDecision, CapabilityScopeResidency, CapabilityScopeRuntimeFacts, CapabilityValidationInterpretation, ToolAllocationDelegation, ToolAllocationPrerequisite, ToolResultMiddlewareContext, ToolResultMiddlewareResult, ToolResultModelImage, ToolValidationHintContext, ToolValidationIssueDetail, ToolValidationRecovery } from '../types/capabilities.js'
export type { AgentCapabilityExecutionContext, AgentCapabilityService } from '../types/execution.js'
export type { ResolvedAgentModelRuntime } from '../types/loop.js'
export type { CodingSessionTrackerLike, RunnerAgentProvider, RunnerBuildToolContextArgs, RunnerCancelBackgroundJob, RunnerCodingSessionPolicyBundle, RunnerContextCodingSession, RunnerExecutionScope, RunnerModelCapabilityPort, RunnerReadBackgroundJobOutput, RunnerResolvedAgentRuntime, RunnerSubAgentOptions, RunnerToolContext, RunnerWaitBackgroundJobs } from '../types/runner.js'
export type { AgentSurfaceProfile, DerivedAgentSurfaceRunPolicy, DeriveSurfaceRunPolicyInput, ResolveAgentSurfaceInput } from '../types/runner.js'
export type { AgentRuntimeInputInterruptScope, AgentRuntimeInputResult } from '../types/runner.js'
export type { AgentRuntimeEventBus } from '../types/runner.js'
export type { collectCapabilityContext, decideCapabilityScopeCategory, expandCapabilityCategoryIds, resolveCapabilityCategoryDefinitions, resolveCapabilityContextCollectors, resolveCapabilityDelegationPolicy, resolveCapabilityIntentClassifiers, resolveCapabilityPromptSegments, resolveCapabilityScopeId, resolveCapabilityScopePolicy, resolveCapabilityScopeResidency, resolveCapabilityValidationInterpreters, resolveToolAliases, resolveToolAllocationMetadata, resolveToolResultMiddlewares, resolveToolValidationHintProviders } from '../utils/capabilities'
export { AgentRuntimeEvents } from '../utils/runner/runtime-events'
export { createAgentRuntimeInputInterruptScope } from '../utils/runner/runtime-input-port'
