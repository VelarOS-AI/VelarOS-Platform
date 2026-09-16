# `@velaros-ai/agent` 0.6.44 → 1.0.0 迁移表

这是一次**破坏性**发布：23 个入口收成 4 个，1381 个名字从对外面上消失，240 个名字是新的，
955 个名字原样保留。本文件按符号逐条给出去向，并标出每一条在 Platform 仓内与三个产品仓
（Desktop、Workbench、Termel）里的消费点数量。

- 仓内消费点**本轮已全部改完**（提交 `refactor(capabilities): 仓内 52 个文件的 agent 引用改到收口后的四个入口`）。
- 产品仓的调用点**本轮不改**，只列进第 6 节，由各产品仓自己按这张表改。
- 判断口径：消费点 = 直接 `import … from '@velaros-ai/agent*'` 的源文件数（注释与文档不计）。

改造方案见 `agent.md`（§2.6 四个入口、§3.4 要删的导出与替代）；仓库标准见
`docs/architecture/module-ownership.md`；模块卡片见 `packages/agent/MODULE.md`。

---

## 1. 入口前后对照

| 旧入口（23） | 新入口（4） | 说明 |
| --- | --- | --- |
| `.` | `.` | 内容全换：原先是 19 个子目录的通配聚合（1,607 个名字），现在只有合同登记的接口与 impl 的实例/工厂 |
| `./runtime` | `.` | 零消费方，与 `.` 本来就大面积重叠 |
| `./host` | `.` | 零消费方，README 推荐过的「稳定宿主面」 |
| `./node` | `.` | `ToolContractExecutionFacade` 改成 `createToolContractExecutionFacade` |
| `./chat-stream` | `./chat` | 与 `./chat` 重复（`./chat` 早就 `export *` 了它） |
| `./chat` | `./chat` | 内容全换：现在是 `agentChat` / `agentWire` / `chatMessages` / `chatRuntimeEvents` 四件套加流消费 |
| `./run-context` | `.` | 只用到 `TurnContextSessionLedgers`、`TurnContextAppendBus` 两个名字 |
| `./protocol` | `./contracts` | 类型照旧可以叫出名字；zod schema 不再出包（见 §4.1） |
| `./protocol/agent-capability` | `./contracts`（数据）/ `./chat`（解析） | 入口名不许带 `/`（门禁硬约束） |
| `./protocol/execution` | `./contracts` | 同上 |
| `./protocol/external-agent-bridge` | `./contracts`（数据）/ `./chat`（解析） | 同上 |
| `./protocol/lease` | `./contracts` | 同上 |
| `./protocol/message` | `./contracts` | 同上 |
| `./protocol/mods` | `./contracts`（数据）/ `./chat`（解析） | 同上 |
| `./protocol/observability` | `./contracts` | 同上 |
| `./protocol/session` | `./contracts` | 同上 |
| `./tool-contract` | `./tool-contract` | 收窄：通用件搬进 `@velaros-ai/tool-contract`，这里只留审批、入参复用、文件上下文、入参边界 |
| `./mcp` | `.` | `createMcpClientConnection` + 实例 `mcpToolTranslator` |
| `./mods` | `.` | `createAgentModLoader` / `createAgentModSeamDispatcher` / 实例 `agentModHost` |
| `./bridge` | `.` | 四个工厂 + `externalAgentBridgeTokensEqual` |
| `./session` | `.` | 三个服务工厂 + 实例 `agentSessionKit` |
| `./remote` | `.` | 零消费方；远程宿主工具由 `RemoteHostServiceApi` 内部装配 |
| `./remote/mcp` | `.` | 只留 `runRemoteNodeMcpStdio` |

新入口的值一共 126 个：

| 入口 | 值 |
| --- | --- |
| `.` | 86 个：`createAgentExecutionStack` 等 50 个工厂、`agentTools` / `agentChat` 等 15 个实例，加 `./contracts` 与另两个入口带出的全部 |
| `./contracts` | 26 张常量表（`AgentToolNames`、`AgentIdentity`、`AgentProtocolVersions`、`AgentErrorCodes`、`AgentToolLimits`…），没有别的值 |
| `./chat` | `agentChat`、`agentWire`、`chatMessages`、`chatRuntimeEvents`、`chatStreamProtocol`、`createChatStreamConsumer`、`createChatStreamSessionLog` |
| `./tool-contract` | `agentToolContracts`、`fileContextRegistry`、`toolInputReuseStore`、`withToolInputReuse`、`resolveToolInputReuse`、`defaultDenyApprovalPort`、`defaultUnsupportedInteractionPort`、`createUnattendedSubAgentApprovalPort` |

`browserSafeEntries` 登记 `contracts.ts`、`chat.ts`、`tool-contract.ts`：这三条的引用链不碰 Node
内置模块（INV-16），渲染进程可以直接加载。

---

## 2. 新增的名字（240）

绝大多数是「类上方接口」被登记进产品面后第一次出包（`XxxApi`），以及本轮新立的套件与常量表。
值一侧的新名字如下（类型一侧全是 `*Api` 与它们的入参形状）：

- `ActiveDirectiveArchiveDiagnostic`、`AgentCapabilityEnvelopeLimits`、`AgentFieldValues`、`AgentModAxes`
- `AgentModLoaderContract`、`AgentModRegistryContract`、`AgentModSeamDispatcherContract`、`AgentRunnerContract`
- `AgentSkillFailureCode`、`AgentSkillFailureCodes`、`AgentSurfaceLimits`、`AgentSurfaceToolPolicy`
- `AnyVelaTool`、`ApprovalSession`、`AssistantRawContentPart`、`BoundedReadInput`
- `BuildGuidanceRelayPromptInput`、`ChatMessageConversationSemanticInput`、`ContextGovernanceSessionRegistryContract`、`ContextRefRetrieval`
- `CreateAgentExecutionStack`、`CreateChatKernelSessionBridge`、`CreateExternalAgentBridgeCommandQueue`、`CreateToolContractExecutionFacade`
- `DistributiveOmit`、`EngineAssignedField`、`ErrorCode`、`ErrorContext`
- `ExecutionDebugListener`、`ExecutionEventBusContract`、`ExecutionStateListener`、`ExternalAgentBridgeProtocol`
- `FileContextView`、`FileContextViewTier`、`FileSnapshotRecallInput`、`ForkFactory`
- `GoalConstraintReference`、`KernelChatBackgroundJobCancelInput`、`KernelChatBackgroundJobReadInput`、`KernelImplicitBackgroundWaitInput`
- `KernelSessionAuthorization`、`McpLimits`、`McpToolCaller`、`OverriddenToolMap`
- `PrimaryAgentProfileContract`、`ProjectExecutionSpanDebugOptions`、`PromptRegistryContract`、`ProviderRequestAuditValue`
- `ProviderStreamPart`、`QuestionListener`、`RecursiveTraversalInput`、`ResidencyLedgerView`
- `RuntimePromptCustomSubAgent`、`RuntimePromptToolSummary`、`RuntimeReminderSchedulerContract`、`RuntimeToolIssue`
- `SerializedError`、`SessionLedgerContext`、`SkillFrontmatter`、`SoloAwaitPendingBackgroundJobs`
- `SoloBackgroundWaitInput`、`StreamRuntimeStateKinds`、`StreamSoloWorkerOptions`、`ToolAttemptOutcome`
- `ToolConversationHandoffRequest`、`ToolConversationHandoffResult`、`ToolExecutionFailureInput`、`ToolExecutionFailureKind`
- `ToolExecutionPolicyCodingSession`、`ToolExecutionPolicySurface`、`ToolExecutionRequest`、`ToolExecutionSuccessInput`
- `ToolInputAdjustment`、`ToolInputReuseContext`、`ToolInputReuseEnvelopeSchema`、`ToolSchema`
- `ToolSchemaIssue`、`ToolSchemaResult`、`ToolSpaceRecoveryGuide`、`ToolVisibleSurfaceProfileId`
- `TurnRunnerToolContext`、`VelarModArchiveFiles`、`WithToolInputReuse`、`agentChat`
- `agentLedgerFiles`、`agentModHost`、`agentRetryPolicy`、`agentRuntime`
- `agentSessionKit`、`agentToolContracts`、`agentTools`、`agentTurnHistory`
- `agentWire`、`chatMessages`、`chatRuntimeEvents`、`createAgentCapabilityEventPublisher`
- `createAgentGoalService`、`createAgentModLoader`、`createAgentModSeamDispatcher`、`createAgentPlanService`
- `createAgentQuestionService`、`createAgentRoleEngine`、`createAgentSkillRepository`、`createAgentWorkflowRuntime`
- `createBackgroundJobManager`、`createBuiltinAgentModDefinition`、`createChatContextRetrievalService`、`createChatKernelSessionBridge`
- `createChatStreamConsumer`、`createChatStreamSessionLog`、`createCodingSessionTracker`、`createContextGovernanceSessionRegistry`
- `createExecutionEventBus`、`createExecutionGuidanceQueue`、`createExecutionPlanLedger`、`createExecutionPlanState`
- `createExecutionRouting`、`createExecutionService`、`createExternalAgentBridgeCommandQueue`、`createExternalAgentBridgeEventWindow`
- `createExternalAgentBridgeLoopbackServer`、`createExternalAgentBridgePairingThrottle`、`createFileSkillProvider`、`createInMemoryContextPayloadStore`
- `createJsonlContextMigrationEventSink`、`createLedgerExecutionSpanScopeFactory`、`createMcpClientConnection`、`createNoopExecutionEventBus`
- `createPrimaryAgentProfile`、`createPromptRegistry`、`createProviderRequestCompiler`、`createSessionLedger`
- `createSessionStore`、`createSkillFileStore`、`createSkillMarketClient`、`createSoloExecutionService`
- `createSubAgentDispatcher`、`createSubAgentGuidanceRelayRegistry`、`createSubAgentSessionStore`、`createTeamModelRouter`
- `createToolCapabilityRegistry`、`createToolContractExecutionFacade`、`createToolExecutionPolicy`、`createToolExecutor`
- `createToolRegistry`、`createTurnContextAppendHub`、`createTurnContextSessionLedgers`、`createVelarModArchiveImporter`
- `createWriteLeaseCoordinator`、`directiveOperations`、`fileContextRegistry`、`guidanceRelay`
- `mcpToolTranslator`、`toolInputReuseStore`、`toolTransportNames`

---

## 3. 有替代的旧名（205）

### 3.1 类到工厂

