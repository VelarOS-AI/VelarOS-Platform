/**
 * 产品面：本包交给外面的整件能力。类实现的 API 定义在各自的类上方（`impl/` 里，接口紧挨着类），这里登记并转发；
 * 没有类的公开接口直接声明在这里。这里的每个接口都必须从根入口导出。
 */

import type { PromptRegistryContract } from '../types/guidance.js'
import type { ExecuteQueryLoopArgs, ExecuteSoloModeStreamLoopArgs, SoloModeStreamLoopResult } from '../types/loop.js'
import type { ExecutionEventBusContract } from '../types/records.js'
import type { ContextGovernanceSessionRegistryContract } from '../types/residency.js'
import type { AgentExecutionStackRunnerOptions, AgentExecutionStackToolContext, AgentRunnerContract } from '../types/runner.js'

// ── 执行栈：类实现在 impl/assembly/AgentExecutionStack.ts ──────────────

/**
 * 默认执行栈的 Solo 面：产品注入模型端口、工具登记处与几项策略，包内把上下文构建、回合执行与
 * Solo 流式循环配成一套，宿主拿到的就是这份栈。一份栈绑定一份工具面，工具面整体换掉要另建一份栈；
 * 状态只有各会话在 Solo 循环与治理登记处里的驻留，栈本身不持有业务数据。
 */
export interface AgentExecutionStackApi<TContext extends AgentExecutionStackToolContext> {
  /**
   * 本栈实际使用的提示词目录：建栈时没给就是包内置的那一份。
   * 宿主要读或扩提示词段一律从这里取；另建一份会让栈里跑的和宿主看到的系统提示对不上。
   */
  readonly promptRegistry: PromptRegistryContract
  /**
   * 上下文治理的会话登记处：每个会话的驻留账本、压缩进度与 epoch 状态都挂在它身上。
   * 缺省是本栈独占的一份；宿主想让多份栈共享同一批会话生命周期，就在建栈时注入同一个实例。
   */
  readonly governanceSessions: ContextGovernanceSessionRegistryContract
  /**
   * 跑一轮 Solo（主 Agent 流式）执行：入参带本轮历史、运行配置与事件总线，
   * 返回这轮的收敛结果（结束原因、最终历史等）。模型或工具层的失败按 AppError 往外抛，栈不吞。
   */
  executeSolo(
    args: ExecuteSoloModeStreamLoopArgs<TContext, ExecutionEventBusContract>
  ): Promise<SoloModeStreamLoopResult>
  /**
   * 释放一个会话在本栈里的全部驻留：Solo 循环的会话状态与治理账本一起作废。
   * 删除或整体替换宿主会话时调用；对没见过的 `sessionId` 是无操作，不报错。
   */
  clearSession(sessionId: string): void
}

/**
 * 建栈时给了 `query` 配置（角色引擎 + 工具类别解析）的执行栈：Solo 面之外多出子 Agent 查询面与 Runner 装配。
 * 只跑 Solo 的宿主拿到的是 {@link AgentExecutionStackApi}，那种栈上这两个成员一调就抛 `INVALID_STATE`。
 */
export interface AgentExecutionStackWithQueryApi<
  TContext extends AgentExecutionStackToolContext,
> extends AgentExecutionStackApi<TContext> {
  /**
   * 跑一轮 Query（子 Agent / 委派）执行，返回子 Agent 收敛后的最终文本答复。
   * 由派发器与工作流派发点调用；建栈时没配 `query` 的栈调用它会抛 `INVALID_STATE`。
   */
  executeQuery(args: ExecuteQueryLoopArgs<TContext, ExecutionEventBusContract>): Promise<string>
  /**
   * 装配一个 AgentRunner：栈里已经配好的工具登记处、执行上限与提示词特性策略，
   * 与宿主给的上下文构建器、主 Agent 画像、子 Agent 派发器合成一台 Runner，并把它回绑到
   * `options.subAgentDispatcher`（派发子 Agent 要用 Runner 的 query）。一般每个宿主会话建一台。
   */
  createRunner(options: AgentExecutionStackRunnerOptions<TContext>): AgentRunnerContract<TContext>
}

