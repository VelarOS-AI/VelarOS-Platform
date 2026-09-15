/**
 * 稳定的产品宿主集成面。
 *
 * 此入口包含注入端口、能力扩展契约和 Kernel 适配器。产品 UI、持久化、凭据与策略仍由
 * 实现这些契约的宿主持有。
 */
export type {
  AgentModelProvider,
  AgentModelRequestOptions,
  AgentModelRequestPolicy,
  AgentModelResolverPort,
  ResolvedAgentModelRuntime,
} from '../agent/model/ModelContracts'
export type {
  AgentSurfaceProfile,
  AgentSurfaceProfileProvider,
  DerivedAgentSurfaceRunPolicy,
  DeriveSurfaceRunPolicyInput,
  ResolveAgentSurfaceInput,
} from '../agent/runner/AgentSurfaceProfile'
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
} from '../agent/runner/host-ports'
export type { AgentRuntimeEventBus } from '../agent/RuntimeEvents'
export { AgentRuntimeEvents } from '../agent/RuntimeEvents'
export type {
  AgentRuntimeInputInterruptScope,
  AgentRuntimeInputPort,
  AgentRuntimeInputResult,
} from '../agent/RuntimeInputPort'
export { createAgentRuntimeInputInterruptScope } from '../agent/RuntimeInputPort'
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
} from '../capabilities/CapabilityExtensions'
export type {
  CapabilityCommandResult,
  CapabilityValidationGoal,
  CapabilityValidationRunResult,
  CapabilityValidationStatus,
  CapabilityValidationSuggestion,
  CapabilityValidationSummary,
} from '../capabilities/CapabilityValidation'
export type {
  AgentCapabilityExecutionContext,
  AgentCapabilityRuntime,
  AgentCapabilityService,
  CreateAgentKernelModuleOptions,
} from '../kernel-module'
export {
  AgentCapability,
  AgentExecutionPermission,
  AgentKernelModuleId,
  createAgentKernelModule,
} from '../kernel-module'
export type { AgentModelInputModality } from '../protocol/types/tool'
