// `.` 入口：Node 宿主装 Agent 运行时要的全部整件能力。
//
// 值只有两类：`impl/` 里按公开接口标注过的实例与工厂，以及 `contract/constants.ts` 的常量表。
// 类、zod schema、utils 里的函数一律不出包——需要它们提供的能力时走这里登记的接口面。
// 渲染进程要的子集在 `./chat`，写工具要的子集在 `./tool-contract`，只要数据的在 `./contracts`。
export * from './chat.js'
export * from './contracts.js'
export * from './tool-contract.js'


// ── 合同：产品面与注入面的接口 ───────────────────────────────────────

export type { AgentCapabilityEventPublisherApi, AgentChatKitApi, AgentExecutionStackApi,
 AgentExecutionStackWithQueryApi, AgentGoalServiceApi, AgentLedgerFilesApi, AgentModHostAssemblerApi,
 AgentModLoaderApi, AgentModSeamDispatcherApi, AgentPlanServiceApi, AgentQuestionServiceApi,
 AgentRoleEngineApi, AgentRunnerApi, AgentRuntimeKitApi, AgentSessionKitApi, AgentSkillRepositoryApi,
 AgentToolContractsApi, AgentWireApi, AgentWorkflowRuntimeApi, ChatContextRetrievalServiceApi,
 ChatKernelSessionBridgeApi, ChatMessagesApi, ChatRuntimeEventsApi, ChatSearchMessagesApi,
 ChatSearchRankingApi, ChatStreamConsumerApi, ChatStreamProtocolApi, ChatStreamSessionLogApi,
 CodingSessionTrackerApi, ContextGovernanceSessionRegistryApi, DirectiveOperationsApi, ExecPlanLedgerApi,
 ExecPlanStateApi, ExecRoutingApi, ExecutionEventBusApi, ExecutionGuidanceQueueApi, ExecutionServiceApi,
 ExternalAgentBridgeCommandQueueApi, ExternalAgentBridgeEventWindowApi, ExternalAgentBridgeLoopbackServerApi,
 ExternalAgentBridgePairingThrottleApi, FileContextCoordinatorApi, FileContextRegistryApi, GuidanceRelayKitApi,
 KernelBackgroundJobManagerApi, KernelSessionControllerApi, LedgerExecutionSpanScopeFactoryApi,
 McpClientConnectionApi, McpToolTranslatorApi, PrimaryAgentProfileApi, PromptRegistryApi,
 ProviderRequestCompilerApi, ProviderTurnEventReducerApi, RetryPolicyApi, SessionLedgerHandleApi, SessionStoreApi, SkillFileStoreApi,
 SkillMarketClientApi, SoloExecutionServiceApi, SubAgentDispatcherApi, SubAgentGuidanceRelayRegistryApi,
 SubAgentSessionStoreApi, TeamModelRouterApi, ToolCapabilityRegistryApi, ToolContractExecutionFacadeApi,
ToolExecutionPolicyApi, ToolExecutorApi, ToolInputReuseStoreApi,  ToolRegistryApi, ToolTransportNamesApi, TurnContextAppendHubApi, TurnContextLedgerApi,
 TurnContextSessionLedgersApi, TurnHistoryApi, VelarModArchiveImporterApi, WriteLeaseCoordinatorApi } from './contract/provides.js'
