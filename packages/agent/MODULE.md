# @velaros-ai/agent 模块卡片

读这份卡片的顺序：先看「这是什么」与「提供什么」，再看「骨干链路」里一次回合是怎么跑完的，
需要时看「结构」里的目录树与分层。类的实现、数据字段与工具函数的内部一般不用看。

标准见 `docs/architecture/module-ownership.md`，改造方案见 `docs/engineering/refactor-plans/agent.md`，
1.0.0 的逐符号迁移表见 `docs/engineering/refactor-plans/agent-migration.md`。

## 这是什么

VelarOS 的 Agent 运行时：一次「用户说话 → 模型跑 → 工具做事 → 结果回灌」的完整回合住在这里。

它只认识四件事：回合循环、上下文治理、工具执行链、委派（子 Agent 与工作流）；
**不认识任何具体能力**——文件、浏览器、记忆、项目这些全是空间包经能力注入面装进来的。
门禁 `check:agent-arch` 逐字盯着：代码、文案、注释里出现具体域词就拦（INV-21）。

它也不是会话权威：会话住在产品的 renderer 里，Agent 只负责把交进来的一次执行跑完。

## 提供什么

四个入口。`./contracts`、`./chat`、`./tool-contract` 的引用链不碰 Node 内置模块（INV-16），
渲染进程可以直接加载；根入口是 Node 宿主面。

| 入口 | 给谁 | 运行环境 |
| --- | --- | --- |
| `.` | Desktop / Workbench / Termel 装 Agent 运行时 | Node |
| `./contracts` | 任何进程拿可移植的契约数据与常量表 | 任何环境 |
| `./chat` | 渲染进程消费聊天流、投影消息与展示态 | 任何环境 |
| `./tool-contract` | 空间包与宿主写工具时的审批、入参复用与文件上下文 | 任何环境 |

`./contracts` 是根入口的可移植子集（`contract/constants.ts` 的 26 张常量表 + `types/agent.ts` 的可移植数据）：
只要数据不要值的调用方认它；拿值一律从 `.`、`./chat` 或 `./tool-contract` 取。

通用的工具定义、说明渲染、schema 打包、宽容入参与身份判定不在这里，在 `@velaros-ai/tool-contract`。

<!-- 名字清单：门禁要求每个导出的值与每个公开接口都在这一节里出现 -->

### 公开接口

共 169 个：产品面（`contract/provides.ts`）直接声明 2 个、登记类上方接口 81 个，注入面
（`contract/requires.ts`）86 个。全部从根入口导出，名字与它们的类一一对应（`XxxApi` ↔ `impl/**/Xxx.ts`）。

