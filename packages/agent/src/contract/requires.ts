
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { LanguageModel, ModelMessage } from 'ai'

import type { ScopedLog } from '@velaros-ai/core/logger'
import type {
  RemoteNodeClientCredentialStore,
} from '@velaros-ai/kernel'
import type {
  KernelModuleHealth,
  ScopeRef,
} from '@velaros-ai/kernel/contracts'

import type { ActiveContextArchiveFilter, ActiveContextArtifact, ActiveContextGovernanceOptions, ActiveContextGovernanceReport, ActiveContextListOptions, ActiveContextUpsertInput, AgentDeveloperContext, AgentRoleId, AgentSkillDescriptor, AgentSkillSourceKind, AgentSurfaceId, AppLocale, ApprovalDecision, CapabilityScopeId, ChatContextReadEvidenceRequest, ChatContextReadEvidenceResult, ChatContextReadToolPayloadRequest, ChatContextRetrievedPayload, ChatContextRetrievePayloadRequest, ChatContextSearchConversationHistoryRequest, ChatContextSearchConversationHistoryResult, ChatContextSearchTerminalOutputRequest, ChatContextSearchTerminalOutputResult, ChatMessage, ChatPromptFeatureId, ChatSessionPayloadSnapshot, ChatSessionToolResultPayload, CustomSubAgentDefinition, CustomSubAgentDescriptor, ExecutionModeId, ExecutionTaskExecutionAdvice, ExecutionTaskPlanStep, ExecutionTaskRecommendedAction, ExecutionTaskRecord, PermissionConfirmationMode, PromptSegmentOverride, ReasoningLevel, RunProfileSelectionId, SessionLineageContext, SubAgentTypeId,ThinkingDepth, ToolCategoryId, ToolConfirmationDecisionOptions, ToolExecutionPlanUpdate, ToolSurfaceProfileId } from '../types/agent.js'
import type { AgentRuntimeCapabilityExtension,CapabilityIntentClassifierContext, CapabilityIntentSignal, CapabilityScopeCategoryDecision, CapabilityScopeResidency, CapabilityScopeRuntimeFacts, CapabilityValidationInterpretation, ToolAllocationDelegation, ToolAllocationPrerequisite, ToolResultMiddlewareContext, ToolResultMiddlewareResult, ToolValidationHintContext, ToolValidationRecovery } from '../types/capabilities.js'
import type { RemoteHostToolEntry } from '../types/connectors.js'
import type { ContextPayloadRecord, ContextUserTextRecord } from '../types/context.js'
import type { SubAgentDispatchCatalog, SubAgentDispatchInput, SubAgentDispatchLimitsSnapshot, SubAgentQueryOptions, SubAgentToolContext, SubAgentTypeDescriptor,TeamModelRouteRequest, TeamModelRouteResult, TeamSelectableModel } from '../types/delegation.js'
import type { AdmitKernelSessionInput, AgentCapabilityExecutionContext, ExecutionCollaborationActorHandle, ExecutionCollaborationActorInput, ExecutionGuidanceRelayPlan, ExecutionGuidanceRelayPlanInput, KernelAdmittedInput, KernelSessionInputStoreResult, PromoteKernelInputOptions } from '../types/execution.js'
import type { AgentSkillDefinition, PromptSegmentDefinition } from '../types/guidance.js'
import type { RunSpanScope,SessionLedgerWarn } from '../types/ledgers.js'
import type { AgentTurnCapabilitySnapshot,QueryLoopToolRegistry, ResolvedAgentModelRuntime, SoloLoopToolRegistry, TurnRunnerToolRegistry } from '../types/loop.js'
import type { AgentModBindings, AgentModPackDescriptorLike, VelarModArchiveEntry } from '../types/mods.js'
import type { AgentSessionApplicationEvent } from '../types/product-session.js'
import type { ExecutionEventBusContract, ExecutionResourceProvider, KernelBackgroundJobStoredOutput } from '../types/records.js'
import type { ContextFaultEvent,ContextGovernanceConfigInput, ContextResidencyMigrationEvent } from '../types/residency.js'
import type { AgentExecutionStackToolContext, AgentRoleDefinition, AgentRoleDescriptorProviderContext, AgentRuntimeInputResult,AgentSurfaceProfile, AgentTurnBoundary, AgentTurnSettlement, DerivedAgentSurfaceRunPolicy, DeriveSurfaceRunPolicyInput, ResolveAgentSurfaceInput, RunnerBuildToolContextArgs, RunnerExecutionScope, RunnerModelCapabilityPort, RunnerToolContext } from '../types/runner.js'
import type { ReminderScope, ReminderTrigger, RuntimeReminderInput } from '../types/session.js'
import type { ToolConversationHandoffRequest, ToolConversationHandoffResult, ToolRoleSkillReadResult } from '../types/tool-context.js'
import type { ProjectKernelToolOutputInput, ProjectKernelToolOutputResult } from '../types/tools.js'

/**
 * 会话在产品目录里的生命周期状态。跨产品不变量，产品不得自造第五种取值。
 *
 * `idle` = 没有执行在跑；`running` = 有执行占用；`interrupted` = 被用户或宿主中止；
 * `failed` = 执行以错误收尾。落盘/上线协议用 `AgentSessionLifecycleStatusSchema` 校验。
 */
export type AgentSessionLifecycleStatus = 'idle' | 'running' | 'interrupted' | 'failed'

/**
 * 后台 Agent 进程的状态机取值。
 *
 * `starting` → `running` 是活动态；`completed` / `failed` / `stopped` / `interrupted`
 * 四个是终态（判定用 `isTerminalAgentBackgroundState`，别在宿主再抄一份名单）。
 */
export type AgentBackgroundAgentState = 'running' | 'interrupted' | 'failed' | 'starting' | 'completed' | 'stopped'

/**
 * Agent 产品公共的 Session catalog 投影。kind 与 productData 是开放产品轴；Platform
 * 只拥有身份、谱系、生命周期、归档和时间戳这些跨产品不变量。
 */
export interface AgentSessionMetadata<TProductData = unknown> {
  /** 会话主键，由宿主生成并保证全局唯一；本包所有按会话寻址的端口都用它当 key。 */
  readonly id: string
  /** 会话的展示标题，宿主填（通常取首条用户消息或用户手动重命名），本包只透传不解析。 */
  readonly title: string
  /** 产品自定义的会话种类（如 chat / task / hook），Platform 不认识取值，只当不透明标签存取与过滤。 */
  readonly kind: string
  /** 派生来源会话 id；顶层会话填 null。宿主据此拼会话树，本包不校验父子是否成环。 */
  readonly parentSessionId: Nullable<string>
  /** 当前生命周期状态；执行开始/结束时由宿主改写，读取方据此判断能否再次发起执行。 */
  readonly status: AgentSessionLifecycleStatus
  /** 会话创建时刻（毫秒 epoch），宿主用自己的时钟填，创建后不再改。 */
  readonly createdAt: number
  /** 最近一次写入时刻（毫秒 epoch）；每次 create/archive/restore 及产品侧改写都要刷新，列表按它排序。 */
  readonly updatedAt: number
  /** 归档时刻（毫秒 epoch）；未归档填 null。它同时就是「是否归档」的判据，别另加布尔位。 */
  readonly archivedAt: Nullable<number>
  /** 产品私有载荷（资源根路径、模型选择等）。Platform 原样存取、不解析、不合并。 */
  readonly productData: TProductData
}

/** 新建会话的入参。只有 `kind` 与 `productData` 必填，其余缺省由宿主补齐。 */
export interface CreateAgentSessionMetadataInput<TProductData = unknown> {
  /** 调用方指定的会话 id；省略时由宿主生成。传了就要保证不与既有会话撞号。 */
  readonly id?: string
  /** 初始标题；省略时宿主自行兜底（空串或默认名），本包不规定文案。 */
  readonly title?: string
  /** 产品自定义的会话种类，必填；宿主原样落库。 */
  readonly kind: string
  /** 派生来源会话 id；派生会话（子任务、分支）填它，顶层会话省略。 */
  readonly parentSessionId?: LooseOptional<string>
  /** 产品私有载荷，必填（没有就传空对象）；宿主原样落库，本包不检查形状。 */
  readonly productData: TProductData
}

/** 列会话的查询条件。两项都省略 = 只要未归档的会话、条数走宿主默认上限。 */
export interface AgentSessionCatalogQuery {
  /** 是否把已归档会话也列出来；缺省 false，即归档会话默认不出现在列表里。 */
  readonly includeArchived?: boolean
  /** 返回条数上限；宿主应经 `normalizeAgentSessionListLimit` 钳到 1–1000（缺省 100），不要直接信调用方的数。 */
  readonly limit?: number
}

/** 产品持久化实现（SQLite/文件/Cloud）必须适配的公共 Session application port。 */
export interface AgentSessionCatalogPort<TSession extends AgentSessionMetadata = AgentSessionMetadata> {
  /** 建一条会话并返回落库后的完整投影（id / 时间戳已补齐）；id 撞号或存储写失败时抛错。 */
  create(input: CreateAgentSessionMetadataInput<TSession['productData']>): Promise<TSession> | TSession
  /** 按 id 取会话；不存在返回 null 而不是抛错，调用方据此区分「没有」与「读盘坏了」。 */
  get(id: string): Promise<Nullable<TSession>> | Nullable<TSession>
  /** 列会话，按 `updatedAt` 倒序；无匹配返回空数组。查询条件见 {@link AgentSessionCatalogQuery}。 */
  list(query?: AgentSessionCatalogQuery): Promise<readonly TSession[]> | readonly TSession[]
  /** 归档一条会话（写 `archivedAt`）并返回新投影；会话不存在时抛错。归档是软删除，数据仍在。 */
  archive(id: string): Promise<TSession> | TSession
  /** 取消归档（清 `archivedAt`）并返回新投影；会话不存在时抛错。 */
  restore(id: string): Promise<TSession> | TSession
}

/** 会话执行租约：同一会话同一时刻只许一个进程持有，防多开进程同时跑同一条会话。 */
export interface AgentSessionLease {
  /** 这条租约管的是哪条会话；宿主按它做互斥，同一 sessionId 同时只许有一个持有者。 */
  readonly sessionId: string
  /** 持有者标识（由抢占方自己生成，通常是窗口/运行时实例 id）；续约与释放都要用同一个值才认。 */
  readonly ownerId: string
  /** 持有者的 OS 进程号；接任者用它探活——旧持有者进程已死就允许接管，见 `resolveAgentSessionLeaseClaim`。 */
  readonly ownerPid: number
  /** 本次获得租约的时刻（毫秒 epoch）；接管时重置，不是首次创建时刻。 */
  readonly acquiredAt: number
  /** 最近一次心跳时刻（毫秒 epoch）；宿主可据此判断持有者是否僵死。 */
  readonly heartbeatAt: number
}

/** 抢占会话租约的请求；由 `resolveAgentSessionLeaseClaim` 在存储事务内裁决成不成。 */
export interface AgentSessionLeaseClaim {
  /** 要抢占哪条会话的执行权；空串会被裁决函数直接拒。 */
  readonly sessionId: string
  /** 抢占方标识；与既有租约的 ownerId 相同 = 续约自己的，不同才进入探活判定。空串会被拒。 */
  readonly ownerId: string
  /** 抢占方的 OS 进程号，必须是正整数；冲突时它会写进 `AgentSessionLeaseConflictError` 的提示给用户看。 */
  readonly ownerPid: number
}