export type { AgentModRegistryApi, ContextRetrievalQueryTraceStoreApi, ExecutionStoreApi, KernelSessionPolicyApi, KernelSessionRunCoordinatorApi, RuntimeReminderSchedulerApi, TaskApprovalStateApi } from './contract/provides.js'
export type { AgentBackgroundAgent, AgentBackgroundAgentControlPort, AgentBackgroundAgentPort,
 AgentBackgroundAgentState, AgentCapabilityRuntime, AgentChatRuntimeConfig, AgentExecutionConfig,
 AgentExecutionStackToolRegistry, AgentModelProvider, AgentModelRequestOptions,
 AgentModelRequestPolicy, AgentModelResolverPort, AgentModelRetryPolicy, AgentModPackReader, AgentRoleDescriptorProvider,
 AgentRunLifecycle, AgentRuntimeCapabilityPorts, AgentRuntimeInputPort, AgentSessionCatalogPort,
 AgentSessionCatalogQuery, AgentSessionEventPort, AgentSessionLease, AgentSessionLeaseClaim,
 AgentSessionLeasePort, AgentSessionLifecycleStatus, AgentSessionMetadata, AgentSessionResourceReference,
 AgentSkillProvider, AgentSurfaceProfileProvider, AgentSystemRuntimeConfig, AgentTurnCapabilitySnapshotSource,
ApprovalPort,  AppRuntimeFacts, AuthGatePort, CapabilityContextCollector, CapabilityDelegationPolicy,
 CapabilityIntentClassifier, CapabilityPromptContributor, CapabilityScopePolicy,
 CapabilityValidationInterpreter, ContextMigrationEventSink, ContextPayloadStore,
 CreateAgentKernelModuleOptions, CreateAgentSessionMetadataInput, CustomSubAgentRegistry,
 ExecutionActivitySignalsPort, ExecutionClock, ExecutionCollaborationPort, ExecutionGuidanceRelayPlanner,
 ExecutionIdFactory, ExecutionRecordsPathPort, ExecutionResourcePort, ExecutionSpanScopeFactory,
 InteractionPort, KernelBackgroundJobOutputStore, KernelSessionInputStore, KernelToolOutputStore,
 McpAuthorizationProvider, ReminderCapabilityResolver, RemoteHostServicePorts, RetrievalPayloadStorePort,
 RetrievalStateStorePort, RunnerConfigService, RunnerExecutionEnvironmentPort, RunnerModelRuntimePort,
 RunnerSubAgentDispatcher, RunnerToolContextBuilder, RunnerToolRegistry, RuntimePromptFeaturePolicy,
 RuntimeReminderProducer, SessionLedgerLocator, SessionStoreDeps, SubAgentConfigPort, SubAgentQueryRunner,
 SubAgentTypeProvider, TeamModelRoutingPort, ToolActiveContextApi, ToolAllocationMetadata,
 ToolConversationContextApi, ToolExecutionApi, ToolResultMiddleware, ToolRoleApi, ToolRuntimeApi,
 ToolSkillsApi, ToolValidationHintProvider, VelarModArchiveSignatureVerifier } from './contract/requires.js'

// ── 实例与工厂 ────────────────────────────────────────────────────────