| 旧名 | 新名 / 去向 | 新入口 | Platform 仓消费点 | 三个产品仓消费点 |
| --- | --- | --- | --- | --- |
| `AgentCapabilityEventPublisher` | createAgentCapabilityEventPublisher(...)；类型位用 AgentCapabilityEventPublisherApi | `.` | 0 | Desktop 1、Workbench 1 |
| `AgentConnectionRetryHelper` | 实例 agentRetryPolicy；类型位用 RetryPolicyApi | `.` | 0 | Desktop 1 |
| `AgentModHookDispatcher` | createAgentModSeamDispatcher(...)（旧别名一并删）；类型位用 AgentModSeamDispatcherApi | `.` | 0 | Desktop 1 |
| `AgentModLoader` | createAgentModLoader(...)；类型位用 AgentModLoaderApi | `.` | 0 | Desktop 3、Workbench 1、Termel 1 |
| `AgentModSeamDispatcher` | createAgentModSeamDispatcher(...)；类型位用 AgentModSeamDispatcherApi | `.` | 0 | Desktop 1 |
| `AgentRoleEngine` | createAgentRoleEngine(...)；类型位用 AgentRoleEngineApi | `.` | 0 | Desktop 1 |
| `AgentSkillRepository` | createAgentSkillRepository(...)；类型位用 AgentSkillRepositoryApi | `.` | 0 | Desktop 7、Termel 1 |
| `AgentTurnHistoryHelper` | 实例 agentTurnHistory；类型位用 TurnHistoryApi | `.` | 3（已改完） | Desktop 1 |
| `AgentWorkflowRuntime` | createAgentWorkflowRuntime(...)；类型位用 AgentWorkflowRuntimeApi | `.` | 1（已改完） | — |
| `ChatContextRetrievalService` | createChatContextRetrievalService(...)；类型位用 ChatContextRetrievalServiceApi | `.` | 0 | Desktop 6、Workbench 1 |
| `ChatKernelSessionBridge` | createChatKernelSessionBridge(...)；类型位用 ChatKernelSessionBridgeApi | `.` | 0 | Desktop 3 |
| `ChatMessageHelper` | 实例 chatMessages（`./chat`）；类型位用 ChatMessagesApi | `.` | 0 | Desktop 3、Workbench 1 |
| `ChatStreamConsumer` | createChatStreamConsumer(...)（`./chat`）；类型位用 ChatStreamConsumerApi | `.` | 0 | Desktop 4 |
| `CodingSessionTracker` | createCodingSessionTracker(...)；类型位用 CodingSessionTrackerApi | `.` | 0 | Desktop 1、Workbench 4、Termel 1 |
| `ContextGovernanceSessionRegistry` | createContextGovernanceSessionRegistry(...)；类型位用 ContextGovernanceSessionRegistryApi | `.` | 4（已改完） | Desktop 8、Workbench 3 |
| `ExecPlanLedger` | createExecutionPlanLedger(...)；类型位用 ExecPlanLedgerApi | `.` | 0 | Workbench 1 |
| `ExecPlanState` | createExecutionPlanState()；类型位用 ExecPlanStateApi | `.` | 0 | Workbench 1 |
| `ExecRouting` | createExecutionRouting(...)；类型位用 ExecRoutingApi | `.` | 0 | Workbench 1 |
| `ExecutionEventBus` | createExecutionEventBus(handlers?) / createNoopExecutionEventBus()；类型位用 ExecutionEventBusApi | `.` | 0 | Desktop 8、Workbench 16、Termel 1 |
| `ExecutionGuidanceQueue` | createExecutionGuidanceQueue()；类型位用 ExecutionGuidanceQueueApi | `.` | 0 | Workbench 1 |
| `ExecutionService` | createExecutionService(...)；类型位用 ExecutionServiceApi | `.` | 0 | Desktop 5 |
| `ExternalAgentBridgeCommandQueue` | createExternalAgentBridgeCommandQueue(maxCommands?)；类型位用 ExternalAgentBridgeCommandQueueApi | `.` | 0 | Desktop 1、Termel 1 |
| `ExternalAgentBridgeEventWindow` | createExternalAgentBridgeEventWindow(maxEvents?)；类型位用 ExternalAgentBridgeEventWindowApi | `.` | 0 | Desktop 1、Termel 1 |
| `ExternalAgentBridgeLoopbackServer` | createExternalAgentBridgeLoopbackServer(options)；类型位用 ExternalAgentBridgeLoopbackServerApi | `.` | 0 | Desktop 1、Termel 1 |
| `ExternalAgentBridgePairingThrottle` | createExternalAgentBridgePairingThrottle(now?)；类型位用 ExternalAgentBridgePairingThrottleApi | `.` | 0 | Desktop 1、Termel 1 |
| `FileSkillProvider` | createFileSkillProvider(...)；类型位用注入面的 AgentSkillProvider | `.` | 0 | Desktop 2、Termel 1 |
| `InMemoryContextPayloadStore` | createInMemoryContextPayloadStore()；类型位用注入面的 ContextPayloadStore | `.` | 11（已改完） | Workbench 2 |
| `JsonlContextMigrationEventSink` | createJsonlContextMigrationEventSink(writer)；类型位用注入面的 ContextMigrationEventSink | `.` | 0 | Desktop 1 |
| `KernelBackgroundJobManager` | createBackgroundJobManager(options?)；类型位用 KernelBackgroundJobManagerApi | `.` | 0 | Desktop 5、Workbench 1 |
| `LedgerExecutionSpanScopeFactory` | createLedgerExecutionSpanScopeFactory(deps)；类型位用 LedgerExecutionSpanScopeFactoryApi | `.` | 0 | Desktop 1 |
| `McpClientConnection` | createMcpClientConnection(...)；类型位用 McpClientConnectionApi | `.` | 0 | Desktop 3、Termel 1 |
| `PrimaryAgentProfile` | createPrimaryAgentProfile(...)；类型位用 PrimaryAgentProfileApi | `.` | 0 | Desktop 4、Workbench 3、Termel 1 |
| `PromptRegistry` | createBuiltInPromptRegistry(options?) / createPromptRegistry(definitions?)；类型位用 PromptRegistryApi | `.` | 0 | Desktop 2、Termel 1 |
| `ProviderRequestCompiler` | createProviderRequestCompiler(governanceSessions?)；类型位用 ProviderRequestCompilerApi | `.` | 4（已改完） | — |
| `SessionLedger` | createSessionLedger(ctx) 或 SessionStoreApi 交出的句柄；类型位用 SessionLedgerHandleApi | `.` | 0 | Desktop 1 |
| `SessionStore` | createSessionStore(deps)；类型位用 SessionStoreApi | `.` | 0 | Desktop 2 |
| `SkillFileStore` | createSkillFileStore(dependencies)；类型位用 SkillFileStoreApi | `.` | 0 | Desktop 4、Termel 2 |
| `SoloExecutionService` | createSoloExecutionService(...)；类型位用 SoloExecutionServiceApi | `.` | 0 | Desktop 8 |
| `SubAgentDispatcher` | createSubAgentDispatcher(...)；类型位用 SubAgentDispatcherApi | `.` | 0 | Desktop 3、Workbench 1 |
| `SubAgentGuidanceRelayRegistry` | createSubAgentGuidanceRelayRegistry()；类型位用 SubAgentGuidanceRelayRegistryApi | `.` | 0 | Desktop 1、Workbench 1 |
| `SubAgentSessionStore` | createSubAgentSessionStore(options?)；类型位用 SubAgentSessionStoreApi | `.` | 0 | Termel 1 |
| `TeamModelRouter` | createTeamModelRouter(routing)；类型位用 TeamModelRouterApi | `.` | 0 | Desktop 1、Workbench 1 |
| `ToolCapabilityRegistry` | createToolCapabilityRegistry(promptFeaturePolicy?)；类型位用 ToolCapabilityRegistryApi | `.` | 0 | Desktop 1 |
| `ToolContractExecutionFacade` | createToolContractExecutionFacade(toolRegistry)；类型位用 ToolContractExecutionFacadeApi | `.` | 0 | Desktop 1 |
| `ToolExecutionPolicy` | createToolExecutionPolicy(toolRegistry)；类型位用 ToolExecutionPolicyApi | `.` | 2（已改完） | — |
| `ToolExecutor` | createToolExecutor(ctx, events, policy)；类型位用 ToolExecutorApi | `.` | 2（已改完） | — |
| `ToolRegistryHelper` | createToolRegistry(promptFeaturePolicy?)；类型位用 ToolRegistryApi | `.` | 0 | Desktop 1 |
| `TurnContextAppendHub` | createTurnContextAppendHub()；类型位用 TurnContextAppendHubApi | `.` | 0 | Desktop 6 |
| `TurnContextSessionLedgers` | createTurnContextSessionLedgers(sourceId, options?)；类型位用 TurnContextSessionLedgersApi | `.` | 3（已改完） | Desktop 1 |
| `VelarModArchiveImporter` | createVelarModArchiveImporter(options)；类型位用 VelarModArchiveImporterApi | `.` | 0 | Desktop 1、Termel 1 |
| `WriteLeaseCoordinator` | createWriteLeaseCoordinator()；类型位用 WriteLeaseCoordinatorApi | `.` | 0 | Desktop 2、Workbench 1 |

### 3.2 函数收进套件

| 旧名 | 新名 / 去向 | 新入口 | Platform 仓消费点 | 三个产品仓消费点 |
| --- | --- | --- | --- | --- |
| `ContextGovernancePresetNames` | ContextGovernanceSessionRegistryApi.presetNames | `.` | 0 | Desktop 1 |
| `ContextGovernancePresets` | ContextGovernanceSessionRegistryApi.presets | `.` | 0 | Desktop 1 |
| `GuidanceRelayPlanSchema` | guidanceRelay.parsePlan(...)（schema 不出包） | `.` | 0 | Desktop 1 |
| `archiveActiveDirectives` | directiveOperations.archive(...) | `.` | 0 | Desktop 1 |
| `assembleAgentMods` | agentModHost.assembleAgentMods(...) | `.` | 0 | Desktop 1 |
| `buildGuidanceRelayPrompt` | guidanceRelay.buildPrompt(...) | `.` | 0 | Desktop 1 |
| `buildMcpToolName` | mcpToolTranslator.buildToolName(...) | `.` | 0 | Termel 1 |
| `canonicalJsonStringify` | agentLedgerFiles.canonicalJsonStringify(...) | `.` | 0 | Desktop 5 |
| `compareStableStrings` | ContextGovernanceSessionRegistryApi.compareStableStrings(...) | `.` | 0 | Desktop 1 |
| `completeLineByteLength` | agentLedgerFiles.completeLineByteLength(...) | `.` | 0 | Desktop 1 |
| `configureAppRuntimeFacts` | agentRuntime.configureHostFacts(...) | `.` | 0 | Desktop 1 |
| `contextRetrievalFingerprintsEqual` | ContextRetrievalServiceApi.fingerprintsEqual(...) | `.` | 0 | Desktop 1 |
| `convertMcpInputSchema` | mcpToolTranslator.convertInputSchema(...) | `.` | 0 | Desktop 1 |
| `createAgentModSurfaceSnapshot` | agentModHost.createSurfaceSnapshot(...) | `.` | 0 | Desktop 2、Workbench 1 |
| `createAgentSessionArchiveEnvelope` | agentSessionKit.createArchiveEnvelope(...) | `.` | 0 | Termel 1 |
| `createBuiltInPromptSegments` | PromptRegistryApi.createBuiltInSegments(...) | `.` | 0 | Desktop 1 |
| `createSelectedSkillPromptSegment` | PromptRegistryApi.createSelectedSkillSegment(...) | `.` | 0 | Desktop 1 |
| `createSkillDefinition` | AgentSkillRepositoryApi.createDefinition(...) | `.` | 0 | Desktop 2、Termel 2 |
| `createTextPromptSegment` | PromptRegistryApi.createTextSegment(...) | `.` | 0 | Desktop 1 |
| `createToolTransportNamePlan` | toolTransportNames.createPlan(...) | `.` | 0 | Desktop 1、Workbench 1 |
| `createToolTransportProjection` | toolTransportNames.createProjection(...) | `.` | 0 | Desktop 2、Workbench 1 |
| `discoverAgentModPackages` | agentModHost.discoverAgentModPackages(...) | `.` | 0 | Desktop 1 |
| `evaluateAgentPermissionRules` | agentSessionKit.evaluatePermissionRules(...) | `.` | 0 | Termel 1 |
| `isActiveDirectiveArtifact` | directiveOperations.isDirective(...) | `.` | 0 | Desktop 1 |
| `isSnapshotComparableEntry` | agentLedgerFiles.isSnapshotComparableEntry(...) | `.` | 0 | Desktop 2 |
| `isTerminalAgentBackgroundState` | agentSessionKit.isTerminalBackgroundState(...) | `.` | 0 | Termel 1 |
| `listActiveDirectives` | directiveOperations.list(...) | `.` | 0 | Desktop 1 |
| `normalizeAgentPermissionRequest` | agentSessionKit.normalizePermissionRequest(...) | `.` | 0 | Termel 1 |
| `normalizeAgentSessionListLimit` | agentSessionKit.normalizeSessionListLimit(...) | `.` | 0 | Termel 1 |
| `normalizeGuidanceRelayPlan` | guidanceRelay.normalizePlan(...) | `.` | 0 | Desktop 1 |
| `parseAgentSessionArchiveEnvelope` | agentSessionKit.parseArchiveEnvelope(...) | `.` | 0 | Termel 1 |
| `parseGuidanceRelayPlan` | guidanceRelay.parsePlan(...) | `.` | 0 | Desktop 1 |
| `projectExecutionSpanDebug` | agentLedgerFiles.projectExecutionSpanDebug(...) | `.` | 0 | Desktop 1 |
| `readLedgerFile` | agentLedgerFiles.readLedgerFile(...) | `.` | 0 | Desktop 3 |
| `readSpanLedgerFile` | agentLedgerFiles.readSpanLedgerFile(...) | `.` | 0 | Desktop 1 |
| `resolveAgentExecutionLimits` | agentRuntime.resolveExecutionLimits(...) | `.` | 0 | Desktop 1 |
| `resolveAgentSessionLeaseClaim` | agentSessionKit.resolveLeaseClaim(...) | `.` | 0 | Termel 1 |
| `resolveCapabilityCategoryDefinitions` | agentRuntime.resolveCapabilityCategories(...) | `.` | 0 | Desktop 1 |
| `resolveContextGovernanceArmName` | ContextGovernanceSessionRegistryApi.resolveArmName(...) | `.` | 0 | Desktop 1 |
| `resolveMainAgentGuidanceMessage` | guidanceRelay.resolveMainAgentMessage(...) | `.` | 0 | Desktop 1 |
| `resolveRunProfilePolicyForRuntime` | agentRuntime.resolveRunProfilePolicy(...) | `.` | 0 | Desktop 1 |
| `rewriteCanonicalToolReferences` | toolTransportNames.rewriteCanonicalReferences(...) | `.` | 0 | Desktop 2、Workbench 1 |
| `translateMcpCallResult` | mcpToolTranslator.translateCallResult(...) | `.` | 0 | Termel 1 |
| `translateMcpTool` | mcpToolTranslator.translateTool(...) | `.` | 0 | Desktop 2 |
| `truncateLedgerToEntryCount` | agentLedgerFiles.truncateLedgerToEntryCount(...) | `.` | 0 | Desktop 2 |