// ── 登记：类实现的 API（接口写在各自的类上方，这里只登记并转发） ─────────

// 装配与执行
export type { AgentModHostAssemblerApi } from '../impl/assembly/AgentModHostAssembler.js'
export type { ChatKernelSessionBridgeApi } from '../impl/assembly/ChatKernelSessionBridge.js'
export type { KernelSessionControllerApi } from '../impl/assembly/KernelSessionController.js'
export type { ToolContractExecutionFacadeApi } from '../impl/assembly/ToolContractExecutionFacade.js'
export type { AgentCapabilityEventPublisherApi } from '../impl/execution/AgentCapabilityEventPublisher.js'
export type { ExecutionServiceApi } from '../impl/execution/ExecutionService.js'
export type { KernelSessionPolicyApi } from '../impl/execution/KernelSessionPolicy.js'
export type { KernelSessionRunCoordinatorApi } from '../impl/execution/KernelSessionRunCoordinator.js'
export type { SoloExecutionServiceApi } from '../impl/execution/SoloExecutionService.js'

// 委派与团队
export type { SubAgentDispatcherApi } from '../impl/delegation/SubAgentDispatcher.js'
export type { SubAgentSessionStoreApi } from '../impl/delegation/SubAgentSessionStore.js'
export type { TeamModelRouterApi } from '../impl/delegation/TeamModelRouter.js'
export type { WriteLeaseCoordinatorApi } from '../impl/delegation/WriteLeaseCoordinator.js'

// 运行与会话态
export type { RetryPolicyApi } from '../impl/loop/RetryPolicy.js'
export type { AgentRoleEngineApi } from '../impl/runner/AgentRoleEngine.js'
export type { AgentRunnerApi } from '../impl/runner/AgentRunner.js'
export type { AgentRuntimeKitApi } from '../impl/runner/AgentRuntimeKit.js'
export type { AgentWorkflowRuntimeApi } from '../impl/runner/AgentWorkflowRuntime.js'
export type { PrimaryAgentProfileApi } from '../impl/runner/PrimaryAgentProfile.js'
export type { CodingSessionTrackerApi } from '../impl/session/CodingSessionTracker.js'
export type { RuntimeReminderSchedulerApi } from '../impl/session/RuntimeReminderScheduler.js'
export type { TaskApprovalStateApi } from '../impl/session/TaskApprovalState.js'

// 上下文、治理与召回
export type { FileContextCoordinatorApi } from '../impl/context/FileContextCoordinator.js'
export type { FileContextRegistryApi } from '../impl/context/FileContextRegistry.js'
export type { ProviderRequestCompilerApi } from '../impl/context/ProviderRequestCompiler.js'
export type { ContextGovernanceSessionRegistryApi } from '../impl/residency/ContextGovernanceSessionRegistry.js'
export type { ChatContextRetrievalServiceApi } from '../impl/retrieval/ChatContextRetrievalService.js'
export type { ChatSearchMessagesApi } from '../impl/retrieval/ChatSearchMessages.js'
export type { ChatSearchRankingApi } from '../impl/retrieval/ChatSearchRanking.js'
export type { ContextRetrievalQueryTraceStoreApi } from '../impl/retrieval/ContextRetrievalQueryTraceStore.js'

// 工具面
export type { DirectiveOperationsApi } from '../impl/builtin/DirectiveOperations.js'
export type { AgentToolContractsApi } from '../impl/tools/AgentToolContracts.js'
export type { ToolCapabilityRegistryApi } from '../impl/tools/ToolCapabilityRegistry.js'
export type { ToolExecutionPolicyApi } from '../impl/tools/ToolExecutionPolicy.js'
export type { ToolExecutorApi } from '../impl/tools/ToolExecutor.js'
export type { ToolInputReuseStoreApi } from '../impl/tools/ToolInputReuseStore.js'
export type { ToolRegistryApi } from '../impl/tools/ToolRegistry.js'
export type { ToolTransportNamesApi } from '../impl/tools/ToolTransportNames.js'