export { agentModHost, agentTools, BuiltinAgentModId, createBuiltinAgentModDefinition } from './impl/AgentTools'
export { createAgentExecutionStack } from './impl/assembly/AgentExecutionStack'
export { AgentCapability, AgentExecutionPermission, AgentKernelModuleId, createAgentKernelModule } from './impl/assembly/AgentKernelModule'
export { createChatKernelSessionBridge } from './impl/assembly/ChatKernelSessionBridge'
export { createToolContractExecutionFacade } from './impl/assembly/ToolContractExecutionFacade'
export { directiveOperations } from './impl/builtin/DirectiveOperations'
export { createExternalAgentBridgeCommandQueue, externalAgentBridgeTokensEqual } from './impl/connectors/ExternalAgentBridgeCommandQueue'
export { createExternalAgentBridgeEventWindow } from './impl/connectors/ExternalAgentBridgeEventWindow'
export { createExternalAgentBridgeLoopbackServer } from './impl/connectors/ExternalAgentBridgeLoopbackServer'
export { createExternalAgentBridgePairingThrottle } from './impl/connectors/ExternalAgentBridgePairingThrottle'
export { createMcpClientConnection } from './impl/connectors/McpClientConnection'
export { mcpToolTranslator } from './impl/connectors/McpToolTranslator'
export { runRemoteNodeMcpStdio } from './impl/connectors/RemoteNodeMcpStdioEntry'
export { assertSafeHttpFetchUrl, safeFetch } from './impl/connectors/SafeHttpFetch'
export { fileContextRegistry } from './impl/context/FileContextRegistry'
export { createContextPayloadRef, createContextUserTextRef, createInMemoryContextPayloadStore } from './impl/context/InMemoryContextPayloadStore'
export { compileProviderSendRequest, createProviderRequestCompiler } from './impl/context/ProviderRequestCompiler'
export { createSubAgentDispatcher, resolveSubAgentExecutionKey } from './impl/delegation/SubAgentDispatcher'
export { createSubAgentSessionStore } from './impl/delegation/SubAgentSessionStore'
export { createTeamModelRouter } from './impl/delegation/TeamModelRouter'
export { createWriteLeaseCoordinator } from './impl/delegation/WriteLeaseCoordinator'
export { createAgentCapabilityEventPublisher } from './impl/execution/AgentCapabilityEventPublisher'
export { createExecutionService } from './impl/execution/ExecutionService'
export { createSoloExecutionService } from './impl/execution/SoloExecutionService'
export { createAgentSkillRepository } from './impl/guidance/AgentSkillRepository'
export { createFileSkillProvider } from './impl/guidance/FileSkillProvider'
export { createBuiltInPromptRegistry, createPromptRegistry } from './impl/guidance/PromptRegistry'
export { createSkillFileStore, formatSkillDisplayMarkdown, parseFrontmatter, parseFrontmatterList } from './impl/guidance/SkillFileStore'
export { createSkillMarketClient } from './impl/guidance/SkillMarketClient'
export { agentLedgerFiles } from './impl/ledgers/AgentLedgerFiles'
export { createLedgerExecutionSpanScopeFactory } from './impl/ledgers/LedgerExecutionSpanScopeFactory'
export { readPromptAuditFile } from './impl/ledgers/PromptAuditLedger'
export { createSessionLedger } from './impl/ledgers/SessionLedger'
export { createSessionStore } from './impl/ledgers/SessionStore'
export { agentRetryPolicy } from './impl/loop/RetryPolicy'
export { createAgentModLoader } from './impl/mods/AgentModLoader'
export { createAgentModSeamDispatcher } from './impl/mods/AgentModSeamDispatcher'
export { createVelarModArchiveImporter } from './impl/mods/VelarModArchiveImporter'
export { createAgentGoalService } from './impl/product-session/AgentGoalService'
export { createAgentPlanService } from './impl/product-session/AgentPlanService'
export { createAgentQuestionService } from './impl/product-session/AgentQuestionService'
export { agentSessionKit } from './impl/product-session/AgentSessionKit'
export { createExecutionPlanLedger } from './impl/records/ExecPlanLedger'
export { createExecutionPlanState } from './impl/records/ExecPlanState'
export { createExecutionRouting } from './impl/records/ExecRouting'
export { createExecutionEventBus, createNoopExecutionEventBus } from './impl/records/ExecutionEventBus'
export { createExecutionGuidanceQueue } from './impl/records/ExecutionGuidanceQueue'
export { guidanceRelay } from './impl/records/GuidanceRelayKit'
export { createBackgroundJobManager } from './impl/records/KernelBackgroundJobManager'
export { createSubAgentGuidanceRelayRegistry } from './impl/records/SubAgentGuidanceRelayRegistry'
export { createTurnContextAppendHub } from './impl/records/TurnContextAppendHub'
export { TurnContextProcessGeneration } from './impl/records/TurnContextLedger'
export { createTurnContextSessionLedgers } from './impl/records/TurnContextSessionLedgers'
export { agentTurnHistory } from './impl/records/TurnHistory'
export { createContextGovernanceSessionRegistry } from './impl/residency/ContextGovernanceSessionRegistry'
export { createJsonlContextMigrationEventSink } from './impl/residency/JsonlContextMigrationEventSink'
export { createChatContextRetrievalService } from './impl/retrieval/ChatContextRetrievalService'
export { chatSearchMessages } from './impl/retrieval/ChatSearchMessages'
export { chatSearchRanking } from './impl/retrieval/ChatSearchRanking'
export { createAgentRoleEngine } from './impl/runner/AgentRoleEngine'
export { agentRuntime } from './impl/runner/AgentRuntimeKit'
export { createAgentWorkflowRuntime } from './impl/runner/AgentWorkflowRuntime'
export { createPrimaryAgentProfile } from './impl/runner/PrimaryAgentProfile'
export { createCodingSessionTracker } from './impl/session/CodingSessionTracker'
export { createToolCapabilityRegistry } from './impl/tools/ToolCapabilityRegistry'
export { createToolExecutionPolicy } from './impl/tools/ToolExecutionPolicy'
export { createToolExecutor } from './impl/tools/ToolExecutor'
export { createToolRegistry } from './impl/tools/ToolRegistry'
export { toolTransportNames } from './impl/tools/ToolTransportNames'
export type { ActiveDirectiveArchiveDiagnostic, ActiveDirectiveArchiveResult, ActiveDirectiveContext,
 BuiltinAgentModOptions, BuiltinAgentModPackage, GoalConstraintReference, VelaTool } from './types/builtin.js'