### 3.3 渲染侧套件

| 旧名 | 新名 / 去向 | 新入口 | Platform 仓消费点 | 三个产品仓消费点 |
| --- | --- | --- | --- | --- |
| `ChatRuntimeEvents` | 实例 chatRuntimeEvents（方法名不变） | `./chat` | 0 | Desktop 7、Workbench 5 |
| `ToolCatalogSnapshotSchema` | 已删无替代：schema 不出包；目录快照的形状是 ToolCatalogSnapshot | `./chat` | 0 | Desktop 1 |
| `assertChatPromptFeatureIds` | agentWire.assertChatPromptFeatureIds(...) | `./chat` | 0 | Desktop 1 |
| `assertReasoningLevel` | 已删无替代：直接按 AgentFieldValues.reasoningLevel 判 | `./chat` | 0 | Desktop 1 |
| `assertThinkingDepth` | 已删无替代：直接按 AgentFieldValues.thinkingDepth 判 | `./chat` | 0 | Desktop 1 |
| `branchTimelineKey` | agentWire.branchTimelineKey(...) | `./chat` | 0 | Desktop 5 |
| `compactToolInputForModel` | agentChat.compactToolInputForModel(...) | `./chat` | 0 | Desktop 2 |
| `compactToolResultForDisplay` | agentChat.compactToolResultForDisplay(...) | `./chat` | 0 | Desktop 2 |
| `createAgentCapabilityExecutionEventEnvelopeV1` | agentWire.createCapabilityExecutionEventEnvelope(...) | `./chat` | 0 | Workbench 1 |
| `createInlineReasoningTagSplitState` | agentChat.createInlineReasoningSplitState() | `./chat` | 0 | Desktop 1 |
| `estimateContextUsage` | agentChat.estimateContextUsage(...) | `./chat` | 0 | Desktop 1 |
| `extractSessionSearchTerms` | agentChat.extractSessionSearchTerms(...) | `./chat` | 0 | Desktop 1 |
| `findCurrentGoalArtifact` | agentChat.findCurrentGoalArtifact(...) | `./chat` | 0 | Desktop 1、Workbench 1 |
| `flushInlineReasoningTagTail` | agentChat.flushInlineReasoning(...) | `./chat` | 0 | Desktop 1 |
| `formatTurnContextOmittedNote` | agentChat.formatTurnContextOmittedNote(...) | `./chat` | 0 | Desktop 1 |
| `getGoalLifecycleStatus` | agentChat.getGoalLifecycleStatus(...) | `./chat` | 0 | Workbench 1 |
| `goalLifecycleToUpsertInput` | agentChat.goalLifecycleToUpsertInput(...) | `./chat` | 0 | Desktop 1、Workbench 1 |
| `isConversationTurnInputMessage` | agentWire.isConversationTurnInput(...) | `./chat` | 0 | Desktop 10、Workbench 2 |
| `isExecutionModeActive` | agentChat.isExecutionModeActive(...) | `./chat` | 0 | Desktop 4、Workbench 1 |
| `isSystemNoticeMessage` | agentWire.isSystemNotice(...) | `./chat` | 0 | Desktop 2、Workbench 1 |
| `listExecutionModes` | agentChat.listExecutionModes() | `./chat` | 0 | Desktop 1 |
| `mergeAgentSurfaceSkillSelection` | agentWire.mergeSurfaceSkillSelection(...) | `./chat` | 0 | Desktop 2 |
| `normalizeExecutionModes` | agentChat.normalizeExecutionModes(...) | `./chat` | 0 | Desktop 9、Workbench 1 |
| `normalizePromptFeatures` | agentWire.normalizePromptFeatures(...) | `./chat` | 0 | Desktop 8 |
| `normalizeSessionSearchText` | agentChat.normalizeSessionSearchText(...) | `./chat` | 0 | Desktop 2 |
| `parseAgentCapabilityExecuteEnvelopeV1` | agentWire.parseCapabilityExecuteEnvelope(...) | `./chat` | 0 | Desktop 1、Workbench 2 |
| `parseAgentModManifest` | agentWire.parseModManifest(...) | `./chat` | 0 | Desktop 3、Termel 1 |
| `parseExternalAgentBridgeClientMessage` | agentWire.parseExternalBridgeClientMessage(...) | `./chat` | 0 | Desktop 1、Termel 1 |
| `parseOptionalReasoningLevel` | 已删无替代：直接按 AgentFieldValues.reasoningLevel 判 | `./chat` | 0 | Desktop 1 |
| `readGeneratedFilePayload` | agentChat.readGeneratedFilePayload(...) | `./chat` | 0 | Desktop 1 |
| `readSourcePayload` | agentChat.readSourcePayload(...) | `./chat` | 0 | Desktop 1 |
| `reasoningLevelToThinkingDepth` | agentWire.reasoningLevelToThinkingDepth(...) | `./chat` | 0 | Desktop 2 |
| `renderTurnContextBlock` | agentChat.renderTurnContextBlock(...) | `./chat` | 0 | Desktop 3 |
| `resolveChatMessageConversationKind` | agentWire.resolveMessageConversationKind(...) | `./chat` | 0 | Desktop 3 |
| `resolveChatSendRequestOptions` | agentChat.resolveChatSendRequestOptions(...) | `./chat` | 0 | Desktop 1 |
| `resolveExecutionModes` | agentChat.resolveExecutionModes(...) | `./chat` | 0 | Desktop 1 |
| `resolveRunProfileSelectionId` | 已删无替代：直接按 AgentFieldValues.runProfileSelectionId 判 | `./chat` | 0 | Desktop 2 |
| `resolveThinkingDepth` | agentWire.reasoningLevelToThinkingDepth(...) | `./chat` | 0 | Desktop 3 |
| `serializeAgentSurfaceContextSnapshot` | agentWire.serializeSurfaceContextSnapshot(...) | `./chat` | 0 | Desktop 2 |
| `serializeToolResultForRecall` | agentChat.serializeToolResultForRecall(...) | `./chat` | 0 | Desktop 4 |
| `splitInlineReasoningTagDelta` | agentChat.splitInlineReasoning(...) | `./chat` | 0 | Desktop 1 |

### 3.4 工具契约

| 旧名 | 新名 / 去向 | 新入口 | Platform 仓消费点 | 三个产品仓消费点 |
| --- | --- | --- | --- | --- |
| `DefineToolRuntimeSpecInput` | `@velaros-ai/tool-contract` 的同名类型 | `./tool-contract` | 0 | Desktop 1 |
| `ToolContractDiscoveryDescriptors` | agentToolContracts.discoveryDescriptors | `./tool-contract` | 0 | Termel 2 |
| `ToolContractRuntimeSpec` | `@velaros-ai/tool-contract` 的同名类型 | `./tool-contract` | 0 | Desktop 1、Workbench 1 |
| `applyDefaultRecursiveMaxDepth` | agentToolContracts.applyDefaultRecursiveMaxDepth(...) | `./tool-contract` | 1（已改完） | — |
| `assertCanonicalToolId` | `@velaros-ai/tool-contract` 的 toolIdentity.assertCanonical(...) | `./tool-contract` | 0 | Desktop 1 |
| `canonicalizeProviderInputSchema` | `@velaros-ai/tool-contract` 的 toolSchemas.canonicalizeProviderInput(...) | `./tool-contract` | 0 | Desktop 1、Workbench 1、Termel 1 |
| `compactStructuredToolDescription` | `@velaros-ai/tool-contract` 的 toolDescriptions.compact(...) | `./tool-contract` | 0 | Desktop 2 |
| `createApprovalOperationKey` | agentToolContracts.createApprovalOperationKey(...) | `./tool-contract` | 2（已改完） | Workbench 2 |
| `createManualApprovalOptions` | agentToolContracts.createManualApprovalOptions(...) | `./tool-contract` | 2（已改完） | Desktop 6、Workbench 1 |
| `createTaskApprovalPort` | agentToolContracts.createTaskApprovalPort(...) | `./tool-contract` | 0 | Desktop 1、Workbench 2 |
| `createToolSchemaBundle` | `@velaros-ai/tool-contract` 的 toolSchemas.bundle(...) | `./tool-contract` | 2（已改完） | — |
| `defineToolRuntimeSpec` | `@velaros-ai/tool-contract` 的 toolContracts.defineRuntimeSpec(...) | `./tool-contract` | 0 | Desktop 1、Workbench 1 |
| `fileContextFor` | fileContextRegistry.for(carrier) | `./tool-contract` | 6（已改完） | Workbench 2 |
| `isCanonicalToolId` | `@velaros-ai/tool-contract` 的 toolIdentity.isCanonical(...) | `./tool-contract` | 0 | Desktop 1 |
| `isStructuredToolDescription` | `@velaros-ai/tool-contract` 的 toolDescriptions.isStructured(...) | `./tool-contract` | 0 | Desktop 1 |
| `optionalReadEndLine` | agentToolContracts.optionalReadEndLine(...) | `./tool-contract` | 1（已改完） | — |
| `optionalReadMaxChars` | agentToolContracts.optionalReadMaxChars(...) | `./tool-contract` | 1（已改完） | — |
| `optionalReadStartLine` | agentToolContracts.optionalReadStartLine(...) | `./tool-contract` | 1（已改完） | — |
| `readToolSchemaDiscoveryNames` | agentToolContracts.readSchemaDiscoveryNames(...) | `./tool-contract` | 0 | Termel 1 |
| `refineBoundedReadInput` | agentToolContracts.refineBoundedReadInput(...) | `./tool-contract` | 1（已改完） | — |
| `renderParameterDescription` | `@velaros-ai/tool-contract` 的 renderParameterDescription(...) | `./tool-contract` | 0 | Desktop 1 |
| `requiredResultLimit` | agentToolContracts.requiredResultLimit(...) | `./tool-contract` | 3（已改完） | — |
| `schemaToInputSchema` | `@velaros-ai/tool-contract` 的 toolSchemas.toInputSchema(...) | `./tool-contract` | 0 | Desktop 2、Workbench 1、Termel 1 |
| `structureToolDescriptionsForCategory` | `@velaros-ai/tool-contract` 的 toolDescriptions.structureForCategory(...) | `./tool-contract` | 0 | Desktop 1 |

