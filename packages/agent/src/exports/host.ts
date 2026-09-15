/**
 * 稳定的产品宿主集成面。
 *
 * 此入口包含注入端口、能力扩展契约和 Kernel 适配器。产品 UI、持久化、凭据与策略仍由
 * 实现这些契约的宿主持有。
 */
export type {
  AgentCapabilityExecutionContext,
  AgentCapabilityRuntime,
  AgentCapabilityService,
  CreateAgentKernelModuleOptions,
} from '../impl/assembly/AgentKernelModule'
export {
  AgentCapability,
  AgentExecutionPermission,
  AgentKernelModuleId,
  createAgentKernelModule,
} from '../impl/assembly/AgentKernelModule'
export type {
  AgentSurfaceProfile,
  AgentSurfaceProfileProvider,
  DerivedAgentSurfaceRunPolicy,
  DeriveSurfaceRunPolicyInput,
  ResolveAgentSurfaceInput,
} from '../types/agent-surface-profile'
export type {
  CapabilityCommandResult,
  CapabilityValidationGoal,
  CapabilityValidationRunResult,
  CapabilityValidationStatus,
  CapabilityValidationSuggestion,
  CapabilityValidationSummary,
} from '../types/capability-validation'
export type {
  AgentModelProvider,
  AgentModelRequestOptions,
  AgentModelRequestPolicy,
  AgentModelResolverPort,
  ResolvedAgentModelRuntime,
} from '../types/model-contracts'
export type {
  CodingSessionTrackerLike,
  RunnerAgentProvider,
  RunnerBuildToolContextArgs,
  RunnerCancelBackgroundJob,
  RunnerCodingSessionPolicyBundle,
  RunnerConfigService,
  RunnerContextCodingSession,
  RunnerExecutionEnvironmentPort,
  RunnerExecutionScope,
  RunnerModelCapabilityPort,
  RunnerModelRuntimePort,
  RunnerReadBackgroundJobOutput,
  RunnerResolvedAgentRuntime,
  RunnerSubAgentDispatcher,
  RunnerSubAgentOptions,
  RunnerToolContext,
  RunnerToolContextBuilder,
  RunnerToolRegistry,
  RunnerWaitBackgroundJobs,
} from '../types/runner-host-ports'
export type { AgentModelInputModality } from '../types/tool'
export type {
  AgentRuntimeCapabilityDescriptor,
  AgentRuntimeCapabilityExtension,
  AgentRuntimeCapabilityPorts,
  CapabilityContextCollector,
  CapabilityDelegationPolicy,
  CapabilityIntentClassifier,
  CapabilityIntentClassifierContext,
  CapabilityIntentSignal,
  CapabilityPromptContributor,
  CapabilityScopeCategoryDecision,
  CapabilityScopePolicy,
  CapabilityScopeResidency,
  CapabilityScopeRuntimeFacts,
  CapabilityValidationInterpretation,
  CapabilityValidationInterpreter,
  collectCapabilityContext,
  decideCapabilityScopeCategory,
  expandCapabilityCategoryIds,
  resolveCapabilityCategoryDefinitions,
  resolveCapabilityContextCollectors,
  resolveCapabilityDelegationPolicy,
  resolveCapabilityIntentClassifiers,
  resolveCapabilityPromptSegments,
  resolveCapabilityScopeId,
  resolveCapabilityScopePolicy,
  resolveCapabilityScopeResidency,
  resolveCapabilityValidationInterpreters,
  resolveToolAliases,
  resolveToolAllocationMetadata,
  resolveToolResultMiddlewares,
  resolveToolValidationHintProviders,
  ToolAllocationDelegation,
  ToolAllocationMetadata,
  ToolAllocationPrerequisite,
  ToolResultMiddleware,
  ToolResultMiddlewareContext,
  ToolResultMiddlewareResult,
  ToolResultModelImage,
  ToolValidationHintContext,
  ToolValidationHintProvider,
  ToolValidationIssueDetail,
  ToolValidationRecovery,
} from '../utils/capabilities'
export type { AgentRuntimeEventBus } from '../utils/runner/runtime-events'
export { AgentRuntimeEvents } from '../utils/runner/runtime-events'
export type {
  AgentRuntimeInputInterruptScope,
  AgentRuntimeInputPort,
  AgentRuntimeInputResult,
} from '../utils/runner/runtime-input-port'
export { createAgentRuntimeInputInterruptScope } from '../utils/runner/runtime-input-port'