export type { AgentRuntimeCapabilityDescriptor, AgentRuntimeCapabilityExtension, CapabilityCommandResult,
 CapabilityIntentClassifierContext, CapabilityIntentSignal, CapabilityScopeCategoryDecision,
 CapabilityScopeResidency, CapabilityScopeRuntimeFacts, CapabilityValidationInterpretation,
 CapabilityValidationRunResult, CapabilityValidationStatus, CapabilityValidationSuggestion,
 CapabilityValidationSummary, ToolAllocationDelegation, ToolAllocationPrerequisite,
 ToolResultMiddlewareContext, ToolResultMiddlewareResult, ToolResultModelImage, ToolValidationHintContext,
 ToolValidationIssueDetail, ToolValidationRecovery } from './types/capabilities.js'
export type { AgentBridgeDispatch, AgentBridgeOutput, ChatStreamLifecyclePhase, ChatStreamLogEntry,
 ChatStreamTerminationReason, ResolvedChatSendRequestOptions, StreamObservabilityEntry,
 TerminalRuntimeExecutionAction } from './types/chat.js'
export type { McpAutoApprovePolicy, McpConnectionSpec, McpRawCallResult, McpResourceContent,
 McpResourceDescriptor, McpToolAnnotations, McpToolCaller, McpToolDescriptor, McpTransportKind, RemoteHostTool,
 RemoteHostToolContext, RemoteHostToolEntry, SafeFetchOptions, TranslatedMcpTool,TranslateMcpToolInput } from './types/connectors.js'
export type { CreateExternalAgentBridgeCommandQueue, ExternalAgentBridgeLoopbackServerOptions } from './types/connectors.js'
export type { AgentLoopToolDescriptor, AgentLoopToolRegistry, CompiledProviderRequest, CompiledProviderSendRequest, CompileProviderRequestInput,
 CompileProviderSendRequestInput, ContextActiveTaskInput,
 ContextLedgerEntry, ContextPayloadRecord, ContextPinnedEvidenceInput, ContextRefRetrieval,
 ContextResourceItemStateInput, ContextResourceStateInput, ContextUsageWindow, ContextUserTextRecord,
 ContextWorkingSetReclaimAction, ContextWorkingSetRetrievalHandleInput, ContextWorkingSetZoneId,
 EstimateContextUsageOptions, FileContextView, FileContextViewTier, FileSnapshotRecallInput,
 ProviderHistoryRewriteSignal, ProviderRequestAuditValue, ProviderRequestCompileDecision,
 ProviderRequestPressureKind, ProviderRequestSnapshot, ProviderRequestZoneDiagnostic,
 ProviderToolDefinitionSnapshot, ProviderToolDefinitionSnapshotInput } from './types/context.js'
export type { CapabilityWriteLease, CreateSubAgentSessionInput, SubAgentCodingSession, SubAgentDispatchCatalog,
 SubAgentDispatchInput, SubAgentDispatchLimitsSnapshot, SubAgentDispatchRequest, SubAgentQueryOptions,
 SubAgentReleasedThread, SubAgentRuntimeOverride, SubAgentThreadRetention, SubAgentThreadUnresumableReason,
 SubAgentToolCategoryRequestResult, SubAgentToolContext, SubAgentTypeDescriptor, TeamModelRouteRequest,
 TeamModelRouteResult, TeamSelectableModel } from './types/delegation.js'