### 3.5 值进常量表

| 旧名 | 新名 / 去向 | 新入口 | Platform 仓消费点 | 三个产品仓消费点 |
| --- | --- | --- | --- | --- |
| `ALL_STREAM_RUNTIME_STATE_KINDS` | StreamRuntimeStateKinds.all | `./contracts` | 0 | Desktop 1 |
| `AgentCapabilityApiVersion` | AgentCapabilityApiVersionString | `./contracts` | 0 | Desktop 1 |
| `AgentCapabilityExecutionEventType` | AgentIdentity.capabilityExecutionEventType | `./contracts` | 0 | Desktop 1、Workbench 3 |
| `AgentCapabilityProtocolVersion` | AgentProtocolVersions.agentCapability | `./contracts` | 0 | Workbench 4 |
| `AgentModContributionAxisNames` | AgentModAxes.contributionAxisNames | `./contracts` | 0 | Desktop 1 |
| `CHAT_STORAGE_SCHEMA_VERSION` | AgentProtocolVersions.chatStorageSchema | `./contracts` | 0 | Desktop 1 |
| `ChatContextRetrievalIndexVersion` | AgentProtocolVersions.contextRetrievalIndex | `./contracts` | 0 | Desktop 1 |
| `ContextDedupeVetoTarget` | AgentContextThresholds.dedupeVetoTarget | `./contracts` | 0 | Desktop 1 |
| `ContextUsageCompactionPercent` | AgentContextThresholds.compactionPercent | `./contracts` | 0 | Desktop 1 |
| `ContextUsageHighWatermarkPercent` | AgentContextThresholds.highWatermarkPercent | `./contracts` | 0 | Desktop 1 |
| `DEFAULT_ACTIVE_BRANCH_ID` | AgentIdentity.defaultActiveBranchId | `./contracts` | 0 | Desktop 5 |
| `ExternalAgentBridgePairingLifetimeMs` | ExternalAgentBridgeLimits.pairingLifetimeMs | `./contracts` | 0 | Desktop 1、Termel 1 |
| `ExternalAgentBridgeProtocolDescriptor` | ExternalAgentBridgeProtocol | `./contracts` | 0 | Desktop 1、Termel 1 |
| `ExternalAgentBridgeProtocolVersion` | AgentProtocolVersions.externalAgentBridge | `./contracts` | 0 | Desktop 1、Termel 2 |
| `ProviderToolNamePattern` | AgentToolTransport.providerToolNamePattern | `./contracts` | 0 | Desktop 1 |
| `ReasoningLevelValues` | AgentFieldValues.reasoningLevel | `./contracts` | 0 | Desktop 3 |
| `TERMINAL_STREAM_RUNTIME_STATE_KINDS` | StreamRuntimeStateKinds.terminal | `./contracts` | 0 | Workbench 1 |
| `ToolCatalogDiscoveryToolName` | AgentToolNames.toolingCatalog | `./contracts` | 0 | Desktop 1、Termel 1 |
| `ToolSchemaDiscoveryToolName` | AgentToolNames.toolingSchema | `./contracts` | 0 | Termel 2 |
| `TurnContextMidRunNoteLead` | TurnContextFormat.dynamicLayerMarker（回合上下文块的格式常量表） | `./contracts` | 0 | Desktop 2 |
| `VelarosAgentSessionArchiveFormat` | AgentIdentity.sessionArchiveFormat | `./contracts` | 0 | Termel 1 |
| `VelarosAgentSessionArchiveSchemaVersion` | AgentProtocolVersions.sessionArchiveSchema | `./contracts` | 0 | Termel 1 |

### 3.6 工具集合与内置 mod

| 旧名 | 新名 / 去向 | 新入口 | Platform 仓消费点 | 三个产品仓消费点 |
| --- | --- | --- | --- | --- |
| `activeDirectiveTools` | agentTools（按名索引的单源） | `.` | 0 | Desktop 1 |
| `agentWorkflowSchema` | 已删无替代：工作流 IR 的 zod schema 不出包；用 createAgentWorkflowRuntime 跑，形状是 AgentWorkflowDefinition | `.` | 1（已改完） | — |
| `agentWorkflowTools` | agentTools | `.` | 0 | Desktop 1 |
| `backgroundJobTools` | agentTools | `.` | 0 | Desktop 1、Workbench 1 |
| `categoriesTools` | agentTools | `.` | 0 | Desktop 1、Workbench 1 |
| `collectBuiltinAgentModTools` | agentTools | `.` | 0 | Desktop 1 |
| `confirmationTools` | agentTools | `.` | 0 | Desktop 1 |
| `contextRetrievalTools` | agentTools | `.` | 0 | Desktop 1、Workbench 1 |
| `dispatchAgentTools` | agentTools | `.` | 0 | Desktop 1、Workbench 1 |
| `goalTools` | agentTools | `.` | 0 | Desktop 1、Workbench 2 |
| `plansTools` | agentTools | `.` | 0 | Desktop 1、Workbench 2 |

### 3.7 错误类改按码判

| 旧名 | 新名 / 去向 | 新入口 | Platform 仓消费点 | 三个产品仓消费点 |
| --- | --- | --- | --- | --- |
| `AgentSessionLeaseConflictError` | 按 AgentErrorCodes.sessionLeaseConflict 判（错误类已删） | `./contracts` | 0 | Termel 1 |
| `ContextEpochRequestToolName` | 已删无替代：死常量，当前运行时不把它当治理入口 | `./contracts` | 0 | Desktop 1 |
| `McpAuthorizationRequiredError` | 按 AgentErrorCodes.mcpAuthorizationRequired 判（类不出包） | `./contracts` | 0 | Termel 1 |

### 3.8 改用执行栈

| 旧名 | 新名 / 去向 | 新入口 | Platform 仓消费点 | 三个产品仓消费点 |
| --- | --- | --- | --- | --- |
| `AgentExecutionStackWithQuery` | AgentExecutionStackWithQueryApi（弃用别名删除） | `.` | 0 | Workbench 1 |
| `AgentRunner` | AgentExecutionStackWithQueryApi.createRunner(options) | `.` | 0 | Desktop 1 |
| `ContextBuilder` | createAgentExecutionStack(...) 内部装配 | `.` | 0 | Desktop 1、Workbench 1 |
| `ContextResidencyLedger` | ContextGovernanceSessionRegistryApi 的只读诊断面 | `.` | 0 | Desktop 1 |
| `PromptStateBuilder` | createAgentExecutionStack(...) 内部装配 | `.` | 0 | Desktop 1 |
| `RunContext` | createAgentExecutionStack(...) 内部装配 | `.` | 0 | Workbench 1 |
| `StreamTurn` | createAgentExecutionStack(...) 的 executeSolo | `.` | 0 | Desktop 1 |
| `defaultRuntimePromptFeaturePolicy` | 不注入即得（createToolRegistry / createToolCapabilityRegistry 的缺省） | `.` | 0 | Workbench 1 |

---

## 4. 已删、没有替代的名字（1176）

### 4.1 宿主侧 IPC DTO 与界面动作类型（68）

这些是 Desktop / Workbench 自己的进程间消息形状与界面动作联合，Agent 运行时一处也没用到——
它们当初被放进 agent 的可移植文件只是因为「两边都要用同一份形状」，但真正的所有者是产品仓。
1.0.0 起它们不再从 agent 出包，**请把定义搬进各自的产品仓**（形状原样照抄即可，Agent 不会再改它们）。

- `ActiveContextApplyGovernanceDecisionInput`、`ActiveContextGovernanceApplyResult`、`ActiveContextGovernanceDecision`、`AgentModHookHandler`
- `AgentModHookOutcomeMap`、`AgentPermissionReply`、`AgentProductSurfaceDefinition`、`BackendLogNotificationEvent`
- `ChatAbortRequest`、`ChatActiveContextRequest`、`ChatActiveDirectivesChangedEvent`、`ChatApplyActiveContextGovernanceRequest`
- `ChatArchiveActiveContextRequest`、`ChatArchiveActiveDirectiveRequest`、`ChatAssessActiveContextGovernanceRequest`、`ChatContextPipelineStageRun`
- `ChatContextRetrievalHandle`、`ChatContextRetrievalIndexDiagnosticsRequest`、`ChatFolderRegistryEntry`、`ChatFolderRegistrySnapshot`
- `ChatGenerateSuggestionsRequest`、`ChatGenerateSuggestionsResponse`、`ChatGetGoalLifecycleRequest`、`ChatGetGoalLifecycleResponse`
- `ChatGoalLifecycleAction`、`ChatHookArmHandoffEvent`、`ChatHookBridgePingEvent`、`ChatHookFocusSessionEvent`
- `ChatHookProvideGuidanceEvent`、`ChatHookResolveConfirmationEvent`、`ChatHookResolveHandoffEvent`、`ChatHookSendTaskEvent`
- `ChatLoadSessionPayloadRequest`、`ChatLoadWorkerThreadDetailRequest`、`ChatLoadWorkerThreadDetailResponse`、`ChatPersistSessionPayloadsRequest`
- `ChatSaveFolderRegistryRequest`、`ChatSessionContextView`、`ChatSessionContextViewStore`、`ChatSessionSearchMatch`
- `ChatSessionSearchRequest`、`ChatSessionSearchResponse`、`ChatSessionSearchResultGroup`、`ChatStreamSnapshotCursor`
- `ChatStreamSnapshotRequest`、`ChatSuggestionItem`、`ChatSuggestionPhase`、`ChatSummarizeForHandoffRequest`
- `ChatSummarizeForHandoffResponse`、`ChatTranslateThinkingRequest`、`ChatTranslateThinkingResponse`、`ChatTurnContextChangedEvent`
- `ChatTurnContextPeekRequest`、`ChatUpdateGoalLifecycleRequest`、`ChatUpdateGoalLifecycleResponse`、`ExecutionAbortSubAgentWorkerRequest`
- `ExecutionAbortSubAgentWorkerResult`、`ExecutionHasPendingInteractionRequest`、`ExecutionHasPendingInteractionResult`、`ExecutionRelaySubAgentGuidanceRequest`
- `ExecutionRelaySubAgentGuidanceResult`、`SkillListRequest`、`SkillSetEnabledRequest`、`SkillSummary`
- `StoredChatSession`、`ToolOverview`、`ToolProviderDescriptor`、`TurnContextPeekSnapshot`