- `AgentBackgroundAgent`、`AgentBackgroundAgentControlPort`、`AgentBackgroundAgentPort`、`AgentBackgroundAgentState`
- `AgentCapabilityEventPublisherApi`、`AgentCapabilityRuntime`、`AgentChatKitApi`、`AgentChatRuntimeConfig`
- `AgentExecutionConfig`、`AgentExecutionStackApi`、`AgentExecutionStackToolRegistry`、`AgentExecutionStackWithQueryApi`
- `AgentGoalServiceApi`、`AgentLedgerFilesApi`、`AgentModHostAssemblerApi`、`AgentModLoaderApi`
- `AgentModPackReader`、`AgentModRegistryApi`、`AgentModSeamDispatcherApi`、`AgentModelProvider`
- `AgentModelRequestOptions`、`AgentModelRequestPolicy`、`AgentModelResolverPort`、`AgentModelRetryPolicy`
- `AgentPlanServiceApi`、`AgentQuestionServiceApi`、`AgentRoleDescriptorProvider`、`AgentRoleEngineApi`
- `AgentRunLifecycle`、`AgentRunnerApi`、`AgentRuntimeCapabilityPorts`、`AgentRuntimeInputPort`
- `AgentRuntimeKitApi`、`AgentSessionCatalogPort`、`AgentSessionCatalogQuery`、`AgentSessionEventPort`
- `AgentSessionKitApi`、`AgentSessionLease`、`AgentSessionLeaseClaim`、`AgentSessionLeasePort`
- `AgentSessionLifecycleStatus`、`AgentSessionMetadata`、`AgentSessionResourceReference`、`AgentSkillProvider`
- `AgentSkillRepositoryApi`、`AgentSurfaceProfileProvider`、`AgentSystemRuntimeConfig`、`AgentToolContractsApi`
- `AgentTurnCapabilitySnapshotSource`、`AgentWireApi`、`AgentWorkflowRuntimeApi`、`AppRuntimeFacts`
- `ApprovalPort`、`AuthGatePort`、`CapabilityContextCollector`、`CapabilityDelegationPolicy`
- `CapabilityIntentClassifier`、`CapabilityPromptContributor`、`CapabilityScopePolicy`、`CapabilityValidationInterpreter`
- `ChatContextRetrievalServiceApi`、`ChatKernelSessionBridgeApi`、`ChatMessagesApi`、`ChatRuntimeEventsApi`
- `ChatSearchMessagesApi`、`ChatSearchRankingApi`、`ChatStreamConsumerApi`、`ChatStreamProtocolApi`
- `ChatStreamSessionLogApi`、`CodingSessionTrackerApi`、`ContextGovernanceSessionRegistryApi`、`ContextMigrationEventSink`
- `ContextPayloadStore`、`ContextRetrievalQueryTraceStoreApi`、`CreateAgentKernelModuleOptions`、`CreateAgentSessionMetadataInput`
- `CustomSubAgentRegistry`、`DirectiveOperationsApi`、`ExecPlanLedgerApi`、`ExecPlanStateApi`
- `ExecRoutingApi`、`ExecutionActivitySignalsPort`、`ExecutionClock`、`ExecutionCollaborationPort`
- `ExecutionEventBusApi`、`ExecutionGuidanceQueueApi`、`ExecutionGuidanceRelayPlanner`、`ExecutionIdFactory`
- `ExecutionRecordsPathPort`、`ExecutionResourcePort`、`ExecutionServiceApi`、`ExecutionSpanScopeFactory`
- `ExecutionStoreApi`、`ExternalAgentBridgeCommandQueueApi`、`ExternalAgentBridgeEventWindowApi`、`ExternalAgentBridgeLoopbackServerApi`
- `ExternalAgentBridgePairingThrottleApi`、`FileContextCoordinatorApi`、`FileContextRegistryApi`、`GuidanceRelayKitApi`
- `InteractionPort`、`KernelBackgroundJobManagerApi`、`KernelBackgroundJobOutputStore`、`KernelSessionControllerApi`
- `KernelSessionInputStore`、`KernelSessionPolicyApi`、`KernelSessionRunCoordinatorApi`、`KernelToolOutputStore`
- `LedgerExecutionSpanScopeFactoryApi`、`McpAuthorizationProvider`、`McpClientConnectionApi`、`McpToolTranslatorApi`
- `PrimaryAgentProfileApi`、`PromptRegistryApi`、`ProviderRequestCompilerApi`、`ProviderTurnEventReducerApi`
- `ReminderCapabilityResolver`、`RemoteHostServicePorts`、`RetrievalPayloadStorePort`、`RetrievalStateStorePort`
- `RetryPolicyApi`、`RunnerConfigService`、`RunnerExecutionEnvironmentPort`、`RunnerModelRuntimePort`
- `RunnerSubAgentDispatcher`、`RunnerToolContextBuilder`、`RunnerToolRegistry`、`RuntimePromptFeaturePolicy`
- `RuntimeReminderProducer`、`RuntimeReminderSchedulerApi`、`SessionLedgerHandleApi`、`SessionLedgerLocator`
- `SessionStoreApi`、`SessionStoreDeps`、`SkillFileStoreApi`、`SkillMarketClientApi`
- `SoloExecutionServiceApi`、`SubAgentConfigPort`、`SubAgentDispatcherApi`、`SubAgentGuidanceRelayRegistryApi`
- `SubAgentQueryRunner`、`SubAgentSessionStoreApi`、`SubAgentTypeProvider`、`TaskApprovalStateApi`
- `TeamModelRouterApi`、`TeamModelRoutingPort`、`ToolActiveContextApi`、`ToolAllocationMetadata`
- `ToolCapabilityRegistryApi`、`ToolContractExecutionFacadeApi`、`ToolConversationContextApi`、`ToolExecutionApi`
- `ToolExecutionPolicyApi`、`ToolExecutorApi`、`ToolInputReuseStoreApi`、`ToolRegistryApi`
- `ToolResultMiddleware`、`ToolRoleApi`、`ToolRuntimeApi`、`ToolSkillsApi`
- `ToolTransportNamesApi`、`ToolValidationHintProvider`、`TurnContextAppendHubApi`、`TurnContextLedgerApi`
- `TurnContextSessionLedgersApi`、`TurnHistoryApi`、`VelarModArchiveImporterApi`、`VelarModArchiveSignatureVerifier`
- `WriteLeaseCoordinatorApi`