export type { SubAgentSessionStoreOptions, SubAgentThreadRetentionLimits } from './types/delegation.js'
export type { AdmitKernelSessionInput, AgentCapabilityExecuteEnvelopeV1, AgentCapabilityExecutionContext,
 AgentCapabilityKernelEventDelivery, AgentCapabilityService, ExecutionAbortOptions,
 ExecutionCollaborationActorHandle, ExecutionCollaborationActorInput, ExecutionGuidanceRelayPlan,
 ExecutionGuidanceRelayPlanInput, KernelAdmittedInput, KernelCancelResult, KernelChatSubmission,
 KernelControllerAnswerInput, KernelControllerApprovalInput, KernelControllerSendInput, KernelControllerTarget,
 KernelInputDelivery, KernelInputReceipt, KernelInputRole, KernelInputStatus, KernelRuntimeStatus,
 KernelSessionAuthorization, KernelSessionInputStoreResult, ManagedExecutionController,
 PromoteKernelInputOptions, RunManagedExecutionParams, RunSoloExecutionParams, SoloExecutionAgentRunner,
 ToolContractCatalogRegistry, ToolContractExecutionBinding, ToolContractExecutionContext,
 ToolContractExecutionRegistry } from './types/execution.js'
export type { ChatKernelSessionBridgeOptions, CreateChatKernelSessionBridge, CreateToolContractExecutionFacade,
 ExecutionServiceOptions, KernelChatBackgroundJobCancelInput, KernelChatBackgroundJobReadInput,
 KernelChatExecutionCoordinator, KernelChatExecutionService, KernelChatRunOptions,
 KernelImplicitBackgroundWaitInput, KernelSessionDrainMode, KernelSessionDrainRunner, KernelSessionDrainTarget,
 KernelSessionInputKind, ResolveKernelRuntimeStatusInput } from './types/execution.js'
export type { AgentSkillDefinition, AgentSkillKind, BuiltInPromptOptions, PromptCompositionResult,
 PromptContribution, PromptRegistryContract, PromptRenderContext, PromptSegmentDefinition,
 PromptSegmentProvider, PromptSegmentRetention, PromptSegmentSource, PromptSegmentStability, PromptSegmentTier,
 RuntimePromptCustomSubAgent, RuntimePromptSnapshot, RuntimePromptToolCategorySummary,
 RuntimePromptToolSummary, SkillFileRecord, SkillFrontmatter, SkillMarketAvailability } from './types/guidance.js'
export type { SkillFileStoreDependencies, SkillMarketClientDependencies } from './types/guidance.js'
export type { AgentHistoryToolContext, AgentTurnToolExecutor, AgentTurnToolResult, AssistantContentPart,
 AssistantRawContentPart, SanitizeModelHistoryOptions, UserTextPayloadReference } from './types/history.js'
export type { CapabilitySpanInput, DistributiveOmit, EngineAssignedField, ExecutionCapabilitySpanRecorder,
 ExecutionSpanDebugCapability, ExecutionSpanDebugPolicy, ExecutionSpanDebugProjection,
 ExecutionSpanDebugPromptAudit, ExecutionSpanDebugRun, ExecutionSpanDebugTool, ExecutionSpanDebugTurn,
 ForkFactory, LedgerReadResult, ModelSpanHandle, ModelSpanOutcome, ProjectExecutionSpanDebugOptions,
 PromptAuditReadResult, PromptAuditRecord, RunSpanScope, SessionEntryDraft, SessionLedgerApi,
 SessionLedgerContext, SessionLedgerWarn, SessionTree, SessionTreeNode, SpanLedgerReadResult, ToolSpanHandle,
 ToolSpanOpener, ToolSpanOutcome, TurnSpanScope } from './types/ledgers.js'