### 4.2 包内实现细节（1108）

这些名字在 1.0.0 里不再出包：要么是包内零件（循环、回合、流消费、历史清洗、控制面规划器、
各类 utils 函数），要么是没有任何公开签名用得到的数据类型与 zod schema。仓内与三个产品仓都没有
消费点，逐个 grep 核过。需要它们提供的能力，走 §3 的替代面。

分布（按声明所在的目录）：`impl/loop/`、`impl/context/`、`impl/residency/`、`impl/retrieval/`、
`impl/records/`、`impl/tools/`、`utils/**` 与 `types/**` 里没有进公开签名闭包的那部分。
完整名单可由基线对比复现：
`git show <收口前的提交>:baselines/agent/public-api.json` 与当前 `baselines/agent/public-api.json`
取名字集合差，再减去 §3 与 §4.1 列出的名字。

### 4.3 zod schema 一律不出包

`./protocol` 上原先出包的全部 `*Schema` 值在 1.0.0 里不再出现。数据类型照旧可以叫得出名字
（在 `./contracts`），只是没有运行期校验器。要在包外做校验只有一条路：让 Agent 替你解析——
`agentWire.*`（`./chat`）与 `agentSessionKit.parseArchiveEnvelope`（`.`）是仅有的两个解析面。
工具 schema 的快照由 `check:agent-schemas` 盯着 `baselines/agent/` 下的基线。

---

## 5. 模型面工具的删改

本轮把第 5 步留下的四个兼容外壳整体删掉（它们的 `isAvailable` 早已恒假，不在任何一轮的工具面上）：

| 工具 | 去向 |
| --- | --- |
| `context:distill` | 已退役：上下文折叠由运行时按实际容量自动完成，原文用 `context:recall` 取回 |
| `goal:get` | 并入 `goal:update`：不传任何字段调用即为读取 |
| `plan:get` | 并入 `plan:update`：不传任何字段调用即为读取，回执里带任务、推荐动作与执行建议 |
| `job:cancel` | 并入 `agent:dispatch({ thread_id, interrupt: true })`，之后仍可用 `job:read_output` 看最终输出 |

同步删掉的还有：`AgentToolNames` 的 `contextDistill` / `goalGet` / `planGet` / `jobCancel` 四个键、
`AgentToolCategoryByName` 里对应的四行、导出名 `distillContext` / `getGoal` / `getPlan` /
`cancelBackgroundJob` / `contextDistillTools`、入参类型 `DistillContextInput` 与它的 schema，
以及死常量 `ContextEpochRequestToolName`。内置工具从 20 个变成 **16 个**。

---

## 6. 三个产品仓要改的调用点

逐文件列出真的写了 `@velaros-ai/agent*` 的源文件（注释与文档不算）。
Desktop 362 个文件、Workbench 48 个、Termel 14 个。
改法一律按 §3 的对照表：**类改工厂、函数改套件方法、常量改常量表、`./protocol` 与 `./run-context`
等入口改 `./contracts` 或 `.`**。

### 6.1 VelarOS-Desktop（362 个文件）