### 导出的值

共 126 个。`.` 带出全部；`./contracts` 只带 26 张常量表，`./chat` 7 个、`./tool-contract` 8 个各带自己那一撮。

- `AgentCapability`、`AgentCapabilityApiVersionString`、`AgentCapabilityEnvelopeLimits`、`AgentContextThresholds`
- `AgentEnvironmentVariables`、`AgentErrorCodes`、`AgentExecutionPermission`、`AgentFieldValues`
- `AgentIdentity`、`AgentKernelModuleId`、`AgentLeasePolicy`、`AgentModAxes`
- `AgentProtocolVersions`、`AgentSkillFailureCodes`、`AgentSkillFiles`、`AgentStepLimits`
- `AgentSurfaceLimits`、`AgentToolCategoryByName`、`AgentToolLimits`、`AgentToolNames`
- `AgentToolTransport`、`BuiltinAgentModId`、`ExternalAgentBridgeLimits`、`ExternalAgentBridgeProtocol`
- `McpLimits`、`PromptSegmentPriority`、`StreamRuntimeStateKinds`、`TurnContextFormat`
- `TurnContextProcessGeneration`、`VelarModArchiveFiles`、`VelarModArchiveLimits`、`agentChat`
- `agentLedgerFiles`、`agentModHost`、`agentRetryPolicy`、`agentRuntime`
- `agentSessionKit`、`agentToolContracts`、`agentTools`、`agentTurnHistory`
- `agentWire`、`assertSafeHttpFetchUrl`、`chatMessages`、`chatRuntimeEvents`
- `chatSearchMessages`、`chatSearchRanking`、`chatStreamProtocol`、`compileProviderSendRequest`
- `createAgentCapabilityEventPublisher`、`createAgentExecutionStack`、`createAgentGoalService`、`createAgentKernelModule`
- `createAgentModLoader`、`createAgentModSeamDispatcher`、`createAgentPlanService`、`createAgentQuestionService`
- `createAgentRoleEngine`、`createAgentSkillRepository`、`createAgentWorkflowRuntime`、`createBackgroundJobManager`
- `createBuiltInPromptRegistry`、`createBuiltinAgentModDefinition`、`createChatContextRetrievalService`、`createChatKernelSessionBridge`
- `createChatStreamConsumer`、`createChatStreamSessionLog`、`createCodingSessionTracker`、`createContextGovernanceSessionRegistry`
- `createContextPayloadRef`、`createContextUserTextRef`、`createExecutionEventBus`、`createExecutionGuidanceQueue`
- `createExecutionPlanLedger`、`createExecutionPlanState`、`createExecutionRouting`、`createExecutionService`
- `createExternalAgentBridgeCommandQueue`、`createExternalAgentBridgeEventWindow`、`createExternalAgentBridgeLoopbackServer`、`createExternalAgentBridgePairingThrottle`
- `createFileSkillProvider`、`createInMemoryContextPayloadStore`、`createJsonlContextMigrationEventSink`、`createLedgerExecutionSpanScopeFactory`
- `createMcpClientConnection`、`createNoopExecutionEventBus`、`createPrimaryAgentProfile`、`createPromptRegistry`
- `createProviderRequestCompiler`、`createSessionLedger`、`createSessionStore`、`createSkillFileStore`
- `createSkillMarketClient`、`createSoloExecutionService`、`createSubAgentDispatcher`、`createSubAgentGuidanceRelayRegistry`
- `createSubAgentSessionStore`、`createTeamModelRouter`、`createToolCapabilityRegistry`、`createToolContractExecutionFacade`
- `createToolExecutionPolicy`、`createToolExecutor`、`createToolRegistry`、`createTurnContextAppendHub`
- `createTurnContextSessionLedgers`、`createUnattendedSubAgentApprovalPort`、`createVelarModArchiveImporter`、`createWriteLeaseCoordinator`
- `defaultDenyApprovalPort`、`defaultUnsupportedInteractionPort`、`directiveOperations`、`externalAgentBridgeTokensEqual`
- `fileContextRegistry`、`formatSkillDisplayMarkdown`、`guidanceRelay`、`mcpToolTranslator`
- `parseFrontmatter`、`parseFrontmatterList`、`readPromptAuditFile`、`resolveSubAgentExecutionKey`
- `resolveToolInputReuse`、`runRemoteNodeMcpStdio`、`safeFetch`、`toolInputReuseStore`
- `toolTransportNames`、`withToolInputReuse`