export type { LedgerExecutionSpanScopeFactoryDeps, SpanLedgerWarn } from './types/ledgers.js'
export type { AgentExecutionLimitOverrides, AgentExecutionLimits, AgentTurnCapabilitySnapshot,
 ConnectionRetryOptions, ExecuteQueryLoopArgs, ExecuteSoloModeStreamLoopArgs, InlineReasoningSegment,
 InlineReasoningSegmentKind, InlineReasoningTagSplitState, ProviderStreamPart, QueryLoopRoleEngine,
 QueryLoopSubAgentOptions, QueryLoopSubAgentRuntimeOverride, QueryLoopToolCategoryResolver,
 QueryLoopToolContext, QueryLoopToolRegistry, QueryTurnEvents, QueryTurnToolContext, QueryTurnToolRegistry,
 ResolvedAgentModelRuntime, SoloAwaitPendingBackgroundJobs, SoloBackgroundWaitInput, SoloLoopEvents,
 SoloLoopToolContext, SoloLoopToolRegistry, SoloModeStreamLoopResult, StreamConsumerEvents, StreamTurnEvents,
 StreamTurnToolContext, StreamTurnToolRegistry, SubAgentContextBase, SubAgentOptionsLike,
 TurnRunnerToolContext, TurnRunnerToolRegistry } from './types/loop.js'
export type { KernelToolLoopGuardApi } from './types/loop.js'
export type { AgentModActivationState, AgentModActivationStatus, AgentModAssembly, AgentModAxisDeclarationMap,
 AgentModAxisPayloadMap, AgentModAxisRecord, AgentModBindings, AgentModContributionRecord,
 AgentModDiscoveryResult, AgentModHookContext, AgentModHostProfile, AgentModLoaderContract,
AgentModLoadReport, AgentModPackage,  AgentModPackDescriptorLike, AgentModRegistryContract, AgentModRegistryPhase,
 AgentModRegistrySnapshot, AgentModRejection, AgentModSeamDispatcherContract, AgentModSeamEventMap,
 AgentModSeamGenericEvent, AgentModSeamHandler, AgentModSeamOutcomeMap, AgentModSeamRegistration,
 AgentModSeamRegistrationInput, AgentModSessionLifecycleEvent, AgentModSourceKind, AgentModSurfaceSnapshot,
 AgentModToolCallBeforeEvent, AgentModToolCallBeforeOutcome, AgentModToolResultAfterEvent,
 AgentModToolResultAfterOutcome, AgentModTurnContextAppendage, AgentModTurnContextAssembleEvent,
 AgentModTurnContextAssembleOutcome, AgentModTurnContextSegmentView, AssembleAgentModsInput,
 InstallScannedVelarModArchiveRequest, PreparedVelarModInstall, VelarModArchiveEntry, VelarModArchiveFinding,
 VelarModArchiveScanReport, VelarModPermissionDescriptor } from './types/mods.js'
export type { VelarModArchiveImporterOptions } from './types/mods.js'
export type { AgentGoal, AgentGoalStatus, AgentPermissionAction, AgentPermissionRequest, AgentPermissionRisk,
 AgentPermissionRule, AgentPlan, AgentPlanStatus, AgentPlanStep, AgentPlanStepStatus, AgentQuestionRequest,
 AgentSessionApplicationEvent, AgentSessionArchiveEnvelope, AgentSessionArchiveEvent, AskAgentQuestionInput,
 QuestionListener, RequestAgentPermissionInput } from './types/product-session.js'
export type { BuildGuidanceRelayPromptInput, ExecutionEventBusContract, ExecutionGuidanceClearResult,
 ExecutionGuidanceEnqueueResult, ExecutionGuidanceFinalizationResult, ExecutionResourceProvider,
 ExecutionRouteProvider, GuidanceRelayPlan, KernelBackgroundJob, KernelBackgroundJobOutputSnapshot,
 KernelBackgroundJobStatus, KernelBackgroundJobStoredOutput, PlanChangePayload, ProviderRequestFingerprint,
 RegisterSubAgentGuidanceRelayWorkerInput, ResolvedTaskRoute, StartKernelBackgroundJobInput,
 SubAgentGuidanceRelayWorkerHandle, SubAgentGuidanceRelayWorkerSnapshot, TurnContextAppendBus,
 TurnContextAppendListener, TurnContextDeltaSource, WaitForKernelBackgroundJobsInput,
 WaitForNextKernelBackgroundJobInput, WorkerExecutionStreamOptions } from './types/records.js'