| 文件 | 现在引的入口 |
| --- | --- |
| `packages/ipc/src/chatStreamEventSchemas.ts` | ./protocol |
| `packages/ipc/src/contracts.ts` | ./protocol |
| `packages/ipc/src/desktopChatContracts.ts` | ./protocol |
| `packages/ipc/src/desktopConfigContracts.ts` | ./protocol |
| `packages/ipc/src/desktopCustomAgentContracts.ts` | ./protocol |
| `packages/ipc/src/desktopHookContracts.ts` | ./protocol |
| `packages/ipc/src/desktopModMarketContracts.ts` | ./protocol |
| `packages/ipc/src/desktopProjectContracts.ts` | ./protocol |
| `packages/ipc/src/desktopScheduledTaskContracts.ts` | ./protocol |
| `packages/ipc/src/desktopSkillContracts.ts` | ./protocol |
| `packages/ipc/src/desktopToolContracts.ts` | ./protocol |
| `packages/ipc/src/externalAgentContracts.ts` | ./protocol |
| `packages/ipc/src/rendererIpcContract.ts` | ./protocol |
| `packages/ipc/src/sidecarChannelSchemas.ts` | ./protocol |
| `scripts/checks/agentModWiring.mjs` | . |
| `scripts/checks/kernelAssembly.mjs` | . |
| `scripts/checks/rendererAgentBoundary.mjs` | ./chat、./chat-stream、./protocol |
| `scripts/checks/toolIdentityWiring.mjs` | . |
| `scripts/harness/mcp/run.mjs` | . |
| `scripts/harness/session-ledger/run.mjs` | . |
| `src/agent-engines/main/chat/EngineExecutionCoordinator.ts` | .、./protocol |
| `src/agent-engines/main/runtime/engineLocalizedText.ts` | ./protocol |
| `src/agent-engines/main/runtime/types.ts` | ./protocol |
| `src/agent-engines/renderer/features/chat/EngineReadinessCard.tsx` | ./protocol |
| `src/agent-engines/renderer/features/chat/buildEngineComposerSurface.ts` | ./protocol |
| `src/devtools/agent-lab/RealTaskAcceptance.ts` | . |
| `src/main/EnvSchema.ts` | . |
| `src/main/account/CloudSessionAccess.ts` | . |
| `src/main/agent/AgentRoleEngine.ts` | . |
| `src/main/agent/AgentRunner.ts` | . |
| `src/main/agent/CapabilityToolMode.ts` | ./protocol |
| `src/main/agent/CodingSessionTracker.ts` | .、./protocol |
| `src/main/agent/DesktopAgentConfig.ts` | . |
| `src/main/agent/DesktopAgentRoles.ts` | .、./protocol |
| `src/main/agent/DesktopAgentRuntimePolicy.ts` | .、./protocol |
| `src/main/agent/DesktopAgentSurfaceCategories.ts` | ./protocol |
| `src/main/agent/DesktopToolResidency.ts` | .、./protocol |
| `src/main/agent/DesktopWorkspaceIntentClassifier.ts` | .、./protocol |
| `src/main/agent/DesktopWorkspacePromptContributor.ts` | . |
| `src/main/agent/PromptFeaturePolicy.ts` | . |
| `src/main/agent/SubAgentGuidanceRelayService.ts` | . |
| `src/main/agent/context/ContextDistillerWiring.ts` | . |
| `src/main/agent/context/ContextGovernanceWiring.ts` | . |
| `src/main/agent/context/ToolConfirmationPolicy.ts` | ./protocol |
| `src/main/agent/context/ToolContext.ts` | .、./protocol、./tool-contract |
| `src/main/agent/context/UnattendedToolPolicy.ts` | ./protocol |
| `src/main/agent/custom-agents/CustomAgentFileStore.ts` | .、./protocol |
| `src/main/agent/custom-agents/CustomAgentToolCategories.ts` | ./protocol |
| `src/main/agent/custom-agents/Ipc.ts` | ./protocol |
| `src/main/agent/skills/BundledSkillCatalog.ts` | . |
| `src/main/agent/skills/BundledSkillProvider.ts` | .、./protocol |
| `src/main/agent/skills/Ipc.ts` | .、./protocol |
| `src/main/agent/skills/ModSkillProvider.ts` | .、./protocol |
| `src/main/agent/skills/SkillSummaryProjection.ts` | . |
| `src/main/agent/skills/index.ts` | .、./protocol |
| `src/main/agent/sub-agents/CompositeSubAgentTypeProvider.ts` | .、./protocol |
| `src/main/agent/sub-agents/ModSubAgentTypeProvider.ts` | .、./protocol |
| `src/main/agent/unattended/UnattendedRunTranscriptRecorder.ts` | ./protocol |
| `src/main/agent/unattended/UnattendedTaskChatStream.ts` | .、./protocol |
| `src/main/agent/unattended/UnattendedTaskToolPolicy.ts` | .、./protocol |
| `src/main/bootstrap/Composition.ts` | .、./protocol/agent-capability |
| `src/main/bootstrap/FileLog.ts` | ./protocol |
| `src/main/bootstrap/RuntimeTypes.ts` | .、./protocol |
| `src/main/bootstrap/Services.ts` | . |
| `src/main/bootstrap/composition/chat.ts` | . |
| `src/main/bootstrap/composition/chatStores.ts` | . |
| `src/main/bootstrap/composition/config.ts` | . |
| `src/main/bootstrap/composition/hooks.ts` | . |
| `src/main/bootstrap/composition/webConversationSession.ts` | . |
| `src/main/chat/ChatAuxiliaryModelTasks.ts` | ./protocol |
| `src/main/chat/ChatHookInspectionService.ts` | .、./protocol |
| `src/main/chat/ChatSuggestions.ts` | ./protocol |
| `src/main/chat/ContextHandoffTransfer.ts` | ./protocol |
| `src/main/chat/ExecutionCoordinator.ts` | .、./protocol |
| `src/main/chat/HookPendingConfirmationProjection.ts` | ./protocol |
| `src/main/chat/Ipc.ts` | ./protocol |
| `src/main/chat/PureChatExecutionService.ts` | .、./protocol |
| `src/main/chat/RunPlan.ts` | .、./protocol |
| `src/main/chat/Service.ts` | .、./protocol |
| `src/main/chat/SessionExecutionPort.ts` | .、./protocol |
| `src/main/chat/SessionSearchService.ts` | .、./protocol |
| `src/main/chat/StreamBridge.ts` | .、./protocol |
| `src/main/chat/StreamSnapshots.ts` | ./protocol |
| `src/main/chat/hookExecutionEventSummaries.ts` | ./protocol |
| `src/main/chat/ledger/ChatLedgerMirror.ts` | .、./protocol |
| `src/main/chat/ledger/SessionLedgerReadAssembler.ts` | .、./protocol |
| `src/main/chat/ledger/chatSessionLedgerProjection.ts` | .、./protocol |
| `src/main/chat/pureChatDebugTurnSnapshot.ts` | ./protocol |
| `src/main/chat/pureChatSystemPrompt.ts` | ./protocol |
| `src/main/chat/turncontext/FanIn.ts` | .、./protocol |
| `src/main/config/Normalizer.ts` | ./protocol、./tool-contract |
| `src/main/desktop/DesktopSpaceService.ts` | ./protocol |
| `src/main/execution/NotificationPresentation.ts` | ./protocol |
| `src/main/execution/Runtime.ts` | .、./protocol |
| `src/main/hooks/DesktopHookCommandHandlers.ts` | . |
| `src/main/hooks/DesktopHookControlPlaneHandlers.ts` | . |
| `src/main/hooks/DesktopHookSessionHandlers.ts` | .、./protocol |
| `src/main/hooks/VelarHookSessionCatalog.ts` | ./protocol |
| `src/main/host/composition/createWorkspaceRuntime.ts` | . |
| `src/main/host/workspaces/WorkspaceBindingService.ts` | ./protocol |
| `src/main/ipc/RequestValidation.ts` | ./protocol |
| `src/main/kernel/AgentCapabilityRuntime.ts` | .、./protocol/agent-capability |
| `src/main/kernel/AgentModRuntime.ts` | .、./protocol |
| `src/main/kernel/ExternalModHookBindings.ts` | .、./protocol |
| `src/main/kernel/ExternalModToolBindings.ts` | .、./mcp、./protocol、./tool-contract |
| `src/main/storage/chat/ActiveContextStore.ts` | ./protocol |
| `src/main/storage/chat/ContextPayloadStoreAdapter.ts` | .、./protocol |
| `src/main/storage/chat/ContextRetrievalIndexStore.ts` | .、./protocol |
| `src/main/storage/chat/FolderRegistryStore.ts` | ./protocol |
| `src/main/storage/chat/KernelBackgroundJobOutputStore.ts` | . |
| `src/main/storage/chat/PayloadStore.ts` | .、./protocol |
| `src/main/storage/chat/RetrievalStateStoreAdapter.ts` | .、./protocol |
| `src/main/storage/chat/StateStore.ts` | ./protocol |
| `src/main/storage/chat/StreamRecoveryStore.ts` | ./chat-stream、./protocol |
| `src/main/storage/chat/sessionLedgerReadSource.ts` | . |
| `src/main/storage/chat/sessionLedgerSidecarStore.ts` | . |
| `src/main/storage/kernel/AgentModPackStore.ts` | . |
| `src/main/storage/kernel/ModMarketStaging.ts` | . |
| `src/main/storage/kernel/ModPackTextAssets.ts` | . |
| `src/main/storage/kernel/VelarModArchive.ts` | ./mods |
| `src/main/tools/ModToolProvider.ts` | .、./protocol |
| `src/main/tools/Provider.ts` | ./protocol |
| `src/main/tools/ToolCollections.ts` | .、./protocol |
| `src/main/tools/ToolContextProjection.ts` | ./protocol |
| `src/main/tools/ToolContextTypes.ts` | .、./protocol |
| `src/main/tools/ToolDescription.ts` | ./tool-contract |
| `src/main/tools/ToolRegistry.ts` | .、./protocol、./tool-contract |
| `src/main/tools/ToolSurfaceCatalog.ts` | ./protocol、./tool-contract |
| `src/main/tools/ToolTypes.ts` | ./tool-contract |
| `src/main/tools/collections/builtin/Collection.ts` | . |
| `src/main/tools/collections/builtin/Peers.tool.ts` | ./protocol、./tool-contract |
| `src/main/tools/collections/builtin/ProblemFeedback.tool.ts` | ./tool-contract |
| `src/main/tools/collections/builtin/Proposals.tool.ts` | ./protocol、./tool-contract |
| `src/main/tools/collections/builtin/Proposals.ts` | ./protocol |
| `src/main/tools/collections/builtin/UserActionCard.tool.ts` | ./tool-contract |
| `src/main/tools/collections/builtin/UserActionCard.ts` | ./protocol |
| `src/main/tools/collections/builtin/UserActionFormPresets.ts` | ./protocol |
| `src/main/tools/context/GovernanceContextTypes.ts` | ./protocol |
| `src/main/tools/mcp/McpServerManager.ts` | ./mcp |
| `src/main/tools/mcp/McpToolProvider.ts` | . |
| `src/mods/browser/main/context/BrowserTools.ts` | .、./protocol、./tool-contract |
| `src/mods/browser/main/turn-context/BrowserCurrentPageSource.ts` | .、./protocol |
| `src/mods/browser/renderer/components/chat/BrowserScreenshotGroup.tsx` | ./protocol |
| `src/mods/flagged-tasks/main/runtime/FlaggedTaskService.ts` | .、./protocol |
| `src/mods/flagged-tasks/renderer/pages/FlaggedTasksPage.tsx` | ./protocol |
| `src/mods/image-generation/manifest.ts` | .、./protocol |
| `src/mods/image-generation/shared/main/MediaFiles.ts` | . |
| `src/mods/memory/manifest.ts` | .、./protocol |
| `src/mods/office/manifest.ts` | ./protocol |
| `src/mods/project/main/code/codegraph/CodeGraphMcpSession.ts` | ./mcp |
| `src/mods/project/main/context/ProjectTools.ts` | ./tool-contract |
| `src/mods/project/main/domain/signals/Coordinator.ts` | .、./protocol |
| `src/mods/project/main/domain/signals/Store.ts` | .、./protocol |
| `src/mods/project/main/project/ProjectGitBranchService.ts` | ./protocol |
| `src/mods/project/main/project/ProjectGitMessage.ts` | ./protocol |
| `src/mods/project/main/project/ProjectGitService.ts` | ./protocol |
| `src/mods/project/main/turn-context/ProjectRootsSource.ts` | .、./protocol |
| `src/mods/project/renderer/hooks/useProjectGitActions.ts` | ./protocol |
| `src/mods/rendererCatalog.tsx` | ./protocol |
| `src/mods/scheduled-tasks/main/runtime/AgentTaskRunner.ts` | .、./protocol |
| `src/mods/scheduled-tasks/main/runtime/ScheduledTaskLedgerSummarizer.ts` | ./protocol |
| `src/mods/scheduled-tasks/main/runtime/ScheduledTaskRepository.ts` | ./chat、./protocol |
| `src/mods/scheduled-tasks/main/runtime/ScheduledTaskService.ts` | ./chat、./protocol |
| `src/mods/scheduled-tasks/main/skills/ScheduledTasks.skill.ts` | . |
| `src/mods/scheduled-tasks/main/tools/ScheduledTask.tool.ts` | ./protocol、./tool-contract |
| `src/mods/scheduled-tasks/manifest.ts` | ./protocol |
| `src/mods/scheduled-tasks/renderer/components/ScheduledTaskComposerDialog.tsx` | ./chat、./protocol |
| `src/mods/scheduled-tasks/renderer/components/chat/ScheduledTaskProposalCard.tsx` | ./protocol |
| `src/mods/scheduled-tasks/renderer/features/tasks/TasksPagePresentation.tsx` | ./chat、./protocol |
| `src/mods/video-generation/manifest.ts` | .、./protocol |
| `src/mods/web-search/main/tools/WebRead.ts` | . |
| `src/mods/web-search/main/tools/WebTools.ts` | . |
| `src/mods/web-search/manifest.ts` | .、./protocol |
| `src/plugins/chatgpt/main/runtime/ExternalAgentBridgeService.ts` | ./bridge、./protocol/external-agent-bridge |
| `src/plugins/chatgpt/main/runtime/WebConversationSessionPort.ts` | ./node |
| `src/plugins/chatgpt/main/runtime/WebConversationToolService.ts` | ./node、./protocol、./tool-contract |
| `src/plugins/chatgpt/renderer/features/chat/remote-session/RemoteChatSessionPane.tsx` | ./protocol |
| `src/renderer/src/components/business/session/GoalDockCard.tsx` | ./chat、./protocol |
| `src/renderer/src/components/chat/conversation/tools/CapabilityAutoApprovalNoticeCard.tsx` | ./protocol |
| `src/renderer/src/components/chat/conversation/worker-threads/WorkerThreadGuidanceInput.tsx` | ./protocol |
| `src/renderer/src/components/chat/panes/ChatDebugPane.tsx` | ./protocol |
| `src/renderer/src/components/chat/panes/ChatLandingPane.tsx` | ./protocol |
| `src/renderer/src/components/chat/panes/EmptyState.tsx` | ./protocol |
| `src/renderer/src/components/debug/builders/ChatDebugExecutionBuilders.tsx` | ./protocol |
| `src/renderer/src/components/debug/builders/ChatDebugToolBuilders.tsx` | ./protocol |
| `src/renderer/src/components/debug/context/ContextOSGovernancePanel.tsx` | ./protocol |
| `src/renderer/src/components/debug/context/ContextOSPipelineStages.tsx` | ./protocol |
| `src/renderer/src/components/debug/context/ContextOSTabPanel.tsx` | ./protocol |
| `src/renderer/src/components/debug/context/contextOSPresentationModel.ts` | ./protocol |
| `src/renderer/src/components/debug/panel/ChatDebug.shared.tsx` | ./protocol |
| `src/renderer/src/components/debug/panel/ChatDebugPanel.tsx` | ./protocol |
| `src/renderer/src/components/debug/panel/DebugIpcRow.tsx` | ./protocol |
| `src/renderer/src/components/debug/panel/DebugModuleSections.tsx` | ./protocol |
| `src/renderer/src/components/debug/panel/DebugNetworkRow.tsx` | ./protocol |
| `src/renderer/src/components/debug/panel/debugDownloadPackage.ts` | ./protocol |
| `src/renderer/src/components/shell/sidebar/SidebarSessionSearchDialog.tsx` | ./chat |
| `src/renderer/src/features/agentSurface/DesktopModAgentChatPanel.tsx` | ./protocol |
| `src/renderer/src/features/agentSurface/hooks/useAgentSurfaceRuntimeContext.ts` | ./protocol |
| `src/renderer/src/features/agentSurface/hooks/useAgentSurfaceSession.ts` | ./protocol |
| `src/renderer/src/features/chat/hooks/chatSuggestionState.pure.ts` | ./protocol |
| `src/renderer/src/features/chat/hooks/chatSuggestionTranscript.pure.ts` | ./protocol |
| `src/renderer/src/features/chat/hooks/useChatDebugPaneModel.ts` | ./protocol |
| `src/renderer/src/features/chat/hooks/useChatPageComposerSurface/buildChatPageComposerControl.ts` | ./protocol |
| `src/renderer/src/features/chat/hooks/useChatPageComposerSurface/composerSurfaceParams.ts` | ./protocol |
| `src/renderer/src/features/chat/hooks/useChatPageComposerSurface/index.ts` | ./protocol |
| `src/renderer/src/features/chat/hooks/useChatPageComposerSurface/useChatPageComposerDraftInteractions.ts` | ./protocol |
| `src/renderer/src/features/chat/hooks/useChatPageComposerSurface/useChatPageComposerDraftQueueSubmission.ts` | ./protocol |
| `src/renderer/src/features/chat/hooks/useChatPageComposerSurface/useChatPageComposerRestoreMessage.ts` | ./protocol |
| `src/renderer/src/features/chat/hooks/useChatPageSurface/index.ts` | ./protocol |
| `src/renderer/src/features/chat/hooks/useChatPageSurface/useChatPageSessionVmSlice.ts` | ./protocol |
| `src/renderer/src/features/chat/hooks/useChatSuggestions.ts` | ./protocol |
| `src/renderer/src/features/chat/surfaces/ChatCommandConsoleState.ts` | ./protocol |
| `src/renderer/src/features/chat/surfaces/ChatCommandConsoleSurface.tsx` | ./protocol |
| `src/renderer/src/features/chat/surfaces/ChatConversationSurface.tsx` | ./protocol |
| `src/renderer/src/features/chat/surfaces/ChatDebugPaneSurface.tsx` | ./protocol |
| `src/renderer/src/features/chat/surfaces/ChatSessionPaneSurface.tsx` | ./protocol |
| `src/renderer/src/features/chat/surfaces/SessionApprovalPanel.tsx` | ./protocol |
| `src/renderer/src/features/chat/surfaces/WorkspaceDirectiveNotebook.tsx` | ./protocol |
| `src/renderer/src/features/chat/surfaces/buildChatDebugPaneState.pure.ts` | ./protocol |
| `src/renderer/src/features/chat/surfaces/chatCommandConsoleRuntime.ts` | ./protocol |
| `src/renderer/src/features/tasks/unattended/unattendedTranscriptReplay.ts` | ./protocol |
| `src/renderer/src/hooks/app/preferences/rendererPreferences.ts` | ./protocol |
| `src/renderer/src/hooks/app/provider/appContext.shared.ts` | ./protocol |
| `src/renderer/src/hooks/app/provider/useAppConfigActions.ts` | ./protocol |
| `src/renderer/src/hooks/chat/bridges/usePromptFeaturesEnabledBridge.ts` | ./protocol |
| `src/renderer/src/hooks/chat/composer/QueuedComposerDraftStore.ts` | ./protocol |
| `src/renderer/src/hooks/chat/composer/skillWorkspaceScope.ts` | ./protocol |
| `src/renderer/src/hooks/chat/composer/useChatComposerDraftState.ts` | ./protocol |
| `src/renderer/src/hooks/chat/composer/useChatComposerOptions.ts` | ./protocol |
| `src/renderer/src/hooks/chat/composer/useChatComposerSubmission.ts` | ./protocol |
| `src/renderer/src/hooks/chat/composer/useGoalModePreflight.ts` | ./protocol |
| `src/renderer/src/hooks/chat/conversation/useChatConversationViewModel.ts` | ./protocol |
| `src/renderer/src/hooks/chat/runtime/effects/ChatStreamEventApplicator.ts` | ./chat-stream、./protocol |
| `src/renderer/src/hooks/chat/runtime/hooks/useChat/chatContext.tsx` | ./protocol |
| `src/renderer/src/hooks/chat/runtime/hooks/useChat/chatDiskHydrateMerge.pure.ts` | ./protocol |
| `src/renderer/src/hooks/chat/runtime/hooks/useChat/handoffSuggestion.pure.ts` | ./protocol |
| `src/renderer/src/hooks/chat/runtime/hooks/useChat/hookExecutionModeAxis.pure.ts` | ./chat、./protocol |
| `src/renderer/src/hooks/chat/runtime/hooks/useChat/pure.ts` | ./protocol |
| `src/renderer/src/hooks/chat/runtime/hooks/useChat/thinkingTranslationTarget.pure.ts` | ./protocol |
| `src/renderer/src/hooks/chat/runtime/hooks/useChat/useChatDiskHydrate.ts` | ./protocol |
| `src/renderer/src/hooks/chat/runtime/hooks/useChat/useChatGatewayBridges.ts` | ./protocol |
| `src/renderer/src/hooks/chat/runtime/hooks/useChat/useChatHandoffSuggestion.ts` | ./protocol |
| `src/renderer/src/hooks/chat/runtime/hooks/useChat/useChatPromptFeatureCallbacks.ts` | ./protocol |
| `src/renderer/src/hooks/chat/runtime/hooks/useChat/useChatThinkingTranslation.ts` | ./protocol |
| `src/renderer/src/hooks/chat/runtime/hooks/useChatExecutionActions/types.ts` | ./protocol |
| `src/renderer/src/hooks/chat/runtime/hooks/useChatExecutionActions/useChatExecutionFailureHandler.ts` | ./protocol |
| `src/renderer/src/hooks/chat/runtime/hooks/useChatExecutionActions/useChatExecutionResolveConfirmation.ts` | ./protocol |
| `src/renderer/src/hooks/chat/runtime/hooks/useChatExecutionActions/useChatExecutionSendMessage.ts` | ./chat、./protocol |
| `src/renderer/src/hooks/chat/runtime/hooks/useChatExecutionActions/useChatExecutionStopRewind.ts` | ./protocol |
| `src/renderer/src/hooks/chat/runtime/hooks/useChatSessionActions.ts` | ./protocol |
| `src/renderer/src/hooks/chat/runtime/hooks/useChatStreamSnapshotRecovery.ts` | ./protocol |
| `src/renderer/src/hooks/chat/runtime/hooks/useChatStreaming.ts` | ./protocol |
| `src/renderer/src/hooks/chat/runtime/hooks/useChatStreaming/types.ts` | ./protocol |
| `src/renderer/src/hooks/chat/runtime/hooks/useChatStreaming/useChatStreamPacer.ts` | ./protocol |
| `src/renderer/src/hooks/chat/runtime/hooks/useChatStreaming/useChatStreamingEventApplicators.ts` | ./protocol |
| `src/renderer/src/hooks/chat/runtime/hooks/useChatStreaming/useChatStreamingListen.ts` | ./chat-stream、./protocol |
| `src/renderer/src/hooks/chat/runtime/hooks/useChatStreaming/useChatStreamingSessionRegistry.ts` | ./protocol |
| `src/renderer/src/hooks/chat/runtime/hooks/useStreamListener.ts` | ./protocol |
| `src/renderer/src/hooks/chat/runtime/hooks/workspaceMutationLock.ts` | ./protocol |
| `src/renderer/src/hooks/chat/runtime/ipc/chatAttachmentIpcEffects.ts` | ./protocol |
| `src/renderer/src/hooks/chat/runtime/ipc/chatDebugIpcEffects.ts` | ./protocol |
| `src/renderer/src/hooks/chat/runtime/ipc/chatSessionIpcEffects.ts` | ./protocol |
| `src/renderer/src/hooks/chat/runtime/ipc/chatSessionPendingInteractionEffects.ts` | ./protocol |
| `src/renderer/src/hooks/chat/runtime/models/ChatStreamIngressOrder.ts` | ./protocol |
| `src/renderer/src/hooks/chat/runtime/models/ChatStreamProjectionCheckpoint.ts` | ./protocol |
| `src/renderer/src/hooks/chat/runtime/models/chatStreamingEventModel.ts` | ./chat-stream、./protocol |
| `src/renderer/src/hooks/chat/runtime/models/chatStreamingPendingReplay.ts` | ./chat-stream |
| `src/renderer/src/hooks/chat/runtime/models/chatStreamingStore.ts` | ./chat-stream、./protocol |
| `src/renderer/src/hooks/chat/runtime/models/chatTypes.ts` | ./protocol |
| `src/renderer/src/hooks/chat/state/session/chatSessionDiskIO.ts` | ./protocol |
| `src/renderer/src/hooks/chat/state/session/chatSessionFactories.ts` | ./protocol |
| `src/renderer/src/hooks/chat/state/session/chatSessionMessageState.ts` | ./chat、./protocol |
| `src/renderer/src/hooks/chat/state/session/chatSessionPersistence.ts` | ./chat、./protocol |
| `src/renderer/src/hooks/chat/state/session/chatSessionSuggestionCache.pure.ts` | ./protocol |
| `src/renderer/src/hooks/chat/state/session/chatSessionTraceState.ts` | ./protocol |
| `src/renderer/src/hooks/chat/state/session/chatSessionWidgetArtifacts.ts` | ./protocol |
| `src/renderer/src/hooks/chat/state/session/chatSessionWorkspacePayloads.ts` | ./chat、./protocol |
| `src/renderer/src/hooks/chat/state/stream/chatHtmlArtifactProtocolState.ts` | ./protocol |
| `src/renderer/src/hooks/chat/state/stream/chatStreamAwaitState.ts` | ./protocol |
| `src/renderer/src/hooks/chat/state/stream/chatStreamDebugState.ts` | ./protocol |
| `src/renderer/src/hooks/chat/state/stream/chatStreamFailureState.ts` | ./protocol |
| `src/renderer/src/hooks/chat/state/stream/chatStreamProgressState.ts` | ./protocol |
| `src/renderer/src/hooks/chat/state/stream/chatStreamRuntimeState.ts` | ./protocol |
| `src/renderer/src/hooks/chat/state/stream/chatStreamTextState.ts` | ./protocol |
| `src/renderer/src/hooks/chat/state/stream/chatStreamToolState.ts` | ./chat、./protocol |
| `src/renderer/src/hooks/chat/state/stream/chatStreamWorkerThreadState.ts` | ./chat、./protocol |
| `src/renderer/src/hooks/chat/useInstalledSkills.ts` | ./protocol |
| `src/renderer/src/hooks/debug/useDebugSessionSnapshot.ts` | ./protocol |
| `src/renderer/src/hooks/settings/toolCatalogLayout.ts` | ./protocol |
| `src/renderer/src/hooks/settings/toolSettingsViewModel.ts` | ./protocol |
| `src/renderer/src/hooks/settings/usePreferencesSettings.ts` | ./protocol |
| `src/renderer/src/hooks/shell/useSidebarSessionSearch.ts` | ./chat、./protocol |
| `src/renderer/src/i18n/core/I18nProvider.tsx` | ./protocol |
| `src/renderer/src/i18n/core/errorMessage.ts` | ./protocol |
| `src/renderer/src/i18n/core/i18n.shared.ts` | ./protocol |
| `src/renderer/src/i18n/messages/index.ts` | ./protocol |
| `src/renderer/src/ipc/index.ts` | ./protocol |
| `src/renderer/src/pages/ChatPage.tsx` | ./protocol |
| `src/renderer/src/pages/registry/pageTypes.ts` | ./protocol |
| `src/renderer/src/pages/tokenUsagePage.model.ts` | ./protocol |
| `src/renderer/src/runtime/conversation/desktopConversationActionPort.ts` | ./protocol |
| `src/renderer/src/runtime/conversation/desktopPromptFeaturePolicy.ts` | ./protocol |
| `src/renderer/src/runtime/conversation/projectProductConversationForUi.ts` | ./protocol |
| `src/renderer/src/runtime/conversation/projectProductConversationNotice.ts` | ./protocol |
| `src/renderer/src/utils/chat/browserScreenshotComposerAttachment.utils.ts` | ./protocol |
| `src/renderer/src/utils/chat/chatComposer.utils.ts` | ./protocol |
| `src/renderer/src/utils/chat/chatContextUsage.utils.ts` | ./chat |
| `src/renderer/src/utils/chat/chatHistoryRewind.utils.ts` | ./protocol |
| `src/renderer/src/utils/chat/chatPromptFeatureActivation.utils.ts` | ./protocol |
| `src/renderer/src/utils/chat/chatRewindNotice.utils.ts` | ./protocol |
| `src/renderer/src/utils/chat/chatSessionPendingInteraction.utils.ts` | ./protocol |
| `src/renderer/src/utils/chat/chatTrace.utils.ts` | ./protocol |
| `src/renderer/src/utils/chat/chatVirtualPasteReferences.ts` | ./protocol |
| `src/renderer/src/utils/chat/messageFileChangeSummary.utils.ts` | ./protocol |
| `src/renderer/src/utils/chat/turnContextChipGroups.utils.ts` | ./protocol |
| `src/renderer/src/utils/chat/turnContextFreeze.ts` | ./chat、./protocol |
| `src/shared/capabilities/DesktopPromptFeatures.ts` | ./protocol |
| `src/shared/capabilities/DesktopToolSpacePolicy.ts` | ./protocol |
| `src/shared/capabilities/DesktopTurnContextPolicy.ts` | ./protocol |
| `src/shared/chat/folderExecutionBinding.ts` | ./protocol |
| `src/shared/conversation/ProductConversation.ts` | ./protocol |
| `src/sidecar-host/SidecarChannelRouter.ts` | ./protocol |
| `src/sidecar-host/SidecarChatExecution.ts` | . |
| `src/sidecar-host/adapters/HeadlessAuthGate.ts` | . |
| `tests/maintained/scripts/checks/rendererAgentBoundary.test.mjs` | ./chat、./chat-stream、./protocol/execution |
| `tests/maintained/src/main/agent/AgentEngines.test.ts` | .、./protocol |
| `tests/maintained/src/main/agent/CapabilityToolMode.test.ts` | ./protocol |
| `tests/maintained/src/main/agent/ContextGovernanceWiring.test.ts` | . |
| `tests/maintained/src/main/agent/DesktopAgentRuntimePolicy.test.ts` | .、./protocol |
| `tests/maintained/src/main/agent/DesktopProjectPromptAssembly.test.ts` | .、./protocol |
| `tests/maintained/src/main/agent/SkillWorkspaceScope.test.ts` | . |
| `tests/maintained/src/main/agent/StreamTurnAbort.test.ts` | . |
| `tests/maintained/src/main/agent/fixtures/skillEnabledOwner.mjs` | . |
| `tests/maintained/src/main/agent/projectPromptAudit.ts` | . |
| `tests/maintained/src/main/chat/HookPendingConfirmationProjection.test.ts` | ./protocol |
| `tests/maintained/src/main/chat/SessionLedgerTerminalProjection.test.ts` | ./protocol |
| `tests/maintained/src/main/kernel/DesktopAgentCapabilityRuntime.test.ts` | .、./protocol/agent-capability |
| `tests/maintained/src/main/kernel/ExternalModHookBindings.test.ts` | . |
| `tests/maintained/src/main/kernel/ExternalModToolBindings.test.ts` | . |
| `tests/maintained/src/main/kernel/MemoryModRegistration.test.ts` | ./protocol |
| `tests/maintained/src/main/kernel/ModLifecycleOrdering.test.ts` | . |
| `tests/maintained/src/main/storage/ContextHandoffTransfer.test.ts` | . |
| `tests/maintained/src/main/storage/ContextPayloadStoreAdapter.test.ts` | .、./protocol |
| `tests/maintained/src/main/storage/KernelBackgroundJobOutputStore.test.ts` | . |
| `tests/maintained/src/main/storage/PayloadStoreEmptySnapshot.test.ts` | ./protocol |
| `tests/maintained/src/main/storage/SessionSidePartitionDeletion.test.ts` | ./protocol |
| `tests/maintained/src/main/storage/chat/FolderRegistryMemberExecutionBindingRoundTrip.test.ts` | ./protocol |
| `tests/maintained/src/main/storage/chat/FolderRegistryWriteSerialization.test.ts` | ./protocol |
| `tests/maintained/src/main/tools/FeedbackTool.test.ts` | ./protocol |
| `tests/maintained/src/main/tools/ProjectToolContextLifecycle.test.ts` | ./tool-contract |
| `tests/maintained/src/main/tools/ScheduledTaskTool.test.ts` | ./protocol |
| `tests/maintained/src/main/tools/ToolRegistryTurnSnapshot.test.ts` | . |
| `tests/maintained/src/main/tools/UserActionCardPromptFeatureAvailability.test.ts` | ./protocol |
| `tests/maintained/src/main/tools/mcp/McpServerManager.test.ts` | ./mcp |
| `tests/maintained/src/renderer/features/agentSurface/agentSurfaceContext.test.ts` | ./protocol |
| `tests/maintained/src/renderer/hooks/chat/chatStreamReasoningPacing.test.ts` | ./protocol |
| `tests/maintained/src/renderer/hooks/chat/chatSuggestionState.test.ts` | ./protocol |
| `tests/maintained/src/renderer/hooks/chat/composerSkillSelection.test.ts` | ./protocol |
| `tests/maintained/src/renderer/hooks/chat/conversationMessageSemantics.test.ts` | ./protocol |
| `tests/maintained/src/renderer/hooks/chat/projectInputHistoryPersistence.test.ts` | ./protocol |
| `tests/maintained/src/sidecar-host/chatStreamEventWireSchemas.test.ts` | ./protocol |
| `tests/maintained/src/sidecar-host/sidecarChatExecution.test.ts` | ./protocol |