## 模型面工具

16 个工具定义全在 `src/impl/AgentTools.ts`（INV-17），按四个类别分组：

| 类别 | 工具 |
| --- | --- |
| agent-control | `tooling:map`、`tooling:read`、`tooling:replace`、`agent:dispatch`、`agent:run_workflow`、`job:read_output`、`job:wait` |
| context | `context:recall`、`context:handoff`、`directive:list`、`directive:upsert`、`directive:archive` |
| planning | `goal:create`、`goal:update`、`plan:update` |
| interaction | `interaction:confirm` |

工具名与类别的闭集在 `AgentToolNames` / `AgentToolCategoryByName`；`agentTools` 是按名索引的单源，
内置 mod 的清单由它派生，不另立一份名单（INV-4、INV-5）。
`execute` 只写一两步，实现交给 `impl/builtin/` 的执行类。

## 骨干链路

工具定义全在 `AgentTools.ts`，`execute` 只写一两步，实现交给 `impl/builtin/` 的执行类。
每个工具的链路：

- `tooling:map` / `tooling:read` / `tooling:replace`：工具空间总览、读一条工具的完整说明、整体换入某几个类别；
  三条都经 `ToolRegistry` 的可见性投影，换入换出的最小单位是类别。
- `context:recall`：`ContextOperations` → `ChatContextRetrievalService`（索引 → 打分 → 载荷读取），
  按句柄取回被折叠过的原文。
- `context:handoff`：`ContextOperations` 的守卫 → 交出转交简报，由产品开新会话继续。
- `directive:list` / `directive:upsert` / `directive:archive`：`directiveOperations` 读写活动上下文里的
  长期指令产物，条数上限在 `AgentToolLimits`。
- `goal:create` / `goal:update`：`GoalOperations` 写目标产物并投影成界面的目标停靠区；
  不传字段的 `goal:update` 就是一次读取。
- `plan:update`：`PlanOperations` 同时写界面计划与活动上下文里的落盘条目；不传字段即读取。
- `agent:dispatch`：入参折成派发请求 → `SubAgentDispatcher`（并发闸、类型路由、模型路由、写租约）→ `QueryLoop`；
  `interrupt` 走同一条中断路径。
- `agent:run_workflow`：`AgentWorkflowRuntime` 解释声明式 IR，逐步派发子 Agent 并收敛。
- `job:read_output` / `job:wait`：`BackgroundJobOperations` → `KernelBackgroundJobManager` 读异步派发的输出与终态。
- `interaction:confirm`：经注入的 `ApprovalPort` 向用户要一次确认；没注入就按默认拒绝收尾。

- **一次主会话回合**：宿主经 `createChatKernelSessionBridge(...)` 或 `createSoloExecutionService(...)`
  进 `ExecutionService`（会话互斥、待输入、待确认、持久化）→ `AgentRunner` → `SoloStreamLoop`
  → `TurnRunner` → `StreamTurn`（`ProviderRequestCompiler` 编译请求 → `AiSdkAgentModelRequestPort` 发送
  → `StreamConsumer` 消费）→ 工具调用进 `ToolExecutor`（可用性 → 参数校验 → `ToolExecutionPolicy` 审批
  → 执行 → 结果中间件）→ 结果进驻留账本 → 下一轮。
- **装一套执行栈**：`createAgentExecutionStack(options)`；给了 `query` 配置就多出子 Agent 查询面与
  `createRunner`。提示词目录、治理登记处、执行上限都从选项进，缺省由栈自己建一份独占的。