export type { AppendExecutionEventInput, ExecutionDebugListener, ExecutionEventBusHandlers,
 ExecutionStateListener, KernelBackgroundJobManagerOptions, TurnContextLedgerAppendInput,
 TurnContextLedgerPeekResult } from './types/records.js'
export type { ProviderTurnEvent, ProviderTurnRequestSnapshot, ProviderTurnSnapshot, ProviderTurnStatus,
 ProviderTurnToolSnapshot, ProviderTurnToolStatus, ProviderTurnUsage } from './types/records.js'
export type { ContextAdmissionConfig, ContextAdmissionInput, ContextAnchor, ContextAnchorKind,
 ContextDistillAdaptiveConfig, ContextDistillConfig, ContextDistiller,
ContextDistillGateSignals, ContextDistillInput,
 ContextDistillInstrument, ContextDistillSkipReason, ContextDistillTotals,  ContextEvictionConfig, ContextFaultEvent, ContextFaultRecoveryConfig, ContextGovernanceConfig,
 ContextGovernanceConfigInput, ContextGovernancePresetName, ContextGovernanceSessionApi,
 ContextGovernanceSessionRegistryContract, ContextGovernanceSyncInput, ContextGovernanceSyncResult,
 ContextHandoffConfig, ContextHandoffSignal, ContextInstrumentConfig, ContextLedgerAppendResult,
 ContextLedgerGenerationStamp, ContextLedgerStats, ContextMigrationCause, ContextMigrationEventLineWriter,
 ContextMigrationOutcome, ContextMigrationRejection, ContextRecord, ContextRecordBytes, ContextRecordExcerpt,
 ContextRecordKind, ContextRecordToolPart, ContextResidency, ContextResidencyMigrationEvent,
 ContextResidencyVector, GovernanceEpochDistillReport, GovernanceEpochReport, GovernanceEpochSkipReason,
 GovernanceEpochSource, GovernanceWindowDerivation, GovernanceWindowInput, ResidencyLedgerView } from './types/residency.js'
export type { ContextClassificationInput, ContextGovernanceSessionRegistryOptions, ContextRecordClassifier } from './types/residency.js'
export type { ChatContextRetrievalIndexMessageEntry, ChatContextRetrievalIndexReferencedPath,
 ChatContextRetrievalIndexSaveOptions, ChatContextRetrievalIndexSnapshot, ChatContextRetrievalIndexStore,
 ChatContextRetrievalIndexToolPayloadEntry, IndexedSessionMessage, MessageSearchIndex, RankingSignals } from './types/retrieval.js'
export type { ChatContextRetrievalServiceOptions, ContextRetrievalQueryTraceStoreOptions,
 RetrievalQueryRegistration } from './types/retrieval.js'