### 6.2 VelarOS-Workbench（48 个文件）

| 文件 | 现在引的入口 |
| --- | --- |
| `scripts/test/projectSurfaceNaturalAcceptance.ts` | . |
| `scripts/test/verifyProjectTools.ts` | .、./tool-contract |
| `src/main/agent/WorkbenchActiveContextStore.ts` | ./protocol |
| `src/main/agent/WorkbenchAgentApprovalBroker.ts` | .、./protocol、./tool-contract |
| `src/main/agent/WorkbenchAgentControlTools.ts` | .、./protocol、./tool-contract |
| `src/main/agent/WorkbenchAgentExecutionStack.ts` | .、./protocol、./tool-contract |
| `src/main/agent/WorkbenchAgentToolRegistry.ts` | .、./protocol、./tool-contract |
| `src/main/agent/WorkbenchAgentUiBridge.ts` | . |
| `src/main/agent/WorkbenchAgentUiTools.ts` | ./protocol、./tool-contract |
| `src/main/agent/WorkbenchContextRecall.ts` | . |
| `src/main/agent/WorkbenchSubAgentPolicy.ts` | .、./protocol |
| `src/main/agent/WorkbenchToolConfirmationPolicy.ts` | ./protocol |
| `src/main/agent/context/WorkbenchContextPayloadDiskStore.ts` | . |
| `src/main/agent/context/WorkbenchContextPayloadStore.ts` | .、./protocol |
| `src/main/browser/WorkbenchBrowserToolHost.ts` | ./mods、./protocol |
| `src/main/index.ts` | . |
| `src/main/kernel/WorkbenchAgentCapabilityRuntime.ts` | .、./chat、./protocol、./protocol/agent-capability |
| `src/main/kernel/WorkbenchKernelIpc.ts` | ./protocol、./protocol/agent-capability |
| `src/main/kernel/WorkbenchKernelPermissionPolicy.ts` | . |
| `src/main/kernel/kernelHostProbe.ts` | .、./protocol/agent-capability |
| `src/main/workspace/CommandExecutionPolicy.ts` | ./protocol、./tool-contract |
| `src/main/workspace/ProjectCapabilityProvider.ts` | ./protocol、./tool-contract |
| `src/plugins/agent-engines/main/WorkbenchAgentPluginRuntime.ts` | . |
| `src/plugins/agent-engines/main/WorkbenchClaudeAgentRuntime.ts` | . |
| `src/plugins/agent-engines/main/WorkbenchCodexAgentRuntime.ts` | . |
| `src/plugins/agent-engines/main/WorkbenchEngineInteractionBroker.ts` | . |
| `src/renderer/src/components/settings/WorkbenchSettingsDialog.tsx` | ./protocol |
| `src/renderer/src/models/chat/workbenchGoalAutoContinue.ts` | ./chat、./protocol |
| `src/renderer/src/models/settings/workbenchPreferences.ts` | ./protocol |
| `src/renderer/src/runtime/conversation/standaloneWorkbenchConversationActionPort.ts` | ./protocol |
| `src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx` | ./protocol、./protocol/agent-capability |
| `src/renderer/src/runtime/standaloneWorkbenchChatRuntime.ts` | ./protocol |
| `src/renderer/src/runtime/standaloneWorkbenchRewind.ts` | ./protocol |
| `src/shared/workbenchKernel.ts` | ./protocol |
| `tests/workbench-agent-capability-runtime.test.ts` | .、./protocol、./protocol/agent-capability |
| `tests/workbench-agent-mod-surface.test.ts` | .、./protocol |
| `tests/workbench-agent-tool-context.test.ts` | . |
| `tests/workbench-agent-ui-tools.test.ts` | .、./protocol |
| `tests/workbench-command-approval.test.ts` | ./protocol、./tool-contract |
| `tests/workbench-context-persistence.test.ts` | . |
| `tests/workbench-context-recall.test.ts` | . |
| `tests/workbench-file-context.test.ts` | . |
| `tests/workbench-goal-auto-continue.test.ts` | ./protocol |
| `tests/workbench-goal-plan-state.test.ts` | . |
| `tests/workbench-import-fold.test.ts` | ./tool-contract |
| `tests/workbench-project-tool-discovery.test.ts` | . |
| `tests/workbench-prompt-assembly.test.ts` | . |
| `tests/workspace-capability-provider.test.ts` | .、./tool-contract |