// 提示词、技能与 mod
export type { AgentSkillRepositoryApi } from '../impl/guidance/AgentSkillRepository.js'
export type { PromptRegistryApi } from '../impl/guidance/PromptRegistry.js'
export type { SkillFileStoreApi } from '../impl/guidance/SkillFileStore.js'
export type { SkillMarketClientApi } from '../impl/guidance/SkillMarketClient.js'
export type { AgentModLoaderApi } from '../impl/mods/AgentModLoader.js'
export type { AgentModRegistryApi } from '../impl/mods/AgentModRegistry.js'
export type { AgentModSeamDispatcherApi } from '../impl/mods/AgentModSeamDispatcher.js'
export type { VelarModArchiveImporterApi } from '../impl/mods/VelarModArchiveImporter.js'

// 连接器
export type { ExternalAgentBridgeCommandQueueApi } from '../impl/connectors/ExternalAgentBridgeCommandQueue.js'
export type { ExternalAgentBridgeEventWindowApi } from '../impl/connectors/ExternalAgentBridgeEventWindow.js'
export type { ExternalAgentBridgeLoopbackServerApi } from '../impl/connectors/ExternalAgentBridgeLoopbackServer.js'
export type { ExternalAgentBridgePairingThrottleApi } from '../impl/connectors/ExternalAgentBridgePairingThrottle.js'
export type { McpClientConnectionApi } from '../impl/connectors/McpClientConnection.js'
export type { McpToolTranslatorApi } from '../impl/connectors/McpToolTranslator.js'

// 执行记录与账本
export type { AgentLedgerFilesApi } from '../impl/ledgers/AgentLedgerFiles.js'
export type { LedgerExecutionSpanScopeFactoryApi } from '../impl/ledgers/LedgerExecutionSpanScopeFactory.js'
export type { SessionLedgerHandleApi } from '../impl/ledgers/SessionLedger.js'
export type { SessionStoreApi } from '../impl/ledgers/SessionStore.js'
export type { ChatRuntimeEventsApi } from '../impl/records/ChatRuntimeEvents.js'
export type { ExecPlanLedgerApi } from '../impl/records/ExecPlanLedger.js'
export type { ExecPlanStateApi } from '../impl/records/ExecPlanState.js'
export type { ExecRoutingApi } from '../impl/records/ExecRouting.js'
export type { ExecutionEventBusApi } from '../impl/records/ExecutionEventBus.js'
export type { ExecutionGuidanceQueueApi } from '../impl/records/ExecutionGuidanceQueue.js'
export type { ExecutionStoreApi } from '../impl/records/ExecutionStore.js'
export type { GuidanceRelayKitApi } from '../impl/records/GuidanceRelayKit.js'
export type { KernelBackgroundJobManagerApi } from '../impl/records/KernelBackgroundJobManager.js'
export type { ProviderTurnEventReducerApi } from '../impl/records/ProviderTurnEventReducer.js'
export type { SubAgentGuidanceRelayRegistryApi } from '../impl/records/SubAgentGuidanceRelayRegistry.js'
export type { TurnContextAppendHubApi } from '../impl/records/TurnContextAppendHub.js'
export type { TurnContextLedgerApi } from '../impl/records/TurnContextLedger.js'
export type { TurnContextSessionLedgersApi } from '../impl/records/TurnContextSessionLedgers.js'
export type { TurnHistoryApi } from '../impl/records/TurnHistory.js'

// 产品会话
export type { AgentGoalServiceApi } from '../impl/product-session/AgentGoalService.js'
export type { AgentPlanServiceApi } from '../impl/product-session/AgentPlanService.js'
export type { AgentQuestionServiceApi } from '../impl/product-session/AgentQuestionService.js'
export type { AgentSessionKitApi } from '../impl/product-session/AgentSessionKit.js'

// 渲染侧
export type { AgentChatKitApi } from '../impl/chat/AgentChatKit.js'
export type { AgentWireApi } from '../impl/chat/AgentWire.js'
export type { ChatMessagesApi } from '../impl/chat/ChatMessages.js'
export type { ChatStreamConsumerApi } from '../impl/chat/ChatStreamConsumer.js'
export type { ChatStreamProtocolApi } from '../impl/chat/ChatStreamProtocol.js'
export type { ChatStreamSessionLogApi } from '../impl/chat/ChatStreamSessionLog.js'