export type { AgentExecutionStackOptions, AgentExecutionStackRunnerOptions, AgentExecutionStackToolContext,
 AgentRoleContract, AgentRoleDefinition, AgentRoleDescriptorProviderContext, AgentRoleResolution,
 AgentRoleToolBindings, AgentRoleToolCategoryResolver, AgentRunnerConfig,
 AgentRunnerContract, AgentRunnerInfrastructure, AgentRunProfileCatalogSnapshot, AgentRuntimeInputResult, AgentSurfaceProfile,
 AgentSurfaceToolPolicy, AgentTurnBoundary, AgentTurnSettlement, AgentWorkflowDispatchContext,
 AgentWorkflowDispatchPort, AgentWorkflowRunOptions, DerivedAgentSurfaceRunPolicy,
DeriveSurfaceRunPolicyInput,  ExecutionModeDescriptor, ExecutionModePromptProjection, ExecutionModeStickiness, GoalDockAction,
 GoalDockPrimaryAction, GoalDockTone, GoalDockViewModel, GoalLifecycleAction, GoalLifecycleStatus,
 PrimaryAgentProfileContract, PromptStateCodingSession, PromptStateExecutionApi, PromptStateSkillsApi,
 PromptStateToolContext, ResolveAgentRoleOptions, ResolveAgentSurfaceInput, RunContextCodingSession,
 RunContextToolContext, RunnerBuildToolContextArgs, RunnerCancelBackgroundJob, RunnerCodingSessionPolicyBundle,
 RunnerContextCodingSession, RunnerExecutionScope, RunnerModelCapabilityPort, RunnerReadBackgroundJobOutput,
 RunnerSubAgentOptions, RunnerToolContext, RunnerWaitBackgroundJobs, StreamSoloWorkerOptions,
 TurnContextBlockInput } from './types/runner.js'
export type { CreateAgentExecutionStack, PrimaryAgentProfileSkillRepository } from './types/runner.js'
export type { AutoVerificationCodingSession, AutoVerificationEvents, AutoVerificationToolContext,
 CapabilityValidationFailure, CodingSessionSnapshot, CodingSessionToolCategoryToolNames,
 CodingSessionToolContext, ReminderScope, ReminderTrigger, RuntimeReminderConsumeResult, RuntimeReminderInput,
 RuntimeReminderSchedulerContract, VerificationRelevantPathPredicate } from './types/session.js'
export type { CodingSessionTrackerOptions } from './types/session.js'
export type { CancelToolBackgroundJobInput, KernelToolContext, ReadToolBackgroundJobOutputInput,
 SubAgentOptions, ToolBackgroundJobOutputSnapshot, ToolCodingSessionApi, ToolConversationHandoffRequest,
 ToolConversationHandoffResult, ToolRoleSkillReadResult, WaitToolBackgroundJobsInput } from './types/tool-context.js'
export type { ApprovalSession, ToolInputReuseEnvelopeSchema, ToolInputReuseEnvelopeShape } from './types/toolkit.js'
export type { WithToolInputReuse } from './types/toolkit.js'
export type { KernelStoredToolOutput, OverriddenToolMap, ProjectKernelToolOutputInput,
 ProjectKernelToolOutputResult, RegisteredTool, RegisteredToolMap, RegistryTool, SerializationHints,
 ToolAllocatorOperation, ToolAllocatorRequest, ToolCapabilityPage, ToolCapabilityPageKind,
 ToolCapabilityReason, ToolCapabilityRegistryContext, ToolCapabilityRegistryListOptions,
 ToolCapabilitySchemaPolicy, ToolDiscoveryAvailability, ToolDiscoveryNextAction, ToolDiscoverySchemaState,
 ToolExecutionPolicyCodingSession, ToolExecutionPolicyContext, ToolExecutionPolicyExecution,
 ToolExecutionPolicyRegistry, ToolExecutionPolicySurface, ToolExecutionPolicyTool, ToolExecutorEvents,
 ToolInputReuseContext, ToolRegistryCodingSession, ToolRegistryContext, ToolSchema, ToolSchemaIssue,
 ToolSchemaResult, ToolTransportNamePlan, ToolTransportProjection, ToolVisibleSurfaceProfileId } from './types/tools.js'
export type { ToolAttemptOutcome } from './types/tools.js'
export type { KernelToolFailureBatchEntry, KernelToolLoopGuardInput, ToolResult } from './types/tools.js'
export type { AnyVelaTool, RuntimeToolIssue, ToolArgsValidationResult, ToolExecutionDecision,
 ToolExecutionFailureInput, ToolExecutionFailureKind, ToolExecutionPrepared, ToolExecutionRequest,
 ToolExecutionSuccessInput, ToolFailureResult, ToolInputAdjustment, ToolSchemaIssueDetail,
 ToolSpaceRecoveryGuide } from './types/tools.js'