### 6.3 VelarOS-Termel（14 个文件）

| 文件 | 现在引的入口 |
| --- | --- |
| `packages/serve-host/src/capability-contexts.ts` | ./tool-contract |
| `packages/serve-host/src/extension-bridge.ts` | ./bridge、./protocol |
| `packages/serve-host/src/tool-gateway.ts` | ./protocol、./tool-contract |
| `packages/serve-host/test/host-extension.e2e.test.ts` | ./protocol |
| `packages/serve-host/test/tool-discovery.test.ts` | ./protocol、./tool-contract |
| `packages/termel-runtime/src/agent-execution-stack.ts` | .、./protocol、./tool-contract |
| `packages/termel-runtime/src/agent-service.ts` | .、./protocol |
| `packages/termel-runtime/src/mcp.ts` | ./mcp |
| `packages/termel-runtime/src/permissions.ts` | ./session |
| `packages/termel-runtime/src/plugins.ts` | .、./mods、./protocol |
| `packages/termel-runtime/src/session-store.ts` | ./session |
| `packages/termel-runtime/src/skills.ts` | . |
| `products/termel/src/bin.ts` | ./remote/mcp |
| `products/termel/src/session-archive.ts` | ./session |

三个仓的 `package.json` 与 `bun.lock` 依赖版本提到 `^1.0.0`；Desktop 还要改
`tsconfig.node.json` / `tsconfig.web.json` 里 `@velaros-ai/agent/*` 的 paths（收成四条）与
`scripts/build/mainBundledPlatformPackages.json`。

### 6.4 VelarOS-Extension（3 处，不是 import）

Extension 没有 `import '@velaros-ai/agent'`，只在三处按字符串引了协议身份：
`protocol/external-agent-bridge.js`（注释里写着 `@velaros-ai/agent@0.5.0/protocol/external-agent-bridge`，
以及 `package: '@velaros-ai/agent'`）、`scripts/package.mjs`、`release/release-manifest.json`。
1.0.0 把外部桥的协议身份收进了 `ExternalAgentBridgeProtocol` 常量表（`./contracts`），
字段名与取值都没变，Extension 只需要把注释与清单里的版本号跟着改。

---

## 7. 本轮**没有**做完的（已知偏离方案 §3.4）

1. `createToolExecutor` / `createToolExecutionPolicy` 仍然出包。方案 §3.4 想让它们彻底不出包、
   由 `ToolContractExecutionFacadeApi` 顶替；但 `packages/project/test/` 里有 4 个集成测试要跑
   **单次工具调用并检查批量可见性与分页**，门面的 API 是租约取向的（`resolveCatalog` /
   `executeTool`），换过去等于重写这几条 B3 敏感的断言。方案本来就把「这些测试挪到仓库层
   `tests/`」排在 P0-1，所以这一步跟着 P0-1 一起做，本轮先按「类 → 工厂」处理。
2. `packages/project/scripts/model-guidance-audit.ts` 与 `packages/project/test/project-model-contracts.test.ts`
   仍按相对路径直接引 agent 的源码（12 处）。这是既有的跨包源码引用，方案 §1.3 已经点名，
   同样归 P0-1。
3. `docs/public-api-policy.json` 的 `rootEntrypoint.status` 从 `compatibility-umbrella` 改成
   `primary`（别名清零，没有移除窗口）；`scripts/agent/check-public-api.mjs` 相应放宽成
   「两种身份二选一」，`primary` 形态下不许再挂任何别名。