- **上下文治理**：请求超过可用输入容量才动手（`AgentContextThresholds.compactionPercent`），
  界面提醒线只提示不压缩（INV-11）。治理状态挂在 `ContextGovernanceSessionRegistry` 的每会话账本上，
  账本只追加；投影按驻留态生成，纪元不匹配的旧结果一律拒收。
- **工具执行**：唯一路径是 `ToolExecutor`。没注入审批端口时 `defaultDenyApprovalPort` 一律拒（INV-1）；
  无人值守宿主用 `createUnattendedSubAgentApprovalPort` 按显式策略升级（INV-2）。
  投给模型的结果有硬上限，超限截断但原文可经 `context:recall` 取回（INV-10）。
- **子 Agent 与工作流**：工具 `agent:dispatch` → `SubAgentDispatcher`（并发闸、类型路由、模型路由、写租约）
  → `QueryLoop`；异步派发登记成后台任务，完成后经会话通道回灌。
  `agent:run_workflow` 走 `AgentWorkflowRuntime` 的声明式 IR。
- **能力注入**：领域能力只经 `AgentRuntimeCapabilityPorts` 进来——结果中间件、校验提示、分配元数据、
  提示词贡献者、上下文收集器、意图分类器、验证解释器、作用域策略、委派策略、工具别名。
- **mod 两级注册机**：Kernel 报上来的 pack 经 `agentModHost.discoverAgentModPackages` 折成候选包，
  再与随包官方 mod 一起交 `AgentModLoader` 注册。贡献轴是闭集，集合外的轴与撞名的工具一律拒载并留诊断（INV-6、INV-7）。

## 依赖什么

- `@velaros-ai/core`：日志、断言式类型判定、错误、计时器作用域。
- `@velaros-ai/kernel`：作为内核模块挂进宿主（`createAgentKernelModule`）、远程能力节点客户端。
- `@velaros-ai/tool-contract`：写工具的通用件（定义、说明渲染、schema、宽容入参、身份）。
- `ai`：模型请求的 provider 适配；`zod`：wire 与工具入参的运行期校验（schema 不出包）。
- `@modelcontextprotocol/sdk`、`ws`、`jszip`、`gpt-tokenizer`：MCP 连接、远程节点、`.velarmod` 归档、分词。

Agent **不依赖任何空间包**：依赖方向单向，空间包引 Agent，Agent 不引它们。

## 状态归谁

- 一次执行的所有权、会话互斥、待输入与待确认：`ExecutionService` 持有，落盘经宿主注入的路径端口。
- 每会话的驻留账本、压缩进度与纪元：`ContextGovernanceSessionRegistry`。
- 会话工作态（可见工具类别、提示词特性、本轮改动、审批账本）：`CodingSessionTracker`，每会话一份。
- 载荷句柄：`ContextPayloadStore`，宿主不注入持久实现就只活在内存里。
- 子 Agent 线程、写租约、后台任务：`SubAgentSessionStore`、`WriteLeaseCoordinator`、`KernelBackgroundJobManager`。
- 会话树、span 与提示词审计：`SessionStore`、`ExecutionSpanLedger`、`PromptAuditLedger`，落在宿主给的目录下。
- 回合上下文：`TurnContextSessionLedgers` 按会话分档，账本换代后旧 cursor 整段替换（INV-12）。

进程级可变状态只有两处：`agentRuntime.configureHostFacts` 登记的宿主运行事实、
`toolInputReuseStore` 的 schema 弱引用登记表。其余状态都挂在实例上。

## 生命周期

- 执行栈：建好即可用，`clearSession(sessionId)` 释放一个会话在栈里的全部驻留。
- 一次执行：`queued → running →（awaiting-input / awaiting-confirmation）→ done | aborted | error`；
  终态只发一次，后续同一执行的状态一律忽略（`StreamRuntimeStateKinds.terminal`）。
- 一次回合：请求编译 → 发送 → 流消费 → 工具执行 → 结果回灌；中止时 pending 的工具调用按
  「被打断」收尾，不伪造结果。
- mod：`validate → resolve → activate`，内置与外部走同一条管线；替换一代 mod 不影响在跑的执行。