/**
 * 会话租约端口。宿主在自己的存储事务内原子读写，Platform 不探测进程也不持有租约。
 *
 * 裁决逻辑走包内 `resolveAgentSessionLeaseClaim`，宿主只负责「原子地读当前租约 → 调裁决 → 写回」。
 */
export interface AgentSessionLeasePort {
  /** 读当前租约；没人持有返回 null。只读，不做过期回收。 */
  get(sessionId: string): Promise<Nullable<AgentSessionLease>> | Nullable<AgentSessionLease>
  /** 抢占租约并返回新租约；持有者是别人且其进程仍活着时抛 `AgentSessionLeaseConflictError`，调用方据此提示用户去另一个进程操作。 */
  claim(input: AgentSessionLeaseClaim): Promise<AgentSessionLease> | AgentSessionLease
  /** 续约（刷新 `heartbeatAt`）并返回新租约；执行期间周期性调用。ownerId 对不上或租约已不存在时抛错。 */
  heartbeat(sessionId: string, ownerId: string): Promise<AgentSessionLease> | AgentSessionLease
  /** 释放租约；ownerId 对不上应当无声跳过（别把别人的租约删了），已释放再调也不算错。 */
  release(sessionId: string, ownerId: string): Promise<void> | void
}

/** 会话关联的外部资源引用（打开的文件、页面、设备等）。Platform 只透传，不解析 uri。 */
export interface AgentSessionResourceReference {
  /** 这条引用在会话内的稳定标识，宿主生成；重复登记同一资源应复用同一个 id。 */
  readonly id: string
  /** 产品自定义的资源种类（file / page / device…）；本包不认识取值，宿主按它分派处理。 */
  readonly kind: string
  /** 资源定位串，形状由 `kind` 决定（文件路径、URL、设备句柄…）；本包不解析也不校验可达性。 */
  readonly uri: string
  /** 宿主附带的额外属性（标题、大小、只读位等）；本包原样透传，缺省表示没有额外信息。 */
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** 后台 Agent 的一条运行记录：谁在跑、归属哪条会话、现在什么状态、怎么收的尾。 */
export interface AgentBackgroundAgent {
  /** 后台 Agent 记录的主键，宿主生成；`get` / `markRunning` / `finish` 都用它寻址。 */
  readonly id: string
  /** 它属于哪条会话；会话被清理时宿主据此连带清掉自己的后台记录。 */
  readonly sessionId: string
  /** 给用户看的任务标题，宿主填（通常是派发时的任务描述首行）。 */
  readonly title: string
  /** 后台进程的 OS 进程号；还没真正起进程（`starting`）或已收尾时为 null。 */
  readonly pid: Nullable<number>
  /** 当前状态；终态判定一律用 `isTerminalAgentBackgroundState`，别在宿主再列一遍名单。 */
  readonly state: AgentBackgroundAgentState
  /** 记录创建时刻（毫秒 epoch），即进入 `starting` 的时刻，之后不再改。 */
  readonly startedAt: number
  /** 最近一次状态写入时刻（毫秒 epoch）；`markRunning` / `finish` 都要刷新。 */
  readonly updatedAt: number
  /** 收尾时刻（毫秒 epoch）；未进入终态时为 null。 */
  readonly completedAt: Nullable<number>
  /** 进程退出码；非进程型后台 Agent 或尚未收尾时为 null。0 不代表业务成功，业务结论看 `state`。 */
  readonly exitCode: Nullable<number>
}

/** 后台 Agent 的只读 + 状态登记端口。产品用自己的存储实现，Platform 不管进程。 */
export interface AgentBackgroundAgentPort<TAgent extends AgentBackgroundAgent = AgentBackgroundAgent> {
  /** 按 id 取一条后台 Agent 记录；不存在返回 null。 */
  get(id: string): Promise<Nullable<TAgent>> | Nullable<TAgent>
  /** 列后台 Agent；缺省只列未收尾的，`includeCompleted` 打开后连终态一起列，`limit` 限条数。无匹配返回空数组。 */
  list(input?: { includeCompleted?: boolean; limit?: number }): Promise<readonly TAgent[]> | readonly TAgent[]
  /** 进程真正起来后登记 pid 并转入 `running`，返回新记录；记录不存在时抛错。 */
  markRunning(id: string, pid: number): Promise<TAgent> | TAgent
  /**
   * 收尾：写终态、`completedAt` 与可选退出码，返回新记录。
   *
   * 只接受四个终态取值；`exitCode` 省略表示这类后台 Agent 没有退出码概念。重复收尾应幂等而不是抛错。
   */
  finish(
    id: string,
    state: Extract<AgentBackgroundAgentState, 'completed' | 'failed' | 'stopped' | 'interrupted'>,
    exitCode?: LooseOptional<number>
  ): Promise<TAgent> | TAgent
}

/**
 * 后台 Agent 的完整控制端口：在只读端口之上再加「起、发、等、停」。
 *
 * 只登记状态的宿主实现 {@link AgentBackgroundAgentPort} 即可；真要驱动进程才实现这一层。
 */
export interface AgentBackgroundAgentControlPort<TAgent extends AgentBackgroundAgent = AgentBackgroundAgent>
  extends AgentBackgroundAgentPort<TAgent> {
  /** 起一个后台 Agent：建记录（`starting`）并拉起承载体，返回新记录。`payload` 是产品自定义的启动载荷，本包不解析。 */
  start(input: {
    readonly sessionId: string
    readonly title: string
    readonly payload: unknown
  }): Promise<TAgent> | TAgent
  /** 向运行中的后台 Agent 追发一条消息；载荷形状由产品定。目标已收尾或不存在时抛错。 */
  send(id: string, payload: unknown): Promise<void> | void
  /** 等它进入终态并返回最终记录；`timeoutMs` 到点仍未收尾应当抛超时错，而不是返回半截记录。 */
  wait(id: string, options?: { readonly timeoutMs?: number }): Promise<TAgent>
  /** 请求停止并返回收尾后的记录（终态一般是 `stopped`）；已在终态时应幂等返回现状。 */
  stop(id: string): Promise<TAgent> | TAgent
}

/** 数据根 port：把 sessionId 解析成账本文件的绝对路径。引擎只认此端口，不直读 app 路径。 */
export interface SessionLedgerLocator {
  /** 把 sessionId 解析成账本文件的绝对路径；不建目录也不判存在，只做定位。同一 sessionId 必须稳定返回同一路径。 */
  resolveLedgerPath(sessionId: string): string
}

/** SessionStore 引擎装配依赖。除 locator 外均可缺省；缺省用系统时钟 / randomUUID / 无回落。 */
export interface SessionStoreDeps {
  /** 账本文件定位器，必填；SessionStore 只经它取路径，绝不自己拼 app 目录。 */
  locator: SessionLedgerLocator
  /** 取当前时刻（毫秒 epoch），写条目时间戳用；缺省 `Date.now`。测试注入固定时钟可得确定性账本。 */
  now?: () => number
  /** 生成账本条目 id；缺省 `randomUUID()`。同一账本内必须唯一，否则重放会认错条目。 */
  nextEntryId?: () => string
  /** 账本自愈时的告警回调（半截尾行、越界截断等）；缺省吞掉。实现必须自己吞 IO 异常，别把告警变成故障。 */
  warn?: SessionLedgerWarn
}

/** 发请求时的采样策略。三项都可省略，省略即用厂商/宿主自己的默认值，本包不填缺省。 */
export interface AgentModelRequestPolicy {
  /** 采样温度，透传给厂商 SDK；取值范围由厂商定，本包不钳制也不校验。 */
  temperature?: number
  /** nucleus 采样阈值，透传给厂商 SDK；与 temperature 同时给不给由宿主决定。 */
  topP?: number
  /** 本次请求的输出 token 上限，透传给厂商 SDK；不是上下文窗口预算，别拿它当治理阈值用。 */
  maxOutputTokens?: number
}

/** 一次模型请求的选项信封。三项对本包都是不透明值，原样透传给注入的模型传输层。 */
export interface AgentModelRequestOptions {
  /** 厂商私有请求参数（thinking 开关、缓存位、beta header 等）；本包原样透传给注入的模型传输层，不解析键名。 */
  providerOptions?: Record<string, unknown>
  /** 本次请求的采样策略；省略即由模型包决定。 */
  requestPolicy?: AgentModelRequestPolicy
  /** 产品侧的模型运行上下文（账号、路由集合等），来自 `AgentSystemRuntimeConfig.modelRuntimeContext`；本包只搬运。 */
  runtimeContext?: Record<string, unknown>
}

/**
 * 模型实例工厂：给模型 id 与请求选项，返回一个可直接发请求的 `LanguageModel`。
 *
 * 由 {@link AgentModelResolverPort.createAgentProvider} 产出，每回合发请求前调用一次。
 * 模型 id 不可用、凭据缺失等一律由实现方抛错，本包不猜测替代模型。
 */
export type AgentModelProvider = (
  modelId: string,
  options?: AgentModelRequestOptions
) => LanguageModel

/**
 * 模型解析端口：Agent 只递不透明的选择与运行上下文，模型目录、鉴权、降级全归模型包。
 *
 * 本包不认识厂商、不存凭据、也不挑替代模型——这条边界一破，模型知识就会渗进执行域。
 */
export interface AgentModelResolverPort {
  /** 把产品的不透明模型选择编译成模型实例工厂；建执行栈与每次派发子 Agent 时各调一次。选择非法时抛错，本包不兜底。 */
  createAgentProvider(selection: unknown): AgentModelProvider
  /**
   * 解析本次执行真正要用的模型运行时（模型 id、窗口、能力位、厂商选项）。
   *
   * 主 Agent 每次 run 的开头调一次，子 Agent 每次派发再调一次；`signal` 中止时应抛中止错。
   * 目录查询、鉴权、降级全在模型包内部完成，返回的就是最终结论，Agent 侧不再挑选。
   */
  resolveRoleRuntime(
    selection: unknown,
    runtimeContext?: unknown,
    signal?: AbortSignal
  ): Promise<ResolvedAgentModelRuntime>
}

/** 工具按需读取已压缩会话上下文的最小 API。 */
export interface ToolConversationContextApi {
  /** 请求宿主向用户展示会话交接批准卡；缺席表示该宿主不支持交接。 */
  requestHandoff?: (
    input: ToolConversationHandoffRequest
  ) => Promise<ToolConversationHandoffResult>
  /**
   * 按 handle 取回被折叠/归档的上下文正文（`context:recall` 的 handle 通道）。
   *
   * 一次回合可被模型调多次；分页参数（jsonPath / offset）必须原样带下去，漏传会让模型反复拿到第一页。
   * 句柄不存在时返回「未命中」结果而不是抛错，模型据此换个 ref 再试。
   */
  retrieveContextPayload: (
    input: ChatContextRetrievePayloadRequest
  ) => Promise<ChatContextRetrievedPayload>
  /** 按关键词检索本会话的历史消息，返回带 handle 的命中片段；无命中返回空结果集，不抛错。 */
  searchConversationHistory: (
    input: ChatContextSearchConversationHistoryRequest
  ) => Promise<ChatContextSearchConversationHistoryResult>
  /** 按 evidenceId 读一条证据的正文摘录；宿主没有对应证据时返回未命中结果。 */
  readEvidence: (input: ChatContextReadEvidenceRequest) => Promise<ChatContextReadEvidenceResult>
  /** 按 toolCallId 或 payloadRef 读某次工具调用的完整回执（被截断时的补读通道），返回形状同 `retrieveContextPayload`。 */
  readToolPayload: (
    input: ChatContextReadToolPayloadRequest
  ) => Promise<ChatContextRetrievedPayload>
  /** 在本会话的终端输出账本里按关键词检索；要读盘，比 `searchConversationHistory` 贵，只在模型明确要查命令输出时调。 */
  searchTerminalOutput: (
    input: ChatContextSearchTerminalOutputRequest
  ) => Promise<ChatContextSearchTerminalOutputResult>
}

/** Runner 的模型运行时端口：在模型能力面之上，再补一层「把流式结果收敛成 UI 事件」的职责。 */
export interface RunnerModelRuntimePort extends RunnerModelCapabilityPort {
  /**
   * 把一次流式请求的异常收敛成运行时事件：中止类错误发 aborted，其余发 error。
   *
   * 由 SoloLoop 在流出错时调用，**不再往上抛**——主面靠事件轴收敛，抛错会让整轮 brick。
   */
  handleStreamError(
    error: unknown,
    turn: number,
    abortSignal: AbortSignal,
    events: ExecutionEventBusContract,
    log: ScopedLog
  ): void
  /** 发「本次运行正常收尾」运行时事件；一次 run 最多发一次，发完 UI 才收流。 */
  emitDone(events: ExecutionEventBusContract): void
  /** 发「本次运行被中止」运行时事件；`message` 省略时用默认中止文案。中止门里调用，不抛错。 */
  emitAbort(events: ExecutionEventBusContract, message?: string): void
}

/** Runner 读取运行时配置的窄端口。两块配置都是**按次读取**的活引用，宿主改设置后下一轮即生效。 */
export interface RunnerConfigService {
  /** 系统级运行配置（思考力度、禁用工具、提示词覆盖、并发上限、上下文治理）；每次 run 开头读一次。 */
  readonly systemConfig: AgentSystemRuntimeConfig
  /** 会话级运行配置（模型选择、系统提示词追加段）；构建提示词时读。 */
  readonly chatConfig: AgentChatRuntimeConfig
}

/** Runner 需要知道的工具面最小投影：只要名字，用于禁用名单比对与诊断输出。 */
export interface RunnerToolRegistry {
  /** 宿主注册表里当前全部工具名；本包只读不改，顺序由宿主保证稳定（会进提示词字节）。 */
  readonly names: string[]
}

/** 子 Agent 派发器端口。真正的并发闸、配额与线程账本都在实现里，Runner 只发请求。 */
export interface RunnerSubAgentDispatcher<TToolContext extends RunnerToolContext> {
  /** 列出本次可派发的子 Agent 类型与自定义 Agent（含描述与默认只读位），供提示词与 `agent:dispatch` 展示；不实现 = 该宿主不展示目录。 */
  describeDispatchCatalog?(): SubAgentDispatchCatalog
  /**
   * 派发一个子 Agent 并等它产出文本结论。
   *
   * 由 `agent:dispatch` / `agent:run_workflow` 调用，同一执行内可并发多次（受并发信号量与总量帽约束）。
   * 中止信号触发时抛中止错；子 Agent 自身失败时把失败结论格式化成文本返回，不抛给父 Agent。
   */
  dispatch(request: {
    input: SubAgentDispatchInput
    parentCtx: TToolContext
    events: ExecutionEventBusContract
    config: AgentExecutionConfig
  }): Promise<string>
  /**
   * 该执行此刻的真实派发配额（并发上限 + 总量帽剩余）。
   *
   * `agent:run_workflow` 用它当自己的上限并原样回显给模型；派发器是这些数字的唯一权威，
   * workflow 侧**不许**再有一份声明常量（否则 `effective_limits` 会与实际排队行为漂移）。
   */
  describeExecutionLimits(args: {
    executionId?: LooseOptional<string>
    sessionId: string
  }): SubAgentDispatchLimitsSnapshot
  /**
   * 执行收尾时回收该执行作用域的派发状态（并发信号量、总量计数、进展账本）。
   *
   * `executionKey` 必须与派发时用的是同一个 key（由 `resolveSubAgentExecutionKey` 统一算），
   * key 一漂移就会误清别的执行或漏清导致计数永不归零。子 Agent 线程不在此销毁，它们另有保留期。
   */
  clearExecution(executionKey: string): void
}

/** 工具上下文构建端口：把本轮执行的宿主服务组装成工具能直接调用的扁平上下文。 */
export interface RunnerToolContextBuilder<TToolContext extends RunnerToolContext> {
  /** 造一份本次执行（或子 Agent 线程）的工具上下文；每次 run 与每次派发各调一次，返回值在该次执行内共享。 */
  buildToolContext(args: RunnerBuildToolContextArgs): TToolContext
}

/** 执行作用域与隔离边界端口，归产品所有：本包只负责把整次执行包进宿主给的作用域里跑。 */
export interface RunnerExecutionEnvironmentPort {
  /**
   * 在宿主的执行作用域内跑完整次执行，并把解析出的资源标识（资源根、站点上下文等）交给 `action`。
   *
   * 每次 `streamSoloWorker` 包一层，一次执行只调一次；宿主可在这里做异步上下文绑定或沙箱隔离。
   * 不注入时本包用直通实现（空 scope），行为等价于没有隔离。`action` 抛什么就原样往外抛。
   */
  run<T>(
    input: {
      sessionId: string
      config: AgentExecutionConfig
    },
    action: (scope: RunnerExecutionScope) => Promise<T>
  ): Promise<T>
}

/** 工具可读的当前角色信息；由宿主按本轮解析出的角色填好后放进工具上下文。 */
export interface ToolRoleApi {
  /** 当前角色 id。 */
  readonly id: AgentRoleId
  /** 角色展示名称。 */
  readonly label: string
  /** 角色职责说明。 */
  readonly description: string
  /** 当前角色允许委派到的下一跳角色。 */
  readonly nextAllowedRoles: AgentRoleId[]
}

/** 本次 Agent 执行使用的模型运行时快照。 */
export interface ToolRuntimeApi {
  /**
   * 产品自有、厂商相关的模型运行时元数据（账号、路由、能力位等）。
   *
   * Agent 运行时把它当不透明值，只转交给显式登记了「需要宿主模型运行时上下文」的工具；
   * 缺席表示宿主没有这类信息，工具应当照常工作而不是报错。
   */
  metadata?: unknown
}

/**
 * 工具可用的执行域 API：审批、提问、任务与计划读写。
 *
 * 由 `createToolExecutionApi` 把宿主的执行服务绑定到「当前这一次执行」上，所以每个方法都不用再传 executionId。
 * 无执行会话的宿主（headless / 定时任务）应改用 {@link InteractionPort} 与 {@link ApprovalPort} 的降级实现。
 */
export interface ToolExecutionApi {
  /** 本次执行的标识；工具写日志、拼审批注册键、归档回执时用它做归属。 */
  executionId: string
  /** 请求一次确认；被拒或无通道时**抛错**，执行器记一次跳过、任务继续。风险分级见 options。 */
  awaitConfirmation: (
    message: string,
    abortSignal?: AbortSignal,
    options?: ToolConfirmationDecisionOptions
  ) => Promise<void>
  /** 请求一次确认但返回结构化决策（非终止型）：拒绝也只是 `approved: false` + 理由，工具据此自行降级。 */
  awaitConfirmationDecision: (
    message: string,
    abortSignal?: AbortSignal,
    options?: ToolConfirmationDecisionOptions
  ) => Promise<ApprovalDecision>
  /** 向用户提一个开放式问题并等文本回答（提问卡）；用户取消或信号中止时抛错。无人值守宿主应直接拒绝而不是挂起。 */
  awaitUserInput: (question: string, abortSignal?: AbortSignal) => Promise<string>
  /** 登记某个任务开始执行；写执行记录，UI 据此点亮进行中状态。任务不存在时由宿主抛错。 */
  startTask: (taskId: string) => void
  /** 登记任务完成，`result` 是给用户看的一句结论（可省略）；同一任务重复完成应幂等。 */
  completeTask: (taskId: string, result?: LooseOptional<string>) => void
  /** 登记任务失败并记下错误文案；失败只改这一条任务的状态，不自动终止整次执行。 */
  failTask: (taskId: string, error: string) => void
  /** 取当前正在执行的任务 id；一次执行总有一个根任务，因此必定有值。 */
  getCurrentTaskId: () => string
  /** 取当前任务的完整记录（状态、时间、结论等）；执行记录不存在时由宿主抛错。 */
  getCurrentTask: () => ExecutionTaskRecord
  /** 读当前任务的计划步骤；没有计划时返回空数组，不返回 null。 */
  getCurrentPlan: () => ExecutionTaskPlanStep[]
  /** 增删改计划步骤并返回更新后的全量计划；`plan:update` 工具的落点，同一轮可被调多次。 */
  updateCurrentPlan: (input: ToolExecutionPlanUpdate) => ExecutionTaskPlanStep[]
  /** 读系统给模型的下一步推荐动作；没有推荐时返回 null，模型自行决定。 */
  getCurrentRecommendedAction: () => ExecutionTaskRecord['recommendedAction']
  /** 读本次执行的执行建议（剩余步数、收尾提示等）；无建议返回 null。 */
  getCurrentExecutionAdvice: () => Nullable<ExecutionTaskExecutionAdvice>
}

/** 工具读写「活跃上下文」（每轮全量注入的长期事项）的端口。四个方法都不自动改写别人的条目。 */
export interface ToolActiveContextApi {
  /** 列出仍需每轮完整注入的活跃上下文。 */
  listActiveContextArtifacts: (
    options?: ActiveContextListOptions
  ) => Promise<ActiveContextArtifact[]>
  /** 新增或更新活跃上下文。 */
  upsertActiveContextArtifact: (input: ActiveContextUpsertInput) => Promise<ActiveContextArtifact>
  /** 归档已完成、废弃或被用户意图切换取代的活跃上下文。 */
  archiveActiveContextArtifacts: (
    filter: ActiveContextArchiveFilter
  ) => Promise<ActiveContextArtifact[]>
  /** 生成治理建议；不会自动归档或删除任何活跃上下文。 */
  assessActiveContextGovernance: (
    options?: ActiveContextGovernanceOptions
  ) => Promise<ActiveContextGovernanceReport>
}

/**
 * 会话级运行配置。模型配置对 Agent 运行时刻意保持不透明：
 * 厂商 id、凭据、模型目录与降级策略一律归模型包，本包只负责搬运。
 */
export interface AgentChatRuntimeConfig {
  /** 产品自有的模型选择（不透明值）；只经 {@link AgentModelResolverPort} 解释，本包不读字段。 */
  modelSelection?: unknown
  /** 追加到系统提示词末尾的用户自定义段；空串或纯空白视为不追加，本包 trim 后判空。 */
  systemPromptAppend: string
}

/** 系统级运行配置。宿主的设置面板改动会直接反映到下一轮执行，本包每次 run 现读现用。 */
export interface AgentSystemRuntimeConfig {
  /** 全局默认思考力度；单次执行可被 `AgentExecutionConfig.thinkingDepth` 覆盖。 */
  thinkingDepth: ThinkingDepth
  /** 用户在设置里关掉的工具名；注册表据此把它们从工具面整体摘掉（不是降权，是不可见）。 */
  disabledToolNames: string[]
  /** 提示词覆盖面，宿主让用户改写内置段落用。 */
  prompt: {
    /** 用户对内置提示词段的逐段覆盖/禁用声明；按段 id 匹配，未命中的声明静默忽略。 */
    segmentOverrides: PromptSegmentOverride[]
  }
  /** 高级运行参数；两项都省略时派发器用包内默认值。 */
  advancedRuntime: {
    /** 同一次执行内子 Agent 的并发上限（信号量容量）；省略时用包内默认。它与总量帽是两条独立闸门。 */
    maxConcurrentSubAgents?: number
    /** 同一次执行累计可派发的子 Agent 总数上限；省略时用包内默认。到帽后再派发直接被拒。 */
    maxSubAgentsPerExecution?: number
  }
  /**
   * 上下文治理配置（v2 §7 配置面）。宿主可传入，缺省全部走默认值兜底
   * （`resolveContextGovernanceConfig` 宽容解析：越界钳制不拒绝，一个手滑的值不打死治理链路）。
   *
   * 实验臂 = 同一引擎的预设（A0-truncation / A1-mechanical / A2-distill-always / A3-adaptive），
   * 不是第二条实现路径——见 `ContextGovernancePresets`。
   */
  contextGovernance?: LooseOptional<ContextGovernanceConfigInput>
  /** 产品自有的厂商集合上下文（账号、可用模型集、路由偏好等）；Agent 运行时只负责转交给模型解析端口，不读字段。 */
  modelRuntimeContext?: unknown
}

/**
 * 单次执行的配置，由宿主中立的 Agent 运行时消费。
 *
 * 这里刻意没有厂商与鉴权字段：产品把不透明的模型选择交给自己注入的
 * {@link AgentModelResolverPort}，本包全程不接触凭据。
 */
export interface AgentExecutionConfig {
  /** 本次执行的模型选择（不透明值）；省略时回落到 `AgentChatRuntimeConfig.modelSelection`。 */
  modelSelection?: unknown
  /** 界面语言，进提示词与工具文案；省略时由读取方兜底，不影响模型可用性。 */
  locale?: AppLocale
  /** 本次执行归属的会话 id；省略时 Runner 用 `window:<windowId>` 兜一个，以免会话级状态全挤在同一个 key 上。 */
  sessionId?: string
  /** 触发本次执行的那条用户消息 id，用于执行观测与真实任务评测串起「输入 → 这次执行」；宿主填，无从属输入时给 null。 */
  rootInputId?: LooseOptional<string>
  /** 本次执行允许模型看到的工具名白名单；省略 = 不额外收窄，按作用域与能力面决定。 */
  tools?: string[]
  /** 本次执行的思考力度；省略时用 `AgentSystemRuntimeConfig.thinkingDepth`。 */
  thinkingDepth?: ThinkingDepth
  /** Composer 的 5 档推理力度；模型适配层据此决定 reasoning 的开关、力度与预算。省略即走模型默认。 */
  reasoningLevel?: ReasoningLevel
  /** 会话谱系（父会话、分支来源），用于审批复用键与跨会话追溯；省略表示这是一条独立会话。 */
  sessionLineage?: LooseOptional<SessionLineageContext>
  /** 能力轴：只表达「哪些能力本轮开着」。执行模式走 `executionModes`。 */
  promptFeatures?: ChatPromptFeatureId[]
  /**
   * 执行模式轴（权威）。缺席时读取点经 `resolveExecutionModes` 从旧形态折算，
   * 因此尚未改写的宿主路径（定时任务 / 无人值守 / 外部引擎）零改动继续成立。
   */
  executionModes?: ExecutionModeId[]
  /** @deprecated 已并入 `executionModes`；保留为旧宿主入口。 */
  goalMode?: boolean
  /**
   * 是否为本次执行启用宿主注入的执行隔离资源（宿主自己决定隔离怎么做）。
   *
   * 本包只搬运这个开关，隔离怎么做由 {@link RunnerExecutionEnvironmentPort} 的实现决定；
   * 定时任务 / 无人值守路径通常显式传 false。
   */
  executionIsolationEnabled?: boolean
  /** 本次执行的能力作用域 id（由产品注册的那些作用域之一）；决定工具面与常驻集。省略时由作用域策略从运行事实推断。 */
  scope?: CapabilityScopeId
  /** 工具面档位（决定工具清单以多细的粒度呈现给模型）；省略时用 run profile 的默认档。 */
  toolSurfaceProfile?: ToolSurfaceProfileId
  /** 运行档位选择（快/稳/深等预设的组合）；省略时用会话当前档，读取点经 `resolveSnapshotRunProfile` 归一。 */
  runProfile?: RunProfileSelectionId
  /** 危险操作的确认策略（每次问 / 标准 / 不问）；来自用户设置，审批端口据此决定是否自动放行。 */
  permissionConfirmationMode?: PermissionConfirmationMode
  /**
   * 无人值守执行（定时任务、hook 派发等）：不创建等待 UI 应答的确认卡。
   *
   * 显式低风险确认仍可按 `permissionConfirmationMode` 自动处理；高风险或要求人工确认的操作直接拒绝，避免后台永久挂起。
   */
  unattended?: boolean
  /** 发起本次执行的窗口号；主要用于 `sessionId` 缺席时兜底拼 key，以及把事件投回正确的窗口。 */
  windowId?: number
  /** 本次执行的中止控制器；省略时 Runner 自建一个。宿主想支持「停止」就必须自己传并持有。 */
  abortController?: AbortController
  /** 已绑定到本次执行的执行域 API；省略表示这是无执行会话的宿主，工具应走降级端口。 */
  execution?: LooseOptional<ToolExecutionApi>
  /** 用户为本轮显式选中的技能 id；选中的技能跳过作用域过滤（enabled 与资源根精筛仍生效）。 */
  selectedSkillIds?: string[]
  /** 选中技能的调用参数，即携带该选择的那条用户消息文本；技能正文里的 `$ARGUMENTS` 占位按需替换。 */
  skillArguments?: string
  /** 本次执行的 Agent 界面档 id；给了就直接按 id 解析界面档，不再从 developerContext 推断。 */
  agentSurfaceId?: LooseOptional<AgentSurfaceId>
  /** 开发者上下文（当前工程、语言、工具链等）；`agentSurfaceId` 缺席时用它推断界面档。 */
  developerContext?: LooseOptional<AgentDeveloperContext>
}

/** 用于 capabilityToolNames 派生工具名时表达分类。 */
export type ReminderCapabilityResolver = (category: ToolCategoryId) => string[]

/** Producer 声明：把"什么时机发什么提醒"沉淀为静态描述，让调度器集中决定是否注入。 */
export interface RuntimeReminderProducer {
  /** 全局唯一 id；同 id 注册时覆盖。 */
  id: string
  /** 触发器集合；调度器仅在匹配触发器时考虑该 producer。 */
  triggers: readonly ReminderTrigger[]
  /** 越小越靠前；同一触发器下，命中多个时按 priority 选最高优。 */
  priority: number
  /** 单次性策略，配合 editVersion 决定是否已发。 */
  scope: ReminderScope
  /** Producer 关注的能力分类；调试展示用，render 内部可自由读取 capabilityToolNames。 */
  capabilities?: readonly ToolCategoryId[]
  /** 激活谓词；返回 false 时调度器跳过。 */
  when: (input: RuntimeReminderInput) => boolean
  /** 渲染提示文本；空文案视为不发送。 */
  render: (input: RuntimeReminderInput) => LooseOptional<string>
}

/**
 * 产品 Session 的事件账本端口（目标 / 计划 / 提问三个服务的唯一持久化出口）。
 *
 * 语义是 append-only 事件流：状态一律由 `readEvents` 顺序折叠得出，没有「就地改一条」的写法。
 */
export interface AgentSessionEventPort {
  /** 按写入顺序读全部事件；无事件返回空数组。每次 `get`/`create`/`update` 都会整条重放，实现要保证读足够快。 */
  readEvents(sessionId: string): readonly AgentSessionApplicationEvent[]
  /**
   * 追加一条事件。`type` 是产品约定的事件名（如 `goal.created`），`payload` 本包不解析。
   *
   * `eventId` 省略时由宿主生成；`createdAt` 省略时由宿主用自己的时钟填——折叠时会当作该条的时间戳。
   * 写失败必须抛错，静默丢事件会让会话状态凭空回退。返回值本包不使用。
   */
  appendEvent(
    sessionId: string,
    input: {
      readonly eventId?: string
      readonly type: string
      readonly payload: unknown
      readonly createdAt?: number
    }
  ): unknown
}

/**
 * 准入断言端口。
 *
 * 语义 = 「当前进程是否处于已授权运行态」的单点断言，把执行域对具体登录判定源
 * 直接依赖收拢成一个窄接口：执行域只认端口，装配层注入实现。headless 或 BYOK 宿主可提供
 * 与其部署模型匹配的授权策略。
 */
export interface AuthGatePort {
  /** 未处于已验证登录态时抛 `AppError('AUTH')`。 */
  assertAuthenticated(): void
}

/**
 * 执行记录落盘路径端口。
 *
 * 把 ExecutionStore 持久化路径对具体存储服务的依赖收拢成一个窄接口。
 */
export interface ExecutionRecordsPathPort {
  /** 返回执行记录持久化文件路径。 */
  getExecutionRecordsPath(): string
}

/**
 * 执行资源端口。资源可表示项目、页面、设备或宿主任意可寻址对象。
 */
export interface ExecutionResourcePort extends ExecutionResourceProvider {
  /** 解析指定会话的可选执行资源标识。 */
  getExecutionResourceId(sessionId?: string): Nullable<string>
}

/**
 * 执行活动信号端口。宿主可在执行期间保持监听器或遥测会话。
 */
export interface ExecutionActivitySignalsPort {
  /** 保活指定会话的宿主活动信号，返回释放函数。 */
  beginExecutionSession(sessionId: string): () => void
}

/**
 * 执行协作端口。
 *
 * 把托管执行者登记进宿主协作账本，收尾时通过句柄标记完成。
 */
export interface ExecutionCollaborationPort {
  /**
   * 把本次托管执行的主 Agent 登记成一名协作执行者，返回收尾用的句柄。
   *
   * 每次托管执行开头调一次；登记失败（例如资源标识解析不出来）应抛错，调用方会记一条 info 并跳过登记继续执行——
   * 协作账本是可观测面，不是执行的前置条件。
   */
  registerActor(input: ExecutionCollaborationActorInput): ExecutionCollaborationActorHandle
}

/**
 * 子 Agent 引导 relay 规划器端口。
 *
 * 用户对运行中会话追加引导时，规划面向各活跃子 Agent 的改写 relay 与主控消息。
 * 产品宿主可注入使用辅助模型或确定性规则的 relay 规划器。
 */
export interface ExecutionGuidanceRelayPlanner {
  /**
   * 把用户追加的一句引导，改写成发给各活跃子 Agent 的 relay 与给主控的一条消息。
   *
   * 用户在执行中途追发消息、且此刻有活跃子 Agent 时调一次。失败或耗时过长时调用方吞掉异常并记 warn——
   * relay 规划失败不该让已在跑的执行崩掉，只是这次引导没传到子 Agent。
   */
  planRelay(input: ExecutionGuidanceRelayPlanInput): Promise<ExecutionGuidanceRelayPlan>
}

/** 派发器读取运行时配置的窄端口，形状与 {@link RunnerConfigService} 相同但装配路径独立。 */
export interface SubAgentConfigPort {
  /** 系统级配置；派发器主要从中读并发上限与总量帽（`advancedRuntime`）。按次读取，设置改了下次派发即生效。 */
  readonly systemConfig: AgentSystemRuntimeConfig
  /** 会话级配置；子 Agent 构建自己的提示词与模型选择时读。 */
  readonly chatConfig: AgentChatRuntimeConfig
}

/** 真正跑一个子 Agent 的执行端口。装配时由 `bindAgentRunner` 回填，未绑定就派发会抛 INTERNAL。 */
export interface SubAgentQueryRunner {
  /**
   * 跑一轮子 Agent 问答并返回它的文本结论。
   *
   * 每次派发调一次，同一执行内可并发；`opts` 携带该子 Agent 的类型配置、模型路由与中止信号。
   * 中止信号触发时抛中止错；其余失败照常抛，由派发器决定是否换路由重试。
   */
  query(
    task: string,
    parentCtx: SubAgentToolContext,
    opts: SubAgentQueryOptions
  ): Promise<string>
}

/** 用户自定义子 Agent（文件式 agent 定义）的注册表端口；不注入 = 该宿主只有内置类型。 */
export interface CustomSubAgentRegistry {
  /** 按 id 取自定义 Agent 的完整定义（提示词正文、工具类别、只读位）；不存在返回 null，派发器据此报「未知子 Agent 类型」。 */
  get(id: string): Nullable<CustomSubAgentDefinition>
  /** 列出全部自定义 Agent 的简介（不含正文），并进派发目录；`base` 指向的内置类型不存在的条目会被派发器跳过。 */
  listDescriptors(): readonly CustomSubAgentDescriptor[]
}

/** 工具读取技能的端口；由宿主按当前角色与选中集绑好后放进工具上下文。 */
export interface ToolSkillsApi {
  /** 列当前角色可见的技能简介（不含正文）；模型据此决定要不要 `tooling:read` 全文。无可见技能返回空数组。 */
  listRoleSkills: () => AgentSkillDescriptor[]
  /** 按 id 读技能全文；不可见或不存在返回 null（提示词说"先读 skill:x"却读不到就是这里回了 null，要连注入侧一起查）。 */
  readRoleSkill: (skillId: string) => Nullable<ToolRoleSkillReadResult>
  /** 该技能是否是用户本轮亲手选中的；用于跳过「先读技能」的确认提示。不实现时按未选中处理。 */
  isSkillSelected?: (skillId: string) => boolean
}

/** 单次 run 的回合钩子。两个钩子都可缺席，缺席 = 不干预循环。 */
export interface AgentRunLifecycle<TContext> {
  /** 在冻结本回合工具面、编译本回合请求**之前**调用；宿主可在这里改历史或补上下文。抛错会中断整轮。 */
  beforeTurn?(turn: AgentTurnBoundary<TContext>): void | Promise<void>
  /**
   * 一回合落定后调用，此时 history 已含本回合的 assistant 与工具结果。
   *
   * 循环会 await 它（宿主借此把本回合落盘）再发下一次请求；返回 `'stop'` 可要求收尾，
   * 返回 `'continue'` 或不返回则按循环自己的判断继续。
   */
  onTurnSettled?(turn: AgentTurnSettlement<TContext>):
    void | 'continue' | 'stop' | Promise<void | 'continue' | 'stop'>
}

/** 模型重试策略。决策跑在共用重试循环内部，且在包内强制的重放安全检查**之后**才会被问到。 */
export interface AgentModelRetryPolicy {
  /**
   * 一次模型请求失败后决定还要不要重试：返回 `{ delayMs }` 表示等这么久再试，返回 null 表示放弃并原样抛出。
   *
   * 只有过了包内强制的重放安全检查（已有可见输出就不重试等）才会走到这里，因此实现只需判断错误本身。
   * `delayMs` 必须是有限非负数，否则包内直接抛 VALIDATION。`attempt` 从 1 开始计数。
   */
  onFailure(input: { error: unknown; attempt: number; abortSignal: AbortSignal }):
    Nullable<{ delayMs: number }> | Promise<Nullable<{ delayMs: number }>>
  /** 显式传 false 表示「已经吐过可见输出就绝不续跑」，此时中途失败直接抛错；缺省 true，允许在已有部分输出后继续。 */
  allowPartialContinuation?: boolean
}

/** 召回索引的载荷读端口：把会话里被折叠的工具回执重新取回来。 */
export interface RetrievalPayloadStorePort {
  /** 读整条会话的载荷快照，供索引构建与按 handle 取回；无载荷返回空快照，不返回 null。一次召回可能调多次，实现应自带缓存。 */
  loadSessionPayloads(sessionId: string): Promise<ChatSessionPayloadSnapshot>
  /** 按 key 直接取单条工具回执的快路径；不实现时读取方回落到整条快照里找。不存在返回 null。 */
  loadToolPayload?(
    sessionId: string,
    key: string
  ): Promise<Nullable<ChatSessionToolResultPayload>>
}

/**
 * state 读端口：会话消息的按会话读取。
 *
 * 2026-08-06 evidence 流协议链下线：本端口曾多一格 `loadSessionContextSnapshot`，
 * 只为把宿主的 `session.runtime.evidenceLedger` 喂给索引构建。那条账本自始至终没有
 * 生产者（`evidenceExtractors` 两仓零注册），整链已随协议字段一并处决，端口回到
 * 「只读消息」的最小形状。
 */
export interface RetrievalStateStorePort {
  /** 读整条会话的消息列表，供召回索引构建；会话不存在或无消息返回空数组。索引每次重建都要走一次，实现要能扛住大会话。 */
  loadSessionMessages(sessionId: string): Promise<ChatMessage[]>
  /** 按下标读单条消息（命中索引后回原文用）；越界或会话不存在返回 null，不抛错。 */
  loadSessionMessage(sessionId: string, index: number): Promise<Nullable<ChatMessage>>
}

/**
 * 界面档集合端口，归产品所有。
 *
 * 运行时刻意不带注册表、不带内置档、也不带兜底档：产品自己解析出界面档，
 * 并自己把能力 id 映射到工具类别。解析不出来就该抛错，本包没有可回落的默认界面。
 */
export interface AgentSurfaceProfileProvider {
  /** 解析本次执行的界面档：优先按 `agentSurfaceId`，否则从 `developerContext` 推断。每次 run 开头调一次，必须返回一个档（没有就抛错，本包没有兜底档）。 */
  resolve(input: ResolveAgentSurfaceInput): AgentSurfaceProfile
  /** 由界面档 + 声明作用域 + 本轮能力 + 上次已批准类别，推导本次 run 的运行策略（能否派发子 Agent、默认放行哪些类别）。每次 run 调一次。 */
  deriveRunPolicy(input: DeriveSurfaceRunPolicyInput): DerivedAgentSurfaceRunPolicy
}

/** 事件汇（sink）端口。实现必须自行吞掉自己的 IO 失败——治理链路不因日志写失败而中断。 */
export interface ContextMigrationEventSink {
  /** 记一次上下文驻留迁移（进/出驻留、压缩、折叠）；治理账本每次搬运记录都会调，频次高，实现要轻。 */
  recordMigration(event: ContextResidencyMigrationEvent): void
  /** 记一次上下文故障（引用已失效、读不回正文等）；模型拿到不可用引用时调，用于事后定位召回链断点。 */
  recordFault(event: ContextFaultEvent): void
}

/**
 * OAuth provider 仍由产品实现和持久化。可选 authorizationUrl 只用于把 SDK 的 401
 * 归一化成可展示、可恢复的协议错误，不授予 Platform 发起授权交互或写入凭据的权限。
 */
export interface McpAuthorizationProvider extends OAuthClientProvider {
  /** 该 MCP server 的授权页地址；连接遇到 401 时本包把它写进 `McpAuthorizationRequiredError` 交给 UI 引导用户去授权。缺席 = 只能报「需要授权」而给不出入口。 */
  readonly authorizationUrl?: LooseOptional<URL>
}

/** 远程能力节点服务的宿主端口三件套：工具面往哪投、凭据怎么存、对端看到的客户端叫什么。 */
export interface RemoteHostServicePorts {
  /**
   * 工具面整批替换。
   *
   * 是 sink 而不是「拿 provider 再自己刷」:宿主的注册表形状(provider / 覆盖栈 / 类别门)
   * 属于宿主,本包不该认识它。宿主实现这一个方法即可,本包不持有任何宿主对象。
   */
  readonly publishTools: (entries: readonly RemoteHostToolEntry[]) => void
  /** 为某台远程主机造一个凭据仓；配对成功后的长期凭据由它落盘，之后每次连接靠 challenge 签名。hostId 相同必须拿到同一份凭据。 */
  readonly createCredentialStore: (hostId: string) => RemoteNodeClientCredentialStore
  /** 本客户端对远端自报的名字，出现在对端的连接列表与审计里；宿主填成可辨识的产品名，不是随机 id。 */
  readonly clientName: string
}

/** 执行域取时间的窄端口，唯一目的是让 id 工厂与执行记录在测试里可确定性重放。 */
export interface ExecutionClock {
  /** 当前时刻（毫秒 epoch）；缺省实现就是 `Date.now`，测试可注入固定值。 */
  now(): number
}

/** 执行域的三类标识生成器。实例自带计数器与随机命名空间，不同运行时之间不会撞号。 */
export interface ExecutionIdFactory {
  /** 生成一次执行的 id；每次托管执行开头调一次。 */
  createExecutionId(): string
  /** 生成一个执行任务的 id；根任务与每个派生任务各调一次。 */
  createTaskId(): string
  /** 生成一个计划步骤的 id；模型新增计划步骤且没自带 id 时调。 */
  createPlanStepId(): string
}

/** 后台任务输出的存储端口。不注入时用包内内存实现（进程退出即丢）。 */
export interface KernelBackgroundJobOutputStore {
  /** 追加一段输出并登记它的归属会话；后台任务每产出一块就调一次，频次高。`parentSessionId` 让父会话清理时能连带清掉子任务输出。 */
  append(input: {
    jobId: string
    sessionId: string
    parentSessionId?: string
    chunk: string
  }): void
  /** 从 `offset` 起读增量输出，并给出下次接着读的 `nextOffset`；jobId 没有任何输出记录时返回 null。越界 offset 由实现钳到合法范围。 */
  read(input: { jobId: string; offset: number }): Nullable<KernelBackgroundJobStoredOutput>
  /** 读该任务从头到现在的全部输出；无记录返回 null。等价于 `read({ offset: 0 })`。 */
  readAll(input: { jobId: string }): Nullable<KernelBackgroundJobStoredOutput>
  /** 丢掉单个任务的输出与归属登记；任务收尾并被读走后调用。不存在时静默返回。 */
  dropJob(jobId: string): void
  /** 丢掉某会话名下（含以它为父会话的）全部任务输出；会话清理时调一次。 */
  dropSession(sessionId: string): void
}

/**
 * 提示词能力（prompt feature）与工具类别的对应策略。
 *
 * 这套对应关系是产品知识，包内不做假设；宿主不注入时用只做去重、其余一律空结论的缺省实现。
 */
export interface RuntimePromptFeaturePolicy {
  /** 归一化本轮能力集合（至少去重保序）；构建提示词与记账两处都会调。 */
  normalize(features: readonly ChatPromptFeatureId[]): ChatPromptFeatureId[]
  /** 宿主可按当前能力作用域收窄常驻协议；缺席时沿用全局归一。 */
  normalizeForScope?(
    features: readonly ChatPromptFeatureId[],
    scope: CapabilityScopeId
  ): ChatPromptFeatureId[]
  /** 取能力的展示名，直接进提示词给模型看；缺省实现返回 feature id 本身。 */
  getLabel(feature: ChatPromptFeatureId): string
  /**
   * 内置协议也可以用 feature id 参与运行时装配，但不应被描述成用户“本轮已选”的能力。
   * 宿主不实现时保持历史行为：所有 feature 都按已选能力展示。
   */
  shouldDescribeAsSelected?(feature: ChatPromptFeatureId): boolean
  /** 这些能力对应哪些工具类别；开能力即开这些类别。缺省实现返回空数组（即包内不认识任何对应关系）。 */
  getCategoriesForFeatures(features: readonly ChatPromptFeatureId[]): ToolCategoryId[]
  /** 上一条的反向映射：这些工具类别归属哪些能力。用于从已开类别倒推该展示哪些能力。 */
  getFeaturesForCategories(categories: readonly ToolCategoryId[]): ChatPromptFeatureId[]
  /** 该工具必须开着哪个能力才可见；返回 null = 不受能力门限制。注册表每次判定工具可见性时调。 */
  getRequiredFeatureForTool(
    toolName: string,
    categoryId?: LooseOptional<ToolCategoryId>
  ): Nullable<ChatPromptFeatureId>
  /** 该能力是否属于 office 族；office 族工具可被会话上的 `office` 总开关整体放行。缺省实现一律 false。 */
  isOfficeFeature(feature: ChatPromptFeatureId): boolean
}

/**
 * 审批通道端口。
 *
 * 把「要不要问、问谁、答案是什么」抽象成一个通道：工具只管请求审批，
 * 具体如何征询（确认卡 / 策略自动放行 / 无通道时设计式拒绝）由宿主注入的实现决定。
 * 决策形状与风险分类复用现有确认机制（{@link ToolConfirmationDecisionOptions} /
 * {@link ApprovalDecision}），不引入平行的第二套风险模型。
 *
 * 两种征询形态对齐现有 execution 确认机制：{@link ApprovalPort.awaitConfirmation}
 * 被拒会抛出仅取消当前操作的错误，{@link ApprovalPort.awaitConfirmationDecision} 是非终止型
 * （被拒返回结构化决策）。二者都只表达「审批」，不承载计划/任务/用户输入等交互会话能力。
 */
export interface ApprovalPort {
  /**
   * 请求一次工具执行审批；被拒或无审批通道时**抛出**，由工具执行器记录跳过，任务继续。
   *
   * @param message 面向用户的确认文案。
   * @param abortSignal 取消信号；征询被中止时应视为拒绝。
   * @param options 风险分类与复用/手动确认策略（approvalRisk / riskScope / requireManualApproval 等）。
   */
  awaitConfirmation(
    message: string,
    abortSignal?: AbortSignal,
    options?: ToolConfirmationDecisionOptions
  ): Promise<void>
  /**
   * 请求一次工具执行审批，返回**结构化决策**（非终止型）。
   *
   * @returns approved 是否放行、message 拒绝原因或批注、autoApproved 是否策略自动放行。
   */
  awaitConfirmationDecision(
    message: string,
    abortSignal?: AbortSignal,
    options?: ToolConfirmationDecisionOptions
  ): Promise<ApprovalDecision>
}

/**
 * 交互会话端口，是审批端口 ApprovalPort 的姊妹件。
 *
 * 把执行会话的**非审批交互面**抽象成一个通道：工具只管读写当前会话的计划、任务、推荐动作、
 * 执行建议。这些状态来自持久化执行记录还是无会话宿主的显式降级，由宿主注入的实现决定。
 * 端口形状是执行交互面的结构化子集；拥有更宽执行服务的宿主可以直接满足，其他宿主使用
 * {@link defaultUnsupportedInteractionPort} 明确报告不支持。
 *
 * 与审批面正交：本端口只承载「会话读写」，不表达审批。等待用户输入与动作卡结果在本仓由审批端口
 * 的确认决策承载（提问卡 `ask_user` 即经此路），故不在此端口重复。
 */
export interface InteractionPort {
  /** 当前交互会话（execution）标识；无会话宿主为空串。 */
  executionId: string
  /** 读取当前会话可见的执行计划；无会话时返回空计划。 */
  getCurrentPlan: () => ExecutionTaskPlanStep[]
  /** 更新并返回当前会话可见的执行计划；无会话时为 no-op、返回空计划。 */
  updateCurrentPlan: (input: ToolExecutionPlanUpdate) => ExecutionTaskPlanStep[]
  /** 读取当前任务记录；无会话时返回 null。 */
  getCurrentTask: () => Nullable<ExecutionTaskRecord>
  /** 读取系统对下一步的推荐动作；无会话或无推荐时返回 null。 */
  getCurrentRecommendedAction: () => Nullable<ExecutionTaskRecommendedAction>
  /** 读取当前执行建议；无会话或无建议时返回 null。 */
  getCurrentExecutionAdvice: () => Nullable<ExecutionTaskExecutionAdvice>
}

/** 工具回执的模型面投影端口：决定模型实际看到多少、完整正文往哪存。 */
export interface KernelToolOutputStore {
  /**
   * 把一次工具回执投影成「给模型看的那份」并落存完整正文，返回投影结果与存储句柄。
   *
   * 每次工具调用成功后调一次。投影通常是按上限截断 + 附一个可召回的引用；
   * 存不下时实现可返回未落存的结果（`stored` 为空），模型面仍要能拿到可用输出。
   */
  project(
    input: ProjectKernelToolOutputInput
  ): ProjectKernelToolOutputResult | Promise<ProjectKernelToolOutputResult>
}

/**
 * 上下文载荷仓：按「会话 + 内容 hash」去重存放被折叠的工具回执与用户长文本。
 *
 * 带 `?` 的批量/用户文本方法不实现时，读取方逐条回落到单条方法或跳过对应能力。
 */
export interface ContextPayloadStore {
  /** 按内容 hash 取一条载荷记录；未命中返回 null（意味着该引用已失效，召回侧应报「取不回」而不是崩）。 */
  findByHash(sessionId: string, hash: string): Promise<Nullable<ContextPayloadRecord>>
  /** 批量取，返回 hash → 记录的映射，未命中的 hash 不出现在结果里。不实现时读取方退化成逐条 `findByHash`。 */
  findManyByHash?(
    sessionId: string,
    hashes: readonly string[]
  ): Promise<Map<string, ContextPayloadRecord>>
  /** 存一条载荷并返回落库记录；同 hash 已存在时必须返回既有记录、不覆盖——hash 相同即内容相同，去重是这个仓存在的理由。 */
  put(record: ContextPayloadRecord): Promise<ContextPayloadRecord>
  /** 批量存，返回与入参同序的落库记录（已存在的返回既有条目）。不实现时读取方逐条 `put`。 */
  putMany?(records: readonly ContextPayloadRecord[]): Promise<ContextPayloadRecord[]>
  /** 列该会话的全部载荷记录，供诊断与索引构建；无记录返回空数组。 */
  listForSession(sessionId: string): Promise<ContextPayloadRecord[]>
  /** 按 hash 取一条被折叠的用户长文本；未命中返回 null。不实现 = 该宿主不折叠用户文本。 */
  findUserTextByHash?(
    sessionId: string,
    hash: string
  ): Promise<Nullable<ContextUserTextRecord>>
  /** 用户文本的批量取，语义同 `findManyByHash`。 */
  findUserTextsByHash?(
    sessionId: string,
    hashes: readonly string[]
  ): Promise<Map<string, ContextUserTextRecord>>
  /** 存一条用户长文本，同 hash 已存在时返回既有记录、不覆盖。 */
  putUserText?(record: ContextUserTextRecord): Promise<ContextUserTextRecord>
  /** 用户文本的批量存，语义同 `putMany`。 */
  putUserTextMany?(records: readonly ContextUserTextRecord[]): Promise<ContextUserTextRecord[]>
}

/**
 * Product-owned Agent runtime injected at composition time.
 *
 * The Kernel adapter deliberately treats execution input and output as opaque.
 * Agent session, prompt, tool, and capability semantics remain owned by
 * Agent 运行时及其宿主装配，而不是 Kernel 契约。
 *
 * Two-tier registration boundary: this adapter is tier one and never parses a
 * domain manifest. Hosts pass the Kernel pack listing to the tier-two Agent
 * loader through `assembleAgentMods` (see `mods/AgentModHostAssembly.ts`) and
 * inject the assembled runtime here, so the Kernel keeps seeing only the narrow
 * module descriptor.
 */
export interface AgentCapabilityRuntime {
  /** 内核模块 `ready` 阶段调一次，做启动准备；抛错即模块起不来。`signal` 在启动被取消时触发，实现应尽快退出。不实现 = 无需准备。 */
  start?(signal: AbortSignal): void | Promise<void>
  /**
   * 执行一次 Agent 请求。入参与返回值对 Kernel 完全不透明，会话/提示词/工具语义都归 Agent 运行时与其宿主装配。
   *
   * 只有 `ready` 之后才会被调到（之前调直接抛）；调用方持 `agent:execute` 权限。
   * 中止由 `context.signal` 传达，实现应抛中止错而不是返回半截结果。
   */
  execute(
    scope: LooseOptional<ScopeRef>,
    input: unknown,
    context: AgentCapabilityExecutionContext,
  ): unknown | Promise<unknown>
  /** 自报健康度，供内核与运维面查询（不需要权限）；不实现时未 ready 报 unknown、ready 后报 healthy。 */
  health?(): KernelModuleHealth | Promise<KernelModuleHealth>
  /** 内核挂起该模块时调；调用方先把 ready 置回 false，之后 `execute` 一律被拒。不实现 = 无需挂起动作。 */
  suspend?(): void | Promise<void>
  /** 内核卸载该模块时调，释放长驻资源；同样先置 ready 为 false。不实现 = 无需清理。 */
  dispose?(): void | Promise<void>
}

/** `createAgentKernelModule` 的装配入参：把宿主组装好的 Agent 运行时挂进内核模块生命周期。 */
export interface CreateAgentKernelModuleOptions {
  /** 由产品宿主装配好的 Agent 运行时实现；内核模块的 ready / health / suspend / dispose 全部转调它。必填。 */
  readonly runtime: AgentCapabilityRuntime
}

/** pack 读取端口：宿主实现 IO，主干只负责编排与判定。 */
export interface AgentModPackReader {
  /**
   * 读 pack 目录下的分节单文件 manifest（整份 `velaros.mod.json`，不是某一节）；
   * 不存在或读失败应抛错（拒载而非静默跳过）。取 agent 节是本主干的事。
   */
  readManifest(input: {
    packDirectory: string
    manifestFileName: string
    descriptor: AgentModPackDescriptorLike
  }): Promise<unknown> | unknown
  /**
   * 装载 pack 的运行态绑定（工具实体 / 钩子 handler 等）；纯数据 mod 可不实现。
   *
   * `manifest` 是**整份信封**（宿主装载代码时可能要用 `module` 节的寻址字段），不是 agent 节。
   */
  loadBindings?(input: {
    packDirectory: string
    manifest: unknown
    descriptor: AgentModPackDescriptorLike
  }): Promise<AgentModBindings | undefined> | AgentModBindings | undefined
}

/**
 * 建执行栈时必须注入的工具注册表形状：Solo 循环、Query 循环、回合执行器三方要求的交集。
 *
 * 宿主自己的注册表只要同时满足这三面即可直接传进来，本包不提供实现。
 */
export type AgentExecutionStackToolRegistry<TContext extends AgentExecutionStackToolContext> =
  SoloLoopToolRegistry<TContext> &
    QueryLoopToolRegistry<TContext> &
    TurnRunnerToolRegistry<TContext>

/** 角色目录端口：具体有哪些角色、各带什么技能与工具类别，全由产品装配决定，本包不内置任何角色。 */
export interface AgentRoleDescriptorProvider {
  /** 列出本装配下的全部角色定义（职责、可委派下一跳、绑定的工具类别）；建角色表时调一次，id 重复者后者覆盖。返回空数组即该宿主不分角色。 */
  listRoles(context: AgentRoleDescriptorProviderContext): readonly AgentRoleDefinition[]
}

/**
 * 注入 runner 的可选 span 端口（`spanRecorder?`）。缺省 = 无观测（零付费）。
 *
 * runner（SoloLoop）每次执行 `beginRun` 得到一个 run scope；其余生产侧只经 scope 派生，不碰账本/recorder。
 */
export interface ExecutionSpanScopeFactory {
  /**
   * 开一个 run 级 span scope；SoloLoop / QueryLoop 每次执行开头各调一次，返回的 scope 供其余生产侧派生子 span。
   *
   * 实现必须自己吞掉落盘失败——观测不该把执行搞崩。端口缺席时整条观测链直接不存在（零开销）。
   */
  beginRun(input: {
    runId: string
    sessionId: string
    rootInputId: Nullable<string>
    /** 子 Agent 身份/角色名（主 Agent 根 run 用 null）——令独立顶层 run 在同会话多 run 树里可辨识。 */
    agentName: Nullable<string>
    /** 派发来源（子 Agent 的父角色/派发链；主 Agent 根 run 用 null）。 */
    dispatchSource: Nullable<string>
  }): RunSpanScope
}

/** 子 Agent 的模型路由端口：模型目录、鉴权、健康度与降级全部由产品的模型集合实现，本包只按结论发请求。 */
export interface TeamModelRoutingPort {
  /** 为一次子 Agent 派发选定路由（厂商、模型、运行时覆盖）；每次派发同步调一次，选不出可用路由时抛错。 */
  resolve(request: TeamModelRouteRequest): TeamModelRouteResult
  /**
   * 列出与 `selection`（主模型的模型选择）同一厂商、可供子 Agent 使用的模型。
   * 主 Agent 经 `agent:dispatch.model` 指定模型时据此校验；返回 null 或不实现 = 宿主不提供目录
   * （例如自定义厂商接受任意模型 id），此时按原样透传。
   */
  listSelectableModels?(
    selection: unknown
  ): Nullable<readonly TeamSelectableModel[]> | Promise<Nullable<readonly TeamSelectableModel[]>>
  /** 该厂商这次跑通了，供宿主做健康度统计与优先级回学；派发成功后调，不实现即不统计。 */
  markSuccess?(providerId: string): void
  /** 该厂商这次失败了（附原因）；派发失败且不是中止时调，宿主据此降权或熔断。 */
  markFailure?(providerId: string, reason: string): void
  /** 首选路由失败后给一条放宽约束的备用路由；返回空 = 没有退路，原错误直接抛给调用方。备用路由只再试一次，不递归降级。 */
  createRelaxedRoute?(
    route: TeamModelRouteResult,
    reason: string
  ): LooseOptional<TeamModelRouteResult>
}

/**
 * 会话输入车道：把用户在执行期间追发的消息按投递方式排队、择时放行。
 *
 * `steer`（插队引导）可一次全放，`queue`（普通发送）一次只放一条。不注入时用包内内存实现。
 * 全部方法的返回值都裹在 `KernelSessionInputStoreResult` 里，持久化实现可以是异步的。
 */
export interface KernelSessionInputStore {
  /** 受理一条新输入并分配会话内递增 seq；带 id 且内容完全相同的重复受理返回既有条目（幂等），内容不同则抛 INVARIANT。内容为空一律拒。 */
  admit(input: AdmitKernelSessionInput): KernelSessionInputStoreResult<KernelAdmittedInput>
  /** 列该会话全部输入（含已放行、已取消），按 seq 升序；无输入返回空数组。诊断与重放用。 */
  list(sessionId: string): KernelSessionInputStoreResult<KernelAdmittedInput[]>
  /** 数还没放行的输入条数；UI 的「待发送 N 条」与收尾门的「还有没有活」判断都读它。 */
  countPending(sessionId: string): KernelSessionInputStoreResult<number>
  /** 把待放行的 `steer` 输入整批转成已放行并返回它们；`options` 可限定单条 id 或只放行 seq 不超过某值的部分。无可放行时返回空数组。 */
  promoteSteers(
    sessionId: string,
    options?: PromoteKernelInputOptions
  ): KernelSessionInputStoreResult<KernelAdmittedInput[]>
  /** 放行下一条待处理的 `queue` 输入（只放一条，保持串行消费）；没有待放行的返回 null。 */
  promoteNextQueued(sessionId: string): KernelSessionInputStoreResult<Nullable<KernelAdmittedInput>>
  /** 取消待放行输入并返回取消条数；`inputId` 省略 = 取消该会话全部待放行的。已放行的不受影响。 */
  cancel(sessionId: string, inputId?: string): KernelSessionInputStoreResult<number>
  /** 丢掉该会话的全部输入记录并返回丢弃条数；会话被删除时调。 */
  dropSession(sessionId: string): KernelSessionInputStoreResult<number>
}

/** `.velarmod` 归档的签名验证端口。不注入 = 该宿主验不了签，带签名的包一律按 `signature.unsupported` 阻断导入。 */
export interface VelarModArchiveSignatureVerifier {
  /** 签名文件在归档里的路径；省略时用包内默认文件名。改它等于换一套签名布局，宿主与签名工具必须一致。 */
  readonly fileName?: string
  /**
   * 验一份签名是否覆盖了这批条目、且确实签的是这个 modId + version。
   *
   * 导入扫描时对带签名的归档调一次。通过返回签名密钥 id（只有声明 `marketplace-signed` 的包才会被采信），
   * 不通过返回可直接展示给用户的 `reason`；**不要抛错**，异常形状的签名同样应回 `{ ok: false }`。
   */
  verify(input: {
    readonly signature: unknown
    readonly modId: string
    readonly version: string
    readonly entries: readonly VelarModArchiveEntry[]
  }): { readonly ok: true; readonly keyId: string } | { readonly ok: false; readonly reason: string }
}

/**
 * 智能体技能提供方接口。
 *
 * 实现方负责按当前运行状态生成可用的技能列表；上层 AgentSkillRepository
 * 会按角色聚合并按 priority + id 稳定排序，多个 provider 同 id 时后者覆盖。
 *
 * `listSkills` 收敛为 `readonly AgentSkillDefinition[]`：
 *  - 上层会做缓存（基于 `getVersion()` 失效），迭代器会破坏缓存语义；
 *  - 实现方原本返回 Array 也兼容，纯遍历调用方无需改动。
 */
export interface AgentSkillProvider {
  /** 供应方唯一 id；同时也是「能否产出全文常驻技能」的授权主体——只有列进 `trustedRoleSkillProviderIds` 的 id 才被采信。 */
  readonly id: string
  /** 技能来源种类（内置 / 文件式 / mod 等）；用于 UI 分组与诊断，不参与可见性判定。 */
  readonly kind: AgentSkillSourceKind
  /** 供应方展示名，出现在技能管理界面上。 */
  readonly label: string
  /** 列出当前全部技能定义（含正文）；repository 每次 reload 调一次。返回数组而非迭代器是为了让上层能按版本缓存。 */
  listSkills(): readonly AgentSkillDefinition[]
  /** 读取已枚举的目录式技能资源；实现方必须再次校验相对路径是否属于该技能。 */
  readSkillResource?(skill: AgentSkillDefinition, resourcePath: string): Nullable<string>
  /**
   * 可选的版本号，repository 会用它判断是否需要重新加载技能集合。
   *
   * 返回 string 时必须随技能内容变化而变化（例如 hash 或 AgentSystemRuntimeConfig 引用），
   * 不实现则视为“总是变化”，repository 退回到每次都 reload 的旧行为。
   */
  getVersion?(): string
}

/**
 * 应用自述事实：宿主在启动时写入的进程级静态事实，直接进系统提示词。
 *
 * 目的是让模型一上来就知道自己跑在什么机器上，不用靠试探命令反推。
 * 只放真正静态的进程级事实；会话级或易变状态走回合上下文。全部字段都可能为 null——宿主没写就不渲染那一行。
 */
export interface AppRuntimeFacts {
  /** 应用版本号，如 "0.3.1"。 */
  appVersion: Nullable<string>
  /** 平台标识，如 "darwin" / "win32" / "linux"。 */
  platform: Nullable<string>
  /** CPU 架构，如 "arm64" / "x64"。 */
  arch?: LooseOptional<string>
  /** 操作系统版本，如 Darwin kernel release 或 Windows release。 */
  osRelease?: LooseOptional<string>
  /** 实际承载命令执行的 shell 路径。 */
  shell?: LooseOptional<string>
  /** 当前用户主目录。 */
  homeDir?: LooseOptional<string>
  /** userData 存储根目录（会话数据与本地索引等落盘位置的父目录）。 */
  userDataRoot: Nullable<string>
}

/**
 * 宿主为单次 Agent 执行注入的输入车道（用户执行中途追发消息的入口）。
 *
 * `takeOrSeal` 是收尾边界：要么交出一条已受理的 FIFO 输入、本次不收尾，要么原子地把车道封口。
 * 车道怎么排队、怎么受理归宿主与能力实现，Agent 运行时不拥有它。
 */
export interface AgentRuntimeInputPort {
  /** 取一条已受理的输入（FIFO），没有就返回 null；**不封口**，取完之后还能再进新输入。回合中途 drain 用。 */
  take(): Nullable<ModelMessage> | Promise<Nullable<ModelMessage>>
  /** 收尾边界：要么返回一条已受理输入（本次不封口，继续跑），要么原子地把车道关闭。两件事必须原子，否则会漏掉一条刚进来的输入。 */
  takeOrSeal(): AgentRuntimeInputResult | Promise<AgentRuntimeInputResult>
  /**
   * 订阅「请求飞行途中又来了新输入」，返回退订函数。
   *
   * 注册时如果已有待放行输入，listener 会被**同步**回放一次——这条正是用来堵住
   * 「回合开头刚 drain 完、请求还没发出去」那一档竞态的，去掉它就会丢输入。
   * 调用方必须在该次请求落定后立刻退订；工具执行是另一个事务边界，不复用这个订阅。
   */
  onInputAccepted(listener: () => void): () => void
}

/** 工具回执的后处理环节，由能力方提供：工具跑完之后、回执进模型面之前，再改一手。 */
export interface ToolResultMiddleware<TExecutionContext = unknown> {
  /** 中间件唯一 id；排序并列时用它做稳定次序的第二关键字，因此不能重复。 */
  id: string
  /** 排序权重，越小越先跑；省略按 0。同权重按 id 码元序，保证跨机器一致。 */
  priority?: number
  /** 是否处理这次回执；返回 false 直接跳过本中间件。不实现 = 每次都跑。 */
  matches?(context: ToolResultMiddlewareContext<TExecutionContext>): boolean
  /**
   * 后处理这次工具回执（补图、补说明、改写模型面内容），返回增量；返回空表示不改。
   *
   * 工具执行成功后按序跑一遍，链上每一环看到的是前一环处理过的结果。
   * 中止信号一到就整链停手——迟到的增量不会覆盖已经发出的真实回执。
   */
  transform(
    context: ToolResultMiddlewareContext<TExecutionContext>
  ): Promise<ToolResultMiddlewareResult | void> | ToolResultMiddlewareResult | void
}

/** 入参校验失败后的补救指引供应方，由能力方提供：告诉模型这次参数错在哪、该怎么改着再试。 */
export interface ToolValidationHintProvider {
  /** 供应方唯一 id；同 `ToolResultMiddleware.id`，参与稳定排序，不能重复。 */
  id: string
  /** 排序权重，越小越先问；省略按 0，同权重按 id 码元序。 */
  priority?: number
  /** 模型传错参数时给一条「该怎么改」的补救指引；返回空表示本供应方没有针对性建议，交给下一个。 */
  getRecovery(context: ToolValidationHintContext): ToolValidationRecovery | void
}

/**
 * 能力方自带的验证结论解释器：把某类工具的回执翻译成「这次验证过没过、证据是什么」。
 *
 * 编码会话据此判断验证是否通过、是否重复执行同一条验证、模型引用的证据是否属实。
 */
export interface CapabilityValidationInterpreter {
  /** 解释器唯一 id，参与稳定排序，不能重复。 */
  id: string
  /** 排序权重，越小越先问；省略按 0，同权重按 id 码元序。 */
  priority?: number
  /** 这个工具名归不归本解释器管；`isPassed` 与 `collect` 之前都先过它。 */
  matches(toolName: string): boolean
  /** 从回执里提取验证结论（成功/失败、问题清单、备注）；返回空表示这次回执不构成验证结论。 */
  collect(toolName: string, result: unknown): CapabilityValidationInterpretation | void
  /** 为一次验证调用算一个指纹，用来识别「同一条验证又跑了一遍」；返回空 = 不参与去重。 */
  fingerprint?(toolName: string, args: Readonly<Record<string, unknown>>): string | void
  /** 这次回执算不算「验证通过」；不实现时该解释器不表态，由其他解释器决定。 */
  isPassed?(toolName: string, result: unknown): boolean
  /** 模型引用的证据串与实际观察到的是否算同一条（容忍格式差异）；不实现 = 不参与证据比对。 */
  evidenceMatches?(cited: string, observed: string): boolean
}

/** 能力方的提示词贡献端口。传进来的运行快照形状对内核刻意保持不透明，由贡献者自己认领需要的字段。 */
export interface CapabilityPromptContributor {
  /** 贡献者唯一 id，参与稳定排序，不能重复。 */
  id: string
  /** 排序权重，越小越靠前；省略按 0，同权重按 id 码元序——段序直接就是提示词字节序，必须确定性。 */
  priority?: number
  /** 按当前运行快照产出要注入的提示词段；每次构建提示词调一次，必须是纯函数式的确定性输出，不要在这里做 IO。无贡献返回空数组。 */
  getSegments(snapshot: unknown): readonly PromptSegmentDefinition[]
}

/** 能力方自带的上下文采集器：每轮往工具上下文里补一块自己的数据，按 id 归档。 */
export interface CapabilityContextCollector {
  /** 采集器唯一 id；它同时是采集结果在上下文对象里的键名，因此不能重复。 */
  id: string
  /** 排序权重，越小越先跑；省略按 0，同权重按 id 码元序。 */
  priority?: number
  /** 采集本轮要补的上下文；全部采集器并发跑，任一抛错会让整次采集失败，所以实现要自己兜住可预期的失败。 */
  collect(
    messages: readonly unknown[],
    context?: Readonly<Record<string, unknown>>
  ): Promise<unknown> | unknown
}

/** 意图分类端口，归产品/能力方所有；Agent 只汇总通用信号，不认识各能力域的私有意图语义。 */
export interface CapabilityIntentClassifier {
  /** 分类器唯一 id，参与稳定排序，不能重复。 */
  id: string
  /** 排序权重，越小越先跑；省略按 0，同权重按 id 码元序。 */
  priority?: number
  /** 从用户文本里识别本能力域的意图信号（要不要发现、要不要证据、是否涉及改动）；识别不出返回空数组，别猜。 */
  classify(
    text: string,
    context?: CapabilityIntentClassifierContext
  ): readonly CapabilityIntentSignal[]
}

/**
 * 声明式的工具分配元数据。
 *
 * 分配器只认通用概念——类别、操作、前置条件、委派结论——具体业务语义留在各能力包里，
 * 它不去理解某个操作到底在干什么。全部字段可省略，省略即该项没有声明。
 */
export interface ToolAllocationMetadata {
  /** 无论分配器怎么算都要保底给模型的工具名；多个能力方声明的会取并集。 */
  baselineToolNames?: readonly string[]
  /** 操作 id → 需要开的工具类别。分配器据此把「模型想做的事」翻成「要开哪些类别」；同一 operationId 多方声明取并集。 */
  operationCategories?: Readonly<Record<string, readonly ToolCategoryId[]>>
  /** 操作 id → 委派结论（这件事不在本端做、该去哪做）。命中即拒绝分配并把 message 回给模型；多方声明时后装配者覆盖。 */
  delegatedOperations?: Readonly<Record<string, ToolAllocationDelegation>>
  /** 前置条件清单：某些类别要先满足某个事实 id 才能开。未满足时按 `denialCode` + `message` 拒绝；多方声明直接拼接。 */
  prerequisites?: readonly ToolAllocationPrerequisite[]
}

/**
 * 宿主提供的作用域策略。
 *
 * 内核把作用域 id 与事实 id 一律当不透明串，产品包独占全部作用域语义。
 * 整个装配只允许有一份生效的作用域策略（顶层给了就用顶层，否则扩展里最多只能有一个，多于一个直接抛错）。
 */
export interface CapabilityScopePolicy {
  /** 由运行事实定出本次执行的作用域 id；返回空串时读取方回落到事实里的声明值、再回落到 `'default'`。整个装配只允许有一个作用域策略生效。 */
  resolveScopeId(facts: CapabilityScopeRuntimeFacts): CapabilityScopeId
  /** 判定某个工具类别在当前作用域能不能开，拒绝时带上理由码与给模型看的文案。策略缺席时一律按放行处理。 */
  decideCategory(
    categoryId: ToolCategoryId,
    facts: CapabilityScopeRuntimeFacts
  ): CapabilityScopeCategoryDecision
  /** 把一批类别扩展成连带需要的类别（开 A 必须同时开 B）；不实现 = 原样返回。读取方会再去一次重。 */
  expandCategoryIds?(categoryIds: readonly ToolCategoryId[]): readonly ToolCategoryId[]
  /** 本作用域开局默认就开的类别；不实现 = 没有默认类别，全靠分配器按需开。 */
  getDefaultCategoryIds?(
    facts: CapabilityScopeRuntimeFacts,
    options?: Readonly<Record<string, unknown>>
  ): readonly ToolCategoryId[]
  /** 本作用域的常驻工具声明（常驻 / 排除 / 受保护不许摘）；不实现 = 空声明，即没有常驻集。 */
  getResidency?(facts: CapabilityScopeRuntimeFacts): CapabilityScopeResidency
}

/** 子 Agent 的工具面禁令：父 Agent 能用但不许传给子 Agent 的东西。缺省两项都空 = 不额外禁。 */
export interface CapabilityDelegationPolicy {
  /** 子 Agent 一律不可见的工具名；派发时按名剔除。 */
  blockedToolNames?: readonly string[]
  /** 子 Agent 一律不可开的工具类别；派发时按类别剔除，比按名更粗但更稳。 */
  blockedCategoryIds?: readonly ToolCategoryId[]
}

/**
 * 能力扩展的总注入面。
 *
 * 顶层字段与 `extensions` 里各能力包声明的同名字段会被合并：列表型按 priority + id 稳定排序（顶层的排在扩展之后），
 * 别名与分配元数据取并/后者覆盖，作用域策略全局只许有一份（多于一份直接抛错）。全部字段可省略，省略 = 该行为不存在。
 */
export interface AgentRuntimeCapabilityPorts {
  /** 各能力包（空间包 / mod）自带的一整套贡献；类别目录也从这里汇总，同 id 类别定义冲突时直接抛错。 */
  extensions?: readonly AgentRuntimeCapabilityExtension[]
  /** 工具名别名表（旧名 → 现名）；顶层声明覆盖扩展里的同名条目。模型用旧名调工具时靠它兜住。 */
  toolAliases?: Readonly<Record<string, string>>
  /** 工具回执后处理链；与扩展里的合并后按 priority 排序执行。 */
  resultMiddlewares?: ReadonlyArray<ToolResultMiddleware<any>>
  /** 入参校验失败时的补救指引供应方；按序询问，取第一个给得出建议的。 */
  validationHintProviders?: readonly ToolValidationHintProvider[]
  /** 验证结论解释器；编码会话据此判断验证有没有真过。 */
  validationInterpreters?: readonly CapabilityValidationInterpreter[]
  /** 提示词段贡献者；输出顺序即提示词字节顺序，必须确定性。 */
  promptContributors?: readonly CapabilityPromptContributor[]
  /** 每轮上下文采集器；结果按各自 id 归档进工具上下文。 */
  contextCollectors?: readonly CapabilityContextCollector[]
  /** 意图分类器；Agent 只合并通用信号，不认识各能力域的私有语义。 */
  intentClassifiers?: readonly CapabilityIntentClassifier[]
  /** 顶层的工具分配元数据；与扩展里的按字段各自合并（保底名单取并集、委派结论后者覆盖）。 */
  allocation?: ToolAllocationMetadata
  /** 顶层作用域策略；给了就直接用它，不再去扩展里找（扩展里有多于一个会抛错）。 */
  scopePolicy?: CapabilityScopePolicy
  /** 子 Agent 工具面禁令；两个名单都会去重后使用。 */
  delegationPolicy?: CapabilityDelegationPolicy
  /** 本次执行已满足的分配前置事实 id（宿主填，如「已连上调试器」「已选定资源根」）；分配器拿它和 `allocation.prerequisites` 对表。 */
  satisfiedAllocationPrerequisiteIds?: readonly string[]
}

/** 子 Agent 类型目录端口。Agent 运行时不内置任何工种分类，宿主必须注入一份完整目录。 */
export interface SubAgentTypeProvider {
  /** 模型没指定类型时用哪种子 Agent；宿主必须给一个真实存在的 id。 */
  readonly defaultTypeId: SubAgentTypeId
  /** 列出全部内置子 Agent 类型（含描述与默认只读位），进派发目录与提示词。 */
  listDescriptors(): readonly SubAgentTypeDescriptor[]
  /** 按 id 取类型描述；不存在返回 null——派发器据此报 NOT_FOUND，自定义 Agent 的 `base` 指不到时也会被跳过。 */
  getDescriptor(id: SubAgentTypeId): Nullable<SubAgentTypeDescriptor>
}

/** 工具注册表的「回合快照」能力：把本回合看到的工具面冻住，避免一轮之内工具清单变来变去。 */
export interface AgentTurnCapabilitySnapshotSource<TRegistry> {
  /** 冻结并返回本回合的工具面快照；每回合开头调一次。未实现此端口的 headless / 测试适配器会被直接当作快照使用，产品宿主必须实现。 */
  captureTurnCapabilitySnapshot(): AgentTurnCapabilitySnapshot<TRegistry>
}