## 失败语义

错误类不出包，外面一律**按码判断**，`message` 只给人看。码表在 `contract/constants.ts`：

| 码表 | 谁抛 | 典型码 |
| --- | --- | --- |
| `AgentErrorCodes` | 回合、工具链、mod、会话租约 | `AGENT_CONTEXT_EPOCH_STALE`、`AGENT_SESSION_LEASE_CONFLICT`、`AGENT_TOOL_INPUT_REUSE_INVALID` |
| `AgentSkillFailureCodes` | 技能文件与技能市场 | `skill-market-entry-missing`、`skill-frontmatter-name-missing` |

工具自身失败不抛：折成结果信封回给模型，由模型决定下一步。审批被拒也不算异常，
执行器记一次跳过、任务继续。上下文溢出分两档——可重放的走降级阶梯重试，
本轮已有可见输出或工具副作用的原样上抛（重放会重复副作用）。

## 不变量

共 22 条，登记在 `spec/invariants.md`：测试 15 条（`spec/acceptance.test.ts`）、门禁 6 条、类型 1 条，
未验证 0 条。

## 非目标

- 不认识任何具体能力：Agent 里不许出现文件、浏览器、记忆、项目这些域词。
- 不做会话权威：会话住在产品的 renderer 里，Agent 只回答一次次执行。
- 不做模型供应方适配：provider 的差异由 `@velaros-ai/model` 与注入的模型端口负责。
- 不做工具定义的通用基建：那在 `@velaros-ai/tool-contract`。
- 不做界面：目标停靠区、容量条、搜索结果的形状由 `./chat` 给数据，画由产品画。

## 结构

```text
packages/agent/
  MODULE.md                       本卡片
  spec/  invariants.md  acceptance.test.ts
  test/                           实现测试（119 个文件）
  src/
    contract/  provides.ts  requires.ts  constants.ts
    types/     agent.ts（可移植）+ 21 个按域的类型文件
    impl/      AgentTools.ts + 19 个域子目录（202 个文件）
    utils/     tuning.ts  capabilities.ts + 22 个域子目录（306 个文件）
    index.ts               `.` 入口，只转发
    contracts.ts           `./contracts` 入口，只转发
    chat.ts                `./chat` 入口，只转发
    tool-contract.ts       `./tool-contract` 入口，只转发
```

分层（登记在 `scripts/ownership/governed-modules.mjs` 的 `layers`，上层可以引下层，下层不许引上层）：

| 层 | 目录 | 说明 |
| --- | --- | --- |
| 1 工具 | `AgentTools.ts` | 16 个工具的定义、分组、内置 mod 与 mod 宿主组装器实例 |
| 2 工具执行 | `builtin/` | 各组工具的 execute 交给的类，只经工具上下文调宿主 |
| 3 装配 | `assembly/` | 执行栈、Kernel 模块、mod 宿主组装、会话通道、控制器、工具契约门面 |
| 4 执行服务 | `execution/`、`product-session/` | 一次 run 的所有权与生命周期；产品 Session 应用服务 |
| 5 委派 | `delegation/` | 子 Agent 派发、线程存储、团队路由与写租约 |
| 6 运行 | `runner/` | Runner、模型运行时、提示词组装、角色、工作流解释器 |
| 7 回合 | `loop/` | 主会话/子 Agent 循环、回合、请求组装、流消费、重试、纪元与前缀守卫 |
| 8 会话态与工具链 | `session/`、`tools/` | 会话工作态、审批、提醒；工具执行、策略、注册表、输出句柄化 |
| 9 上下文 | `context/`、`residency/`、`retrieval/` | 请求编译、驻留账本与治理、召回 |
| 10 基础能力 | `guidance/`、`mods/`、`connectors/`、`chat/` | 提示词段与技能、mod 注册机、MCP/远程/外部桥/安全取网、渲染侧聊天流 |
| 11 执行记录 | `records/` | 执行记录、账本、事件总线、回合事件归约、后台任务、回合上下文账本 |
| 12 落盘账本 | `ledgers/` | 会话树账本、span 账本、提示词审计 |
| 13 错误类 | `errors/` | 7 个错误类，不出包 |

utils 在所有层之下，只引 utils、types 与合同。
