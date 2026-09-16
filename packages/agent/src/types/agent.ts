/**
 * `@velaros-ai/core/error` 的 `ErrorCode` 本地同名同形副本。
 *
 * 可移植数据文件不许 import，所以在这里留一份；两边一致由
 * `tests/capabilities/agent-portable-core-error-parity.test.ts` 守着。
 */
export type ErrorCode =
  | 'UNKNOWN'
  | 'NETWORK'
  | 'IPC'
  | 'PERMISSION'
  | 'PLATFORM'
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'TIMEOUT'
  | 'ASSERTION'
  | 'INVARIANT'
  | 'LOG_FAILURE'
  | 'LOG_ASSERTION'
  | (string & {})

/** `@velaros-ai/core/error` 的 `ErrorContext` 本地同名同形副本。 */
export type ErrorContext = Record<string, unknown>

/** `@velaros-ai/core/error` 的 `SerializedError` 本地同名同形副本。 */
export interface SerializedError {
  code: ErrorCode
  message: string
  context?: ErrorContext
}

export interface DebugModelMessage {
  role: string
  content: unknown
}

/**
 * Opaque prompt feature id registered by a product or capability package.
 *
 * **只表达「这项能力本轮开着」**。执行模式（目标 / 计划）不是能力，走 {@link ExecutionModeId}
 * 独立轴——2026-08-06 拆轴前它们挤在同一根数组里，于是「hook 省略 promptFeatures」这类漏传
 * 会同时丢掉能力与模式，而两者的回落语义本就不同（能力缺席=不开，模式缺席=回落会话粘性）。
 */
export type ChatPromptFeatureId = string

/**
 * 执行模式轴（封闭集）。
 *
 * 与 prompt feature 正交：feature 回答「哪些能力开着」，模式回答「这一轮按什么执行姿态跑」。
 * 官方预制两档，descriptor 单源见 `execution-modes/ExecutionModeRegistry`。
 */
export type ExecutionModeId = 'goal' | 'plan'

/** 迁移期字段已清空；新场景只使用 AgentSurfaceId。 */
export type AgentDeveloperContext = never

/** Opaque product surface id. */
export type AgentSurfaceId = string

export interface PromptSegmentTrace {
  id: string
  label?: string
  stability: 'stable' | 'dynamic'
  source: string
  priority: number
  text: string
}

export interface SkippedPromptSegmentTrace {
  id: string
  label?: string
  stability: 'stable' | 'dynamic'
  source: string
  priority: number
  reason: string
}

export interface RunProfileBudget {
  maxToolCount: Nullable<number>
  maxSystemPromptChars: Nullable<number>
  /**
   * 单次运行的累计输入工作集上限，独立于模型声明的物理 context window。
   * 大窗口模型仍需受 profile 认知/成本预算约束；达到上限后由 ContextOS 压缩和降级阶梯回收历史。
   */
  maxInputWorkingSetTokens: Nullable<number>
  /**
   * 本轮直接暴露给模型的工具 `JSON Schema` 总字节上限（含 `name`/`description`/`wrapper`）。
   * 作为“工具换页”的硬天花板：工具空间先按每个工具的实际 `schema` 占用做驻留集选择，
   * `maxToolCount` 只作为带容错的软护栏。
   * 为 `null` 表示不施加字节预算并退回 `maxToolCount` 裁剪。
   * 仅当调用方提供各工具的 `schema` 字节实测时才会生效。
   */
  maxToolSchemaChars: Nullable<number>
}

/**
 * 档位提供的**缺席默认**——不是覆盖。显式配置（`AgentExecutionConfig.thinkingDepth` 等）永远赢，
 * 档位只在那一格没给时兜底。
 *
 * 这里曾经还有一格 `modelRequestPolicy`（temperature / topP / maxOutputTokens，2026-08-06 删）：
 * 三档各声明了一组采样参数，全仓零读取点。档位描述宣称 compact/balanced/expanded 是「运行成本
 * 与发散度」三档，实际只有工具预算生效；调 temperature 的人在这里改半天没反应，把它接上去则
 * 会让所有用户的采样参数在某次发版后突然变了。判决：采样参数交模型/供应商默认，档位只管
 * 「本次运行允许长期携带多少」（工具面与提示词预算）。
 */
export interface RunProfileDefaults {
  thinkingDepth: ThinkingDepth
  toolSurfaceProfile: ToolSurfaceProfileId
}

export interface RunProfileDefinition {
  id: RunProfileId
  label: string
  description: string
  budget: RunProfileBudget
  defaults: RunProfileDefaults
  automaticToolCategories: readonly ToolCategoryId[]
}

export interface RunProfileRuntimePolicy {
  requested: RunProfileSelectionId
  profile: RunProfileId
  reason: string
  contextWindow: number
  defaults: RunProfileDefaults
  budget: RunProfileBudget
}

export interface ToolSchemaTelemetryPayload {
  currentProfile: ToolSurfaceProfileId
  baselineProfile: ToolSurfaceProfileId
  currentSerializedChars: number
  baselineSerializedChars: number
  savedChars: number
  overheadChars: number
  savedPercent: number
  currentEstimatedTokens: number
  baselineEstimatedTokens: number
  savedTokens: number
}

export interface RunProfileTelemetryPayload {
  profile: RunProfileId
  reason: string
  /** ContextOS 本轮实际采用的有界工作集窗口。 */
  contextWindow: Nullable<number>
  /** Provider/模型声明的物理窗口，不参与 profile 成本上限的替代。 */
  physicalContextWindow: Nullable<number>
  maxInputWorkingSetTokens: Nullable<number>
  maxToolCount: Nullable<number>
  maxSystemPromptChars: Nullable<number>
  baseAllowedToolCount: number
  exposedToolCount: number
  droppedToolCount: number
  droppedTools: string[]
  systemPromptChars: number
  promptTrimmedSegmentCount: number
}

export type AgentContextPhase = 'bootstrap' | 'operational'

export type AgentContextPhaseReason =
  | 'initial-interactive-request'
  | 'continued-provider-loop'
  | 'existing-conversation-history'
  | 'missing-user-request'
  | 'scheduled-task'
  | 'unattended-execution'
  /** 任一执行模式在场（目标 / 计划）。2026-08-06 拆轴前只有 goal 会命中，故旧名为 goal-mode。 */
  | 'execution-mode'
  | 'selected-skill'
  | 'selected-capability'
  | 'active-context'
  | 'pure-chat'

export interface AgentContextPhaseTelemetryPayload {
  phase: AgentContextPhase
  reason: AgentContextPhaseReason
  systemPromptChars: number
  allowedToolCount: number
  toolSchemaChars: number
  estimatedToolSchemaTokens: number
}

export interface TurnPlanningTelemetryPayload {
  turn: number
  runProfile: RunProfileId
  cacheHit: boolean
  signature: string
  durationMs: number
  categoryListCalls: number
  schemaEstimateCalls: number
  runtimeToolCategoryCount: number
  allocatorCatalogCategoryCount: number
  visibleEnabledCategoryCount: number
  toolSchemaCandidateCount: number
  estimatedToolSchemaChars: number
  toolSchemaBudgetScale: number
  residentToolCount: number
  droppedToolCount: number
  expiredToolNameLeases: string[]
  categorySummary: Array<{
    id: ToolCategoryId
    toolCount: number
  }>
}

export interface ToolAllocatorTelemetryPayload {
  advisorCalled: boolean
  advisorMessage: Nullable<string>
  advisorError: Nullable<string>
  fuseTripped: boolean
  fuseMessage: Nullable<string>
  grantedCategoryIds: ToolCategoryId[]
  grantedToolCount: number
  deniedRequests: Array<{
    operation: string
    categoryId: ToolCategoryId
    code: string
    message: string
  }>
  enableToolsPerSession: number
  dedupeHitCount: number
  invisibleToolCallCount: number
  confirmCardsPerSession: number
  toolsBlockCacheInvalidationRate: Nullable<number>
  turnsPerCompletedTask: Nullable<number>
}

export type ToolLayerTelemetryMetrics = Pick<
  ToolAllocatorTelemetryPayload,
  | 'enableToolsPerSession'
  | 'dedupeHitCount'
  | 'invisibleToolCallCount'
  | 'confirmCardsPerSession'
  | 'toolsBlockCacheInvalidationRate'
  | 'turnsPerCompletedTask'
>

export type ControlPlaneLedgerSource =
  | 'intent'
  | 'capability'
  | 'context'
  | 'prompt'
  | 'recovery'
  | 'verification'

export interface ControlPlaneLedgerEntry {
  id: string
  source: ControlPlaneLedgerSource
  action: string
  reason: string
  details?: Record<string, unknown>
}

export interface AgentTurnRouteIdentity {
  roleId: Nullable<AgentRoleId>
  workflowType: Nullable<WorkflowType>
  expectedOutput: Nullable<AgentRoleExpectedOutputKind>
}

export interface StreamTurnContextPayload {
  kind: 'turn-context'
  turn: number
  roleId: AgentRoleId
  roleLabel: string
  roleDescription: string
  workflowType: WorkflowType
  roleExpectedOutput: AgentRoleExpectedOutputKind
  activeSkillMarkdown: string
  roleRouteNote: string
  roleRuntimeModel: LooseOptional<{
    provider: string
    /** 用户/路由层选择的模型或档位。 */
    model: string
    /** 实际 provider 请求使用的底层模型；注入式网关可把逻辑档位解析成真实模型。 */
    providerModel?: LooseOptional<string>
    contextWindow?: LooseOptional<number>
    resolutionSource: string
    resolutionTrace: readonly unknown[]
    fallbackReason?: LooseOptional<string>
  }>
  systemPrompt: string
  devEnvironmentContext: Nullable<string>
  stableCutoff: number
  promptSegments: PromptSegmentTrace[]
  skippedPromptSegments: SkippedPromptSegmentTrace[]
  capabilityContextAudit: readonly unknown[]
  messages: DebugModelMessage[]
  allowedTools: string[]
  enabledToolCategories: ToolCategoryId[]
  contextPhaseTelemetry: AgentContextPhaseTelemetryPayload
  toolSchemaTelemetry?: LooseOptional<ToolSchemaTelemetryPayload>
  runProfileTelemetry?: LooseOptional<RunProfileTelemetryPayload>
  toolAllocatorTelemetry?: LooseOptional<ToolAllocatorTelemetryPayload>
  turnPlanningTelemetry?: LooseOptional<TurnPlanningTelemetryPayload>
  controlPlaneLedger?: ControlPlaneLedgerEntry[]
}

export interface StreamAssistantRawPayload {
  kind: 'assistant-raw'
  turn: number
  content: unknown
}

export type StreamWorkerThreadEventKind =
  | 'started'
  | 'status'
  | 'delta'
  | 'chat-event'
  | 'output'
  | 'completed'
  | 'failed'

export type StreamWorkerThreadChatEvent =
  | { type: 'runtime-state'; payload: StreamReconnectingPayload }
  | { type: 'reasoning-delta'; id: string; text: string }
  | {
      type: 'tool-start'
      toolCallId: string
      toolName: string
      args: Record<string, unknown>
      categoryId?: ToolCategoryId
    }
  | {
      type: 'tool-progress'
      toolCallId: string
      chunk: string
      timestamp?: number
    }
  | {
      type: 'tool-metadata'
      toolCallId: string
      title?: string
      metadata?: Record<string, unknown>
      timestamp?: number
    }
  | {
      type: 'tool-done'
      toolCallId: string
      result: unknown
      error?: string
      effects?: StreamToolResultEffects
      modelImage?: StreamToolResultModelImage
      modelContent?: ToolResultModelContentPart[]
    }
  | {
      type: 'notice'
      kind: string
      payload: unknown
    }

export interface StreamWorkerThreadPayload {
  kind: 'worker-thread'
  event: StreamWorkerThreadEventKind
  threadId: string
  /** 前端展示实例 id；同一个后端 threadId 被唤醒多次时，每次 activation 单独渲染。 */
  activationId?: LooseOptional<string>
  taskId?: LooseOptional<string>
  nodeId?: LooseOptional<string>
  title: string
  agentName?: LooseOptional<string>
  roleId?: LooseOptional<AgentRoleId>
  phase?: LooseOptional<TeamExecutionPhase>
  status?: LooseOptional<ExecutionTaskStatus>
  capabilityTarget?: LooseOptional<CapabilityTaskTarget>
  dag?: LooseOptional<PlanTaskDagContract>
  timestamp: number
  input?: LooseOptional<string>
  text?: LooseOptional<string>
  summary?: LooseOptional<string>
  error?: LooseOptional<string>
  chatEvent?: LooseOptional<StreamWorkerThreadChatEvent>
  /** dispatch schema v2：worker thread 投影使用的 sub-agent 类型 id（自定义 agent 为其 slug id）。 */
  subagentType?: LooseOptional<string>
  /** 文件式自定义 agent 的展示名；内置类型派发时为空，UI 用它替代 subagentType id 显示。 */
  customAgentName?: LooseOptional<string>
  /** dispatch schema v2：sync 表示主链路需要较快收束，async 表示长尾后台任务。 */
  mode?: LooseOptional<'sync' | 'async'>
  /** dispatch schema v2：已解析或覆写后的 model id。 */
  model?: LooseOptional<string>
  /** dispatch schema v2：可用时写入结构化任务结果。 */
  result?: LooseOptional<SubAgentTaskResult>
}

export type ToolExecutionPlanItemStatus = ExecutionTaskPlanStepStatus | 'in_progress'

export interface ToolExecutionPlanItem {
  id?: string
  step: string
  objective?: string
  status: ToolExecutionPlanItemStatus
  roleId?: AgentRoleId
  kind?: ExecutionTaskPlanStep['kind']
  mode?: ExecutionTaskPlanStep['mode']
  dependsOn?: string[]
  required?: boolean
}

export interface ToolExecutionPlanUpdate {
  explanation?: LooseOptional<string>
  lifecycle?: 'active' | 'paused' | 'completed' | 'archived'
  plan: ToolExecutionPlanItem[]
}

/**
 * 一次确认请求的**结构化信封**（生产者与渲染层共用的单源）。
 *
 * 旧形态只有一根散文 `message`，渲染层想画结构卡就只能反解中文字面量
 * （`if (lines[0] === '<某类授权请求标题>')` 一类的字面量比对）：提示文案改一个字，结构卡就静默退化成一行灰字，
 * 没有任何门会红；写死的简体中文也让 en-US 永远触发不到结构布局。所以身份走本联合的 `kind`，
 * 字段由生产者声明，`message` 降级为**兜底散文**——kind 缺席（旧会话存档、模型自由撰写的确认）
 * 或渲染层不认识该 kind 时按散文渲染，永远不会白屏。
 *
 * 新增 kind 的规矩：**生产者与渲染分支同一批改**。只加类型不加生产者 = 死枝；
 * 只加生产者不加分支 = 自动回落散文（安全，但结构信息白丢）。
 */
export type ConfirmationRequestDetail = {
  authorization?: { label: string; target?: string; requester?: string; scope: 'call' | 'task-operation' }
} & (
  | { kind: 'operation-authorization' }
  | {
      /** 会话级工具类别授权：批准后本会话同类工具不再重复询问。 */
      kind: 'tool-category-authorization'
      categoryId: string
      categoryLabel: string
      toolName: string
    }
  | {
      /** 外部 MCP 服务器上的一次工具调用。 */
      kind: 'mcp-tool-call'
      serverName: string
      toolName: string
      argumentsPreview?: string
      approvalScope?: 'call' | 'session-tool' | 'task-operation'
    }
  | {
      /** 模型自动读取一份非内置技能的正文。 */
      kind: 'skill-load'
      skillId: string
      label: string
      description?: LooseOptional<string>
    }
)

export interface ToolConfirmationDecisionOptions {
  /** 同一操作的稳定身份；跨工具入口应使用相同 key，不能包含展示用的截断参数。 */
  operation?: { key: string; label: string; target?: string }
  /** 发起审批的 Agent；授权归属仍是当前任务。 */
  requester?: { agentId: string; label?: string }
  /** 需要用户亲自点击确认；不能被会话风险确认自动批准短路。 */
  requireManualApproval?: boolean
  /** 本次确认的风险等级；未声明时按高风险处理。 */
  approvalRisk?: ToolApprovalRiskLevel
  /** 本会话内可复用的稳定风险分类；相同 scope 用户批准一次后可自动放行。 */
  riskScope?: string
  /** 是否在用户批准后记住 riskScope；默认记住，manual confirmation 不会被记住或复用。 */
  rememberRiskScope?: boolean
  /** 使用一组通用用户动作卡片渲染本次确认。 */
  userActionCards?: UserActionCard[]
  /** 本次确认的结构化信封；缺席时渲染层按 `message` 散文兜底。 */
  detail?: ConfirmationRequestDetail
}

/** 一次工具执行审批的结构化决策（审批通道与 execution 确认机制共用的单一形状）。 */
export interface ApprovalDecision {
  /** 是否放行本次操作。 */
  approved: boolean
  /** 拒绝原因或用户批注；无则为 null。 */
  message: Nullable<string>
  /** 是否由策略自动放行（standard-open 低风险等），未经用户交互。 */
  autoApproved?: boolean
  /** 当前任务已拒绝过同一操作，本次未再次展示确认卡。 */
  previouslyDenied?: boolean
}

/** 当前任务审批事实；内部操作 key 不投影给界面。 */
export interface TaskApprovalRecord {
  id: string
  label: string
  target?: string
  requester?: { agentId: string; label?: string }
  status: 'approved' | 'denied' | 'revoked'
  reason?: string
  decidedAt: number
}

export interface StreamToolResultEffects {
  /** Capability-owned context invalidation signal. */
  contextInvalidated?: boolean
  /** Whether the capability changed an external resource. */
  resourceChanged?: boolean
  /** Opaque resource identity associated with the change. */
  changedResourceId?: string
  metadata?: Readonly<Record<string, unknown>>
}

export interface StreamToolResultModelImage {
  data: string
  mediaType: 'image/png' | 'image/jpeg'
}

/**
 * Provider-neutral content blocks that a tool result can expose directly to the next model turn.
 * Binary data is base64 encoded and kept outside the ordinary textual result so serialization and
 * context compaction never turn media bytes into JSON text.
 */
export type ToolResultModelContentPart =
  | { type: 'text'; text: string }
  | { type: 'image-data'; data: string; mediaType: string }
  | { type: 'file-data'; data: string; mediaType: string; filename?: string }

export interface StreamAssistantGeneratedFilePayload {
  id: string
  mediaType: string
  data: string
  size: number
  filename?: string
}

export interface StreamAssistantSourcePayload {
  id: string
  sourceType: 'url'
  url: string
  title?: string
}

export type AgentEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; id: string; text: string }
  | { type: 'assistant-generated-file'; payload: StreamAssistantGeneratedFilePayload }
  | { type: 'assistant-source'; payload: StreamAssistantSourcePayload }
  | { type: 'turn-context'; payload: StreamTurnContextPayload }
  | { type: 'assistant-raw'; payload: StreamAssistantRawPayload }
  | { type: 'worker-thread'; payload: StreamWorkerThreadPayload }
  | { type: 'runtime'; payload: ChatRuntimeEvent }
  | {
      type: 'tool-start'
      toolCallId: string
      toolName: string
      args: Record<string, unknown>
      /** 工具所属类别，后端注入 */
      categoryId?: ToolCategoryId
    }
  | {
      type: 'tool-progress'
      toolCallId: string
      chunk: string
      timestamp?: number
    }
  | {
      type: 'tool-metadata'
      toolCallId: string
      title?: string
      metadata?: Record<string, unknown>
      timestamp?: number
    }
  | {
      type: 'tool-done'
      toolCallId: string
      result: unknown
      error?: string
      /** 工具副作用语义，后端计算后附加 */
      effects?: StreamToolResultEffects
      /** 工具提供给模型读取的图片数据，renderer 用它做聊天内预览。 */
      modelImage?: StreamToolResultModelImage
      /** 工具提供给下一模型轮次的有序文本、图片与文件内容块。 */
      modelContent?: ToolResultModelContentPart[]
    }
  | {
      type: 'notice'
      /** notice 种类 */
      kind: string
      /** notice 载荷，根据 kind 取不同类型 */
      payload: unknown
    }

/** Opaque permission id registered by a capability package or host. */
export type ToolPermission = string

export type ToolSurfaceProfileId = string

export interface ToolSurfaceProfileDefinition {
  id: ToolSurfaceProfileId
  label: string
  description: string
}

export type ToolOsState = 'resident' | 'loadable' | 'needs_setup' | 'unavailable'

export type ToolCategoryDomainId = string

export interface ToolCategoryOsDefinition {
  /** `ToolOS` v2 的产品域分组。这不是权限边界。 */
  domain: ToolCategoryDomainId
  /** AI 在查看每页运行态门控前应考虑的粗粒度状态。 */
  defaultState: ToolOsState
}

/**
 * Cross-domain side-effect vocabulary interpreted by Agent, approval hosts, and evaluators.
 * Domain-specific access semantics belong in capability metadata instead of this field.
 */
export type ToolCapabilityEffectKind =
  | 'read'
  | 'write'
  | 'execute'
  | 'external'
  | 'destructive'

export type ToolCapabilitySourceScope = string

export type ToolCapabilityFilesystemScope = string

export type ToolCapabilityConcurrency = 'safe' | 'unsafe' | 'input-dependent'

export interface ToolCapabilityTransactionSchema {
  /** 参数里承载 transaction id 的字段名；用于动态判断是否声明了事务 scope。 */
  scopeFields?: readonly string[]
  /** scoped validate 是否视为 apply 前校验。 */
  preApplyValidationWhenScoped?: boolean
}

export interface ToolCapabilitySchema {
  /** 工具的主要副作用类别。 */
  effectKind: ToolCapabilityEffectKind
  /** 工具可能读取的信息域。 */
  readScopes?: readonly ToolCapabilitySourceScope[]
  /** 工具可能写入或控制的信息域。 */
  writeScopes?: readonly ToolCapabilitySourceScope[]
  /** 文件系统读写边界；any 只应用于显式系统文件读写能力。 */
  filesystem?: {
    read?: ToolCapabilityFilesystemScope
    write?: ToolCapabilityFilesystemScope
  }
  /** Capability-defined transaction identity fields. */
  transaction?: ToolCapabilityTransactionSchema
  /** 进程执行形态。 */
  process?: {
    execution?: 'none' | 'short' | 'long-running' | 'dangerous' | 'input-dependent'
  }
  concurrency?: ToolCapabilityConcurrency
  canReadArbitrarySource?: boolean
  reason?: string
  /** Capability-owned data that Kernel never interprets. */
  metadata?: Readonly<Record<string, unknown>>
}

/** Opaque category id registered by a capability package. */
export type ToolCategoryId = string

/**
 * Opaque runtime scope identifier.
 *
 * Core deliberately does not define product scopes. Capability packages register
 * their own scope ids and policies at the composition root.
 */
export type CapabilityScopeId = string

export type ToolAvailabilityScope = 'enabled' | 'all' | 'system-enabled' | 'catalog'

export type ToolProviderKind = string

export interface ToolProviderDescriptor {
  id: string
  kind: ToolProviderKind
  label: string
  enabled: boolean
  toolCount: number
}

export interface ToolCategoryDefinition {
  id: ToolCategoryId
  label: string
  description: string
  toolOs: ToolCategoryOsDefinition
}

export type ToolExposureTier =
  | 'essential'
  | 'common'
  | 'situational'
  | 'specialized'
  | 'experimental'

export interface ToolExposureProfilePolicy {
  /**
   * 历史「直接暴露」标记。已移除「只换入」的结构件层后，候选是普遍的、不再据此隐藏工具，
   * 该字段仅作兼容保留（当前不被准入逻辑读取）。是否常驻由 alwaysResident + 预算决定。
   */
  expose?: boolean
  /** 在该 profile 下预驻留到模型外层工具空间，不参与普通 page budget 裁剪。 */
  alwaysResident?: boolean
  /** 在该 profile 下调整排序；负数更靠前，正数更靠后。 */
  rankBoost?: number
}

export interface ToolExposurePolicy {
  /** 粗粒度使用频率/稳定性分层；运行模式预算优先保留更高层级。 */
  tier?: ToolExposureTier
  /** 同 tier 内的稳定排序；数字越小越优先。 */
  rank?: number
  /**
   * 运行态内核工具：已授权时始终直接暴露完整 `schema`，不参与普通工具页 `maxToolCount` 裁剪。
   * 当前工具空间启动盘只保留查询与换页入口；其它 `profile` 级常驻工具通过 `profiles[].alwaysResident` 预留。
   */
  alwaysResident?: boolean
  /** 针对某个运行模式的直接暴露/排序覆盖。 */
  profiles?: Partial<Record<RunProfileId, ToolExposureProfilePolicy>>
}

export type ToolRenderKind = string

export type ToolActivityKind = string

/** Provider-neutral model input kinds used by model runtimes and tool requirements. */
export type AgentModelInputModality = 'text' | 'image' | 'audio'

export interface ToolRenderMetadata {
  /** 紧凑工具行 / 默认工具渲染主图标的视觉语义。 */
  leadingKind?: ToolRenderKind
  /** 对话聚合摘要使用的活动语义，同一工具可同时属于多个摘要类别。 */
  activityKinds?: readonly ToolActivityKind[]
  /** 是否使用专用工具渲染器，而不是普通工具行。 */
  dedicatedRender?: boolean
}

export interface ToolMetadata {
  /** 工具的产品归属类别；用于覆盖物理集合带来的默认分类。 */
  categoryId?: ToolCategoryId
  /** 内部工具的统一暴露策略；provider 仍可通过 descriptor.exposure 覆盖。 */
  exposure?: ToolExposurePolicy
  /** UI 展示、图标和工具活动摘要语义。 */
  render?: ToolRenderMetadata
  /** 该工具需要的聊天输入 feature / 插件开关。 */
  promptFeatureGate?: ChatPromptFeatureId
}

/**
 * 工具角色：刻画工具对外部世界的作用面，用于子 Agent 暴露收窄与读改分离归类。
 * 与 tool-contract 的 ToolContractRole 同源（后者直接别名到此），避免 core 内部循环依赖。
 */
export type ToolRole = string

export interface ToolDescriptor {
  descriptorId?: string
  name: string
  description: string
  /** 工具角色；control 类（如派发子 Agent）不会暴露给子 Agent。 */
  role?: ToolRole
  permissions: ToolPermission[]
  capabilities?: ToolCapabilitySchema
  /** Inputs the selected model must accept before this tool may enter discovery or execution. */
  requiredModelInputModalities?: readonly AgentModelInputModality[]
  /** 内置工具默认走 ToolMetadataCatalog；provider 可用此字段覆盖或补充暴露策略。 */
  exposure?: ToolExposurePolicy
  /** companion skill id（工具是调用面、技能是用法面）；工具页卡片据此指路。 */
  usageSkillId?: string
  /** 输出必须保持内联、禁止 page-out 成 payload 引用（发现/索引类工具，如 tooling:map）。 */
  outputInline?: boolean
  categoryId: ToolCategoryId
  systemEnabled: boolean
  providerId?: string
  providerKind?: ToolProviderKind
  registrationStatus?: 'active' | 'overridden'
  overriddenByProviderId?: string
  overriddenByProviderKind?: ToolProviderKind
}

export interface ToolCategoryOverview {
  category: ToolCategoryDefinition
  enabled: boolean
  tools: ToolDescriptor[]
}

export interface ToolOverview {
  enabledCategories: ToolCategoryId[]
  disabledToolNames: string[]
  providers: ToolProviderDescriptor[]
  categories: ToolCategoryOverview[]
  totalTools: number
}

export interface CapabilityAutoApprovalNotice {
  id: string
  categories: ToolCategoryId[]
  promptFeatures: string[]
  reason: string
  message: string
  approvedAt: number
}

export interface CapabilityAutoApprovalNoticeBlock {
  type: 'capability-auto-approval'
  notice: CapabilityAutoApprovalNotice
}

export type UserActionCardTone = 'info' | 'warning' | 'success' | 'danger'

export type UserActionCardIcon = string

export type UserActionCardActionIcon = string

export interface UserActionCardTextInput {
  placeholder?: string
  required?: boolean
  maxLength?: number
}

export type UserActionFormFieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'select'
  | 'radio'
  | 'checkbox'
  | 'checkboxes'

export type UserActionFormValue = string | number | boolean | string[]

export interface UserActionFormOption {
  value: string
  label: string
  description?: string
  /** 模型推荐项：渲染时显示"推荐"标记，帮用户在拿不准时有个默认倾向。 */
  recommended?: boolean
}

export interface UserActionFormField {
  id: string
  type: UserActionFormFieldType
  label: string
  required?: boolean
  placeholder?: string
  help?: string
  options?: UserActionFormOption[]
  min?: number
  max?: number
  step?: number
  maxLength?: number
  defaultValue?: UserActionFormValue
}

export interface UserActionForm {
  layout?: 'stack' | 'grid'
  submitLabel?: string
  cancelLabel?: string
  fields: UserActionFormField[]
  /**
   * 展示形态。'wizard' 表示把 fields 按问题分页，用左右切换的轮播逐题作答、全部填完后统一提交。
   * 仅 ask_user 提问卡使用；省略时按普通表单一次性平铺渲染。
   */
  presentation?: 'wizard'
}

export interface UserActionCardEnablePromptFeaturesAction {
  kind: 'enable_prompt_features'
  label: string
  completedLabel?: string
  icon?: UserActionCardActionIcon
  promptFeatures: string[]
  completedDescription?: string
  disableAfterClick?: boolean
}

export interface UserActionCardAcknowledgeAction {
  kind: 'acknowledge'
  label: string
  completedLabel?: string
  icon?: UserActionCardActionIcon
  completedDescription?: string
  disableAfterClick?: boolean
}

export interface UserActionCardRejectAction {
  kind: 'reject'
  label: string
  completedLabel?: string
  icon?: UserActionCardActionIcon
  completedDescription?: string
  disableAfterClick?: boolean
  input?: UserActionCardTextInput
}

export interface UserActionCardSubmitInputAction {
  kind: 'submit_input'
  label: string
  completedLabel?: string
  icon?: UserActionCardActionIcon
  completedDescription?: string
  disableAfterClick?: boolean
  input: UserActionCardTextInput
}

export interface UserActionCardSubmitFormAction {
  kind: 'submit_form'
  label: string
  completedLabel?: string
  icon?: UserActionCardActionIcon
  completedDescription?: string
  disableAfterClick?: boolean
}

export type UserActionCardAction =
  | UserActionCardEnablePromptFeaturesAction
  | UserActionCardAcknowledgeAction
  | UserActionCardRejectAction
  | UserActionCardSubmitInputAction
  | UserActionCardSubmitFormAction

export interface UserActionCardResult {
  cardId: string
  actionKind: UserActionCardAction['kind'] | 'timeout' | 'skip'
  approved: boolean
  message?: string
  values?: Record<string, UserActionFormValue>
  timedOut?: boolean
}

export interface UserActionCard {
  id: string
  title: string
  description: string
  tone: UserActionCardTone
  icon: UserActionCardIcon
  blocking: boolean
  actions: UserActionCardAction[]
  /** 卡片关联的可查看文件；方案评审等宿主流程用它打开 Markdown 产物。 */
  artifact?: {
    path: string
    label?: string
  }
  form?: UserActionForm
  timeoutMs?: number
  createdAt: number
}

/**
 * 卡片结算记录：一张卡「是否已作答」的**唯一权威**，随会话存档落盘在对应 block 上。
 *
 * 渲染层不得再自持第二份「已消费」状态（localStorage / 组件 useState）：那些都不跟着存档走，
 * 换台机器或清一次渲染层本地存储就让历史卡整片复活成可点状态，审批也留不下痕。
 */
export interface ConversationCardResolution {
  actionKind: UserActionCardAction['kind'] | 'timeout' | 'skip'
  approved: boolean
  message?: string
  values?: Record<string, UserActionFormValue>
  timedOut?: boolean
  settledAt: number
}

export interface UserActionCardBlock {
  type: 'user-action-card'
  card: UserActionCard
  /** 结算记录（单源）：有值即「已作答」，渲染层只读它。 */
  resolution?: ConversationCardResolution
}

export type JsonObject = Record<string, unknown>

/** 当前会话可见历史的线性边界。 */
export interface SessionLineageContext {
  sessionId: string
  activeBranchId?: LooseOptional<string>
  visibleBranchIds?: string[]
  activeCheckpointId?: LooseOptional<string>
  cutoffTimestamp?: LooseOptional<number>
}

export type ThinkingDepth = 'fast' | 'balanced' | 'deep'

export type ReasoningLevel = 'off' | 'low' | 'medium' | 'high' | 'ultra'

/** Product-owned execution phase and worker identifiers. */
export type TeamExecutionPhase = string

export type TeamWorkerType = string

export type TeamModelRouteCategory = string

export interface CapabilityTaskTarget {
  scopeId: string
  resourceId?: string
  metadata?: Readonly<Record<string, unknown>>
}

export interface PlanTaskContract {
  inputs: string[]
  expectedOutputs: string[]
  dependencies: string[]
  artifactSchema: string
  summaryPrompt: string
}

export interface PlanTaskDagContract extends PlanTaskContract {
  nodeId: string
  dependencySummaries: Array<{
    nodeId: string
    summary: string
  }>
  latestSummary?: LooseOptional<string>
}

/** Opaque model-routing trace published for diagnostics. */
export interface TeamModelSelectionTrace {
  category: TeamModelRouteCategory
  providerId: string
  model: string
  reason: string
  timestamp: number
  metadata?: Readonly<Record<string, unknown>>
}

export interface StreamPhasePayload {
  kind: 'phase'
  teamPhase: TeamExecutionPhase
}

export type ChatContextUsageAccountingSource =
  | 'provider'
  | 'provider-count'
  | 'gateway-cost'
  | 'local-estimate'

export type ChatContextUsageAccountingConfidence = 'high' | 'medium' | 'low'

export type ChatContextEvidenceKind =
  | 'file-read'
  | 'file-change'
  | 'command-output'
  | 'verification'
  | 'artifact'
  | 'generic'

export type ChatContextEvidenceImportance = 'pinned' | 'high' | 'medium' | 'low'

export type ChatContextEvidenceFreshness = 'fresh' | 'stale' | 'unknown'

export type ChatContextEvidenceLifecycle =
  | 'active'
  | 'pinned'
  | 'consumed'
  | 'verified'
  | 'demoted'
  | 'stale'
  | 'reread-required'

export interface ChatContextEvidenceRecord {
  id: string
  toolCallId: string
  toolName: string
  kind: ChatContextEvidenceKind
  importance: ChatContextEvidenceImportance
  lifecycle: ChatContextEvidenceLifecycle
  createdAt: number
  summary: string
  path?: LooseOptional<string>
  revision?: LooseOptional<string>
  contentHash?: LooseOptional<string>
  excerpt?: LooseOptional<string>
  fullPayloadRef?: LooseOptional<string>
  freshness?: LooseOptional<ChatContextEvidenceFreshness>
  score?: LooseOptional<number>
  metadata?: Record<string, unknown>
}

export interface StreamUsageTelemetryPayload {
  kind: 'usage-telemetry'
  turn: Nullable<number>
  provider?: LooseOptional<string>
  model: string
  inputTokens: Nullable<number>
  outputTokens: Nullable<number>
  visibleOutputTokens?: LooseOptional<number>
  totalTokens: Nullable<number>
  reasoningTokens: Nullable<number>
  cachedInputTokens?: LooseOptional<number>
  cacheReadInputTokens?: LooseOptional<number>
  cacheWriteInputTokens?: LooseOptional<number>
  costUsd?: LooseOptional<number>
  /** provider finish/finish-step 上报的结束原因(截断/异常关流诊断的唯一持久化出口)。 */
  finishReasons?: LooseOptional<string[]>
  rawFinishReasons?: LooseOptional<string[]>
  source: ChatContextUsageAccountingSource
  confidence: ChatContextUsageAccountingConfidence
  timestamp: number
}

export type StreamContextUsageEstimateSource = 'provider-request-compiler'

export type StreamContextUsagePressureKind =
  | 'none'
  | 'tokens'
  | 'payload'
  | 'tool-schema'
  | 'mixed'

export interface StreamContextUsageZoneDiagnostic {
  zone: string
  usedTokens: number
  effectiveLimitTokens: number
  overBudgetTokens: number
  reclaimOrder: string[]
}

export interface StreamContextUsageLedgerEntry {
  id: string
  zone: string
  chars: number
  estimatedTokens: number
  action: string
  reason: string
  toolCallId?: string
  toolName?: string
  hash?: string
  ref?: string
  zoneReservedTokens?: number
  zoneLimitTokens?: number
  zoneEffectiveLimitTokens?: number
  zoneUsedTokens?: number
  zoneOverBudgetTokens?: number
}

/**
 * 上下文治理（v2 驻留账本）逐轮状态：main 进程的治理器是唯一权威，本块是它推给渲染层的**只读**投影。
 *
 * 运行时按完整请求的可用容量自动治理；渲染层展示结果。`handoffArmed` 提供诊断依据，
 * 实际交接由显式工具请求并经用户批准。
 */
export interface StreamContextGovernanceState {
  /** 已应用过的治理 epoch 代数（= 缓存被重建过几次）。 */
  epoch: number
  /** 本轮治理后的账本投影占用百分比（占治理窗口 G）。 */
  occupancyPercent: Nullable<number>
  /** 本轮是否真的跑了一次 epoch 并应用了迁移。 */
  epochApplied: boolean
  /** 本轮 epoch 的节省率（未跑 epoch 时为 null）。 */
  epochSavingPercent: Nullable<number>
  /** 转交信号：连续低收益 epoch 且压不下去 → 建议开新会话续跑。 */
  handoffArmed: boolean
  /** 最近若干次 epoch 的节省率（新→旧），转交判据的原始证据。 */
  recentSavingPercents: number[]
  /** 最近一次 epoch 之后的占用百分比；从未跑过 epoch 时为 null。 */
  lastEpochAfterPercent: Nullable<number>
  handoffReason: Nullable<string>
  /**
   * I2 蒸馏的逐轮分账。
   *
   * 自动治理的结果通过逐轮流事件输出，覆盖容量回收和提供商超限恢复。
   * 本轮没有应用治理时分账为零值或 `null`，累计报告保留各次治理的来源与收益。
   */
  distill: StreamContextDistillState
}

/**
 * 逐轮 I2 分账（{@link StreamContextGovernanceState} 的一块）。
 *
 * `mode` / `skipReason` 刻意是 `string` 而不是联合类型：档位与跳过原因的权威联合住在
 * `@velaros@velaros-ai/agent` 的治理层，core 是它下游的契约包，复制一份联合等于给同一个枚举做两份
 * 定义，漂移时消费方还以为自己拿到了强类型。这里只承诺"是个可读的标签"。
 */
export interface StreamContextDistillState {
  /** 档位标签：`off` | `aux` | `main` | `adaptive`。 */
  mode: string
  /** 本轮 epoch 应用的产物条数（0 = 本轮没有产物落地）。 */
  appliedProducts: number
  /** 应用产物的器械分布：`distill` = 模型产物过验证，`skeleton` = 拒收后的规则回落。 */
  appliedByInstrument: { distill: number; skeleton: number }
  /** 本轮 epoch 之后是否规划了新的蒸馏。 */
  planned: boolean
  /** 未规划的原因标签（`off` / `no-distiller` / `in-flight` / `target-reached` / `no-segment` / `not-worth` …）。 */
  skipReason: Nullable<string>
  /** 会话累计计数（跨 epoch 单调，采样任意一轮都能看到全貌）。 */
  totals: {
    requested: number
    accepted: number
    rejected: number
    timedOut: number
    failed: number
    staleDropped: number
  }
}

export interface StreamContextUsageEstimatePayload extends ContextUsageEstimate {
  kind: 'context-usage-estimate'
  turn: Nullable<number>
  model: string
  source: StreamContextUsageEstimateSource
  pressureKind: StreamContextUsagePressureKind
  ledger: StreamContextUsageLedgerEntry[]
  zoneDiagnostics?: StreamContextUsageZoneDiagnostic[]
  requestFingerprint?: unknown
  /** 治理状态投影（v2）。编译器未持有治理会话时缺省。 */
  governance?: LooseOptional<StreamContextGovernanceState>
  timestamp: number
}

export interface StreamTurnStartPayload {
  kind: 'turn-start'
  turn: number
}

export interface StreamTurnEndPayload {
  kind: 'turn-end'
  turn: number
}

export interface StreamReconnectingPayload {
  kind: 'reconnecting'
  attempt: number
  maxAttempts?: LooseOptional<number>
  message?: LooseOptional<string>
}

export interface StreamRetryingTurnPayload {
  kind: 'retrying-turn'
  turn: number
  attempt: number
  maxAttempts?: LooseOptional<number>
  message?: LooseOptional<string>
}

export interface StreamDonePayload {
  kind: 'done'
  message?: string
  verification?: StreamVerificationSummary
  goalStatus?: 'active' | 'paused' | 'complete' | 'blocked' | 'cancelled' | 'removed'
}

export interface StreamVerificationSummary {
  status: 'not-run' | 'stale' | 'passed' | 'failed' | 'timed-out' | 'aborted' | 'unknown'
  command?: string
  issues?: string[]
}

/** 运行中输入已从接收队列进入本轮历史，身份沿用用户消息。 */
export interface StreamInputAppliedPayload {
  kind: 'input-applied'
  inputId: string
}

export interface StreamAbortedPayload {
  kind: 'aborted'
  message: string
  executionId?: string
  code?: ErrorCode
}

export interface StreamErrorPayload {
  kind: 'error'
  message: string
  code?: ErrorCode
  context?: ErrorContext
}

export interface StreamAwaitingConfirmationPayload {
  confirmationId?: string
  kind: 'awaiting-confirmation'
  executionId: string
  /** 兜底散文：模型自由撰写的确认文案，或结构化 detail 的降级表述。 */
  confirmationMessage: string
  userActionCards?: UserActionCard[]
  /** 结构化信封（生产者声明）；缺席时渲染层按 `confirmationMessage` 兜底。 */
  confirmationDetail?: ConfirmationRequestDetail
}

export interface StreamAwaitingInputPayload {
  kind: 'awaiting-input'
  executionId: string
  question: string
}

export type ChatRuntimeEvent =
  | StreamInputAppliedPayload
  | StreamPhasePayload
  | StreamUsageTelemetryPayload
  | StreamContextUsageEstimatePayload
  | StreamTurnStartPayload
  | StreamTurnEndPayload
  | StreamReconnectingPayload
  | StreamRetryingTurnPayload
  | StreamDonePayload
  | StreamAbortedPayload
  | StreamErrorPayload
  | StreamAwaitingConfirmationPayload
  | StreamAwaitingInputPayload

export type StreamStateKind = ChatRuntimeEvent['kind']

export type StreamStatePayload = ChatRuntimeEvent

export type TerminalStreamRuntimeStateKind = 'done' | 'aborted' | 'error'

export type StreamFailureRuntimeStateKind = 'error' | 'aborted'

/** JSON Schema 子集。运行时会在编译前执行深度、字段数、关键字和字节上限检查。 */
export type AgentOutputJsonSchema = Record<string, unknown>

export type AgentWorkflowValuePath = Array<string | number>

export type AgentWorkflowFailurePolicy = 'collect' | 'fail_fast'

export type AgentWorkflowPredicateOperator = 'eq' | 'neq' | 'in' | 'exists' | 'gte' | 'lte'

export type AgentWorkflowRunStatus = 'completed' | 'partial' | 'failed' | 'budget_exhausted' | 'aborted'

export type AgentWorkflowAgentStatus = 'completed' | 'failed' | 'aborted' | 'skipped'

export interface AgentWorkflowValueRef {
  step_id: string
  path?: AgentWorkflowValuePath
}

export interface AgentWorkflowPredicate {
  path: AgentWorkflowValuePath
  op: AgentWorkflowPredicateOperator
  value?: unknown
}

export interface AgentWorkflowAgentCall {
  id: string
  agent_name?: string
  prompt: string
  description?: string
  subagent_type?: string
  tool_scope?: 'type_default' | 'inherit' | 'custom'
  tool_categories?: string[]
  readonly?: boolean
  model?: string
  route_category?: string
  attachments?: string[]
  output_schema: AgentOutputJsonSchema
}

export interface AgentWorkflowParallelStep {
  id: string
  operation: 'parallel'
  calls: AgentWorkflowAgentCall[]
  failure_policy?: AgentWorkflowFailurePolicy
}

export interface AgentWorkflowPipelineStep {
  id: string
  operation: 'pipeline'
  items: unknown[]
  stages: AgentWorkflowAgentCall[]
  failure_policy?: AgentWorkflowFailurePolicy
}

export type AgentWorkflowRepeatConvergence =
  | {
      kind: 'no_new_items'
      items_path?: AgentWorkflowValuePath
      key_path: AgentWorkflowValuePath
      patience?: number
    }
  | {
      kind: 'count_at_least'
      path?: AgentWorkflowValuePath
      count: number
    }
  | {
      kind: 'predicate'
      predicate: AgentWorkflowPredicate
    }

export interface AgentWorkflowRepeatStep {
  id: string
  operation: 'repeat'
  seed: unknown
  call: AgentWorkflowAgentCall
  max_rounds?: number
  convergence: AgentWorkflowRepeatConvergence
}

export interface AgentWorkflowFilterStep {
  id: string
  operation: 'filter'
  source: AgentWorkflowValueRef
  predicate: AgentWorkflowPredicate
}

export interface AgentWorkflowDedupeStep {
  id: string
  operation: 'dedupe'
  source: AgentWorkflowValueRef
  key_paths: AgentWorkflowValuePath[]
  keep?: 'first' | 'highest_confidence'
  confidence_path?: AgentWorkflowValuePath
}

export interface AgentWorkflowMajorityVoteStep {
  id: string
  operation: 'majority_vote'
  source: AgentWorkflowValueRef
  vote_path: AgentWorkflowValuePath
  group_path?: AgentWorkflowValuePath
  quorum?: number
  majority_threshold?: number
}

export type AgentWorkflowStep =
  | AgentWorkflowParallelStep
  | AgentWorkflowPipelineStep
  | AgentWorkflowRepeatStep
  | AgentWorkflowFilterStep
  | AgentWorkflowDedupeStep
  | AgentWorkflowMajorityVoteStep

export interface AgentWorkflowDefinition {
  name: string
  max_concurrency?: number
  max_agents?: number
  steps: AgentWorkflowStep[]
}

export interface AgentWorkflowAgentResult {
  call_id: string
  status: AgentWorkflowAgentStatus
  thread_id?: string
  summary: string
  structured_output?: unknown
}

export interface AgentWorkflowStepResult {
  id: string
  operation: AgentWorkflowStep['operation']
  status: 'completed' | 'partial' | 'failed' | 'budget_exhausted' | 'aborted'
  output: unknown
  agent_count: number
  error?: string
}

export interface AgentWorkflowRunResult {
  workflow_run_id: string
  name: string
  status: AgentWorkflowRunStatus
  effective_limits: {
    max_concurrency: number
    max_agents: number
  }
  agent_count: number
  steps: AgentWorkflowStepResult[]
  output: unknown
}

export interface SubAgentStructuredOutputContract {
  schema: AgentOutputJsonSchema
  name?: string
  description?: string
}

export type RunProfileId = 'compact' | 'balanced' | 'expanded'

export type RunProfileSelectionId = 'auto' | RunProfileId

export interface TextBlock {
  type: 'text'
  text: string
  tone?: 'default' | 'error'
}

export interface ThinkingBlock {
  type: 'thinking'
  text: string
  streamId?: string
  translatedText?: string
  translatedLocale?: AppLocale
  translationVisible?: boolean
}

export interface ToolCallBlock {
  type: 'tool-call'
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  /** 工具所属类别，由后端注入，前端直接用于渲染，不再需要工具名映射表 */
  categoryId?: ToolCategoryId
  /** 填入后表示该工具已执行完毕 */
  result?: unknown
  /** 发送给模型前裁剪过的工具结果 */
  serializedResult?: string
  /** 工具结果已移到隐藏的宿主资源文件中 */
  resultStoredExternally?: boolean
  /** 工具执行出错时的错误信息 */
  error?: string
  /** 是否正在执行 */
  isRunning?: boolean
  /** 工具开始执行的客户端时间戳 */
  startedAt?: number
  /** 工具结束执行的客户端时间戳 */
  finishedAt?: number
  /** 工具执行期间流式上报的进度文本，不进入模型历史 */
  progress?: string
  /** 工具执行期间上报的结构化展示标题，不进入模型历史 */
  title?: string
  /** 工具执行期间上报的结构化展示元数据，不进入模型历史 */
  metadata?: Record<string, unknown>
  /** 工具副作用语义，由后端计算后附加，前端无需解析结果 */
  effects?: StreamToolResultEffects
  /** Widget artifact lightweight reference; large content is stored externally. */
  widgetArtifact?: ChatSessionWidgetArtifactRef
  /** 当前内存/已水化的 widget artifact 版本快照，持久化主 session 时会卸载。 */
  widgetArtifactSnapshot?: ChatSessionWidgetArtifactVersion
  /** 工具提供给模型读取的图片数据，仅用于聊天界面预览，持久化时会卸载。 */
  modelImage?: StreamToolResultModelImage
  /** 工具提供给模型读取的有序内容块；二进制内容持久化时应卸载。 */
  modelContent?: ToolResultModelContentPart[]
}

export interface ChatSessionWidgetArtifactRef {
  artifactId: string
  versionId: string
}

export interface ChatSessionWidgetArtifactVersion extends ChatSessionWidgetArtifactRef {
  title: string
  htmlSource: string
  compiledHtml: string
  sessionId: string
  createdFromMessageId: string
  createdFromToolCallId: string
  createdAt: number
}

export interface HtmlArtifactBlock {
  type: 'html-artifact'
  artifactId: string
  protocolVersion?: string
  title: string
  html: string
  protocolText?: string
  protocolDiagnostics?: HtmlArtifactProtocolDiagnostic[]
  patches?: HtmlArtifactRenderPatch[]
  patchRevision?: number
  isStreaming?: boolean
  initialHeight?: number
  updateCount?: number
  createdAt?: number
  updatedAt?: number
}

export interface AssistantGeneratedFileBlock {
  type: 'assistant-generated-file'
  id: string
  mediaType: string
  data?: string
  size: number
  filename?: string
  storedExternally?: boolean
}

export interface AssistantSourceBlock {
  type: 'assistant-source'
  id: string
  sourceType: 'url'
  url: string
  title?: string
}

export type HtmlArtifactRenderPatch =
  | { type: 'replace'; target?: string; html: string }
  | { type: 'append'; target?: string; html: string }
  | { type: 'style'; styleId: string; css: string }
  | { type: 'script'; scriptId: string; code: string }

export interface HtmlArtifactProtocolDiagnostic {
  code: string
  message: string
  phase: 'protocol'
  patchType?: HtmlArtifactRenderPatch['type']
  patchId?: string
  createdAt?: number
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolCallBlock
  | HtmlArtifactBlock
  | AssistantGeneratedFileBlock
  | AssistantSourceBlock
  | CapabilityAutoApprovalNoticeBlock
  | UserActionCardBlock

export interface ChatAttachmentMeta {
  id: string
  kind: 'image' | 'file'
  name: string
  mediaType: string
  size: number
  path?: string
  lastModified?: number
}

export interface SerializedImageAttachment {
  id: string
  kind: 'image'
  filename: string
  mediaType: string
  data: string
  size: number
}

/**
 * 会话内的产品语义，与发给模型的 `role` 正交。
 *
 * `run-guidance` / `interaction-reply` 在模型协议里仍是 user role，但它们属于当前运行内部，
 * 不能被窗口分节、回卷或“最近一次用户诉求”等逻辑误判成一轮新对话。
 *
 * `system-notice` 同样是 user role，但它既不是用户说的、也不属于任何一次运行：它是宿主对会话
 * 本身做过的事（回溯截断等）的**留痕**，模型必须看见（否则会拿着旧对话去操作已经变了的世界），
 * 用户也必须看见（破坏性操作要留证据）。它不是一轮新诉求，不能被回溯、回填输入框或分节逻辑当成
 * turn-input——所有这类判定都走 `isConversationTurnInputMessage`，新增本档不需要逐处改判。
 */
export type ChatMessageConversationKind =
  | 'turn-input'
  | 'run-guidance'
  | 'interaction-reply'
  | 'system-notice'
  | 'assistant-output'

/** 系统通知是哪一类宿主留痕：会话回溯，或目标仍在进行中时宿主替用户接着开的一轮。 */
export type ChatMessageSystemNoticeKind = 'rewind' | 'goal-continuation'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  /** 产品会话语义；缺失仅用于读取旧消息时按 role / guidanceStatus 推断。 */
  conversationKind?: ChatMessageConversationKind
  /** 一次用户提交触发的完整运行边界；用于上下文压缩识别最后一轮。 */
  runId?: string
  /** 当前聊天轮次边界；初始与 runId 相同，后续可细分多 turn 运行。 */
  turnId?: string
  /** 结构化内容块列表；纯文本时 blocks 只有一个 TextBlock */
  blocks: ContentBlock[]
  attachments?: ChatAttachmentMeta[]
  /** 发送时冻结的环境回合上下文（receipt + 气泡 chips）；仅用户消息。 */
  turnContext?: ChatMessageTurnContext
  serialized?: SerializedMessage
  /** 用户原始 serialized payload 已移到隐藏的宿主资源文件中 */
  serializedStoredExternally?: boolean
  /** 用户在运行中补充给下一轮的引导消息状态。 */
  guidanceStatus?: 'awaiting-decision' | 'pending' | 'sent' | 'accepted' | 'applied' | 'paused'
  /** `conversationKind: 'system-notice'` 的类别，只决定界面上的图标；缺省是会话回溯。 */
  systemNoticeKind?: ChatMessageSystemNoticeKind
  /** 毫秒时间戳，由客户端本地生成 */
  timestamp: number
}

export interface ChatMessageConversationSemanticInput {
  readonly role?: unknown
  readonly conversationKind?: unknown
  readonly guidanceStatus?: unknown
}

/**
 * 跨 IPC 传输的历史消息格式
 * 将 ChatMessage 的 blocks 扁平化，方便主进程直接转为 ai SDK CoreMessage
 */
export interface SerializedMessage {
  /** 来源 ChatMessage id，用于跨进程校验压缩边界。 */
  messageId?: string
  /**
   * 来源 ChatMessage 的产品会话语义。
   *
   * 模型协议只有 user/assistant 两种 role，宿主写的系统通知（回退说明）只能以 user role 传输——
   * 不带这个字段，主进程就分不清「用户说的」和「宿主替会话说的」，会把通知当成一轮真实用户诉求
   * （轮边界计数、尾保护窗口、下游消费方的信任级别全部按用户原话处理）。
   */
  conversationKind?: ChatMessageConversationKind
  /** 来源 ChatMessage runId。 */
  runId?: string
  /** 来源 ChatMessage turnId。 */
  turnId?: string
  /** 来源 ChatMessage timestamp，用于主进程校验压缩视图边界。 */
  timestamp?: number
  role: 'user' | 'assistant'
  /** 纯文本块 */
  textBlocks: string[]
  /** 用户消息中附带的图片输入，会按 image part 发送给模型 */
  imageAttachments?: SerializedImageAttachment[]
  /** 已完成的 tool call，用于重建多轮上下文 */
  toolCalls: Array<{
    toolCallId: string
    toolName: string
    /** 发送给模型前裁剪过的工具参数，避免生成文件等大输入被跨轮回放 */
    args: Record<string, unknown>
    /** 发送给模型前裁剪过的工具结果，避免跨次请求时上下文膨胀 */
    serializedResult?: string
  }>
}

export interface ChatSendRequest {
  sessionId: string
  resourceId?: LooseOptional<string>
  messages: SerializedMessage[]
  modelContextView?: LooseOptional<ChatSendContextView>
  sessionLineage?: LooseOptional<SessionLineageContext>
  locale?: AppLocale
  provider?: string
  thinkingDepth?: ThinkingDepth
  /** Composer 思考力度 5 档（off/low/medium/high/ultra）；优先于 thinkingDepth，决定本次请求 reasoning 力度。 */
  reasoningLevel?: ReasoningLevel
  model?: string
  /** 能力轴：只表达「哪些能力本轮开着」。执行模式走 `executionModes`。 */
  promptFeatures?: ChatPromptFeatureId[]
  /** 执行模式轴（权威）；缺席时由 `resolveChatSendRequestOptions` 从旧形态折算。 */
  executionModes?: ExecutionModeId[]
  /** @deprecated 已并入 `executionModes`；旧宿主入口保留，读取一律经 `resolveExecutionModes`。 */
  goalMode?: boolean
  /** 纯聊天模式，与 space 正交：由 active context 的 pureChatMode 显式传入，不再由 space===System 推断。 */
  pureChatMode?: boolean
  scope?: CapabilityScopeId
  runProfile?: RunProfileSelectionId
  selectedSkillIds?: string[]
  toolSurfaceProfile?: ToolSurfaceProfileId
  agentSurfaceId?: LooseOptional<AgentSurfaceId>
  developerContext?: LooseOptional<AgentDeveloperContext>
  /** 本次发送冻结的环境回合上下文回执；main 在 accept 后据此推进 cursor。 */
  turnContextReceipt?: LooseOptional<ContextDeltaReceipt>
}

export interface ExecutionProvideGuidanceRequest {
  sessionId: string
  message: SerializedMessage
}

export interface ChatTranslateThinkingRequest {
  sessionId: string
  messageId: string
  blockIndex: number
  text: string
  locale: AppLocale
  provider?: string
  model?: string
  thinkingDepth?: ThinkingDepth
}

export interface ChatTranslateThinkingResponse {
  text: string
}

export interface ChatSummarizeForHandoffRequest {
  sessionId: string
  /** 供续跑简报总结的对话正文（调用方已做裁剪/序列化）。 */
  transcript: string
  /** 会话的资源范围提示（本地根路径 / 远端 URL 等），供简报点明落点。 */
  scopeHint?: string
  locale: AppLocale
  provider?: string
  model?: string
  thinkingDepth?: ThinkingDepth
}

export interface ChatSummarizeForHandoffResponse {
  brief: string
}

export type ChatSuggestionPhase = 'new-session' | 'next-turn'

export interface ChatSuggestionItem {
  id: string
  title: string
  prompt: string
  reason: string
  confidence: number
}

export interface ChatGenerateSuggestionsRequest {
  sessionId: string
  phase: ChatSuggestionPhase
  locale: AppLocale
  /** Opaque capability scope used by injected suggestion context providers. */
  scope?: CapabilityScopeId
  resourceId?: string
  scopeMetadata?: Record<string, unknown>
  scopeHint?: string
  /** next-turn only：renderer 已裁剪并序列化的最近对话。 */
  transcript?: string
  provider?: string
  model?: string
  thinkingDepth?: ThinkingDepth
}

export interface ChatGenerateSuggestionsResponse {
  suggestions: ChatSuggestionItem[]
  sourceCount: number
}

// 手动压缩功能已移除(2026-07-18 用户裁决:压缩由内部看门自治);旧落盘数据里的 'manual'
// 在恢复时归一为 'auto'。
export type ChatContextCompactionTrigger = 'auto'

export interface ChatSendContextView {
  viewId: string
  messages: DebugModelMessage[]
  coveredMessageCount: number
  sourceLastMessageId: Nullable<string>
  sourceLastMessageTimestamp: Nullable<number>
}

export type ChatContextOSSourceKind = string

export interface ChatContextOSSourceSnapshot {
  kind: ChatContextOSSourceKind
  count: number
  label: string
  estimatedChars?: LooseOptional<number>
  metadata?: Record<string, unknown>
}

export interface ChatContextOSSourceGraphSnapshot {
  sessionId: string
  capturedAt: number
  sources: ChatContextOSSourceSnapshot[]
}

export type ChatContextPipelineProfileId = string

export type ChatContextPipelineStageId = string

export type ChatContextBudgetLaneId = string

export type ChatContextPipelineStageStatus = 'completed' | 'skipped' | 'pending'

export interface ChatContextPipelineStageRun {
  id: ChatContextPipelineStageId
  required: boolean
  status: ChatContextPipelineStageStatus
  reason?: LooseOptional<string>
}

export interface ChatContextBudgetLaneDefinition {
  id: ChatContextBudgetLaneId
  priority: number
  minPercent: number
  maxPercent: number
}

export interface ChatContextPipelineRun {
  profile: ChatContextPipelineProfileId
  stages: ChatContextPipelineStageRun[]
  budgetLanes: ChatContextBudgetLaneDefinition[]
  notes: string[]
}

export interface ChatContextDebugTraceEntry {
  stage: ChatContextPipelineStageId
  action: 'inline' | 'summarize' | 'handle' | 'drop' | 'skip' | 'estimate' | 'retain'
  target: string
  reason: string
  score?: LooseOptional<number>
  metadata?: Record<string, unknown>
}

export type ChatContextRetrievalHandleKind = string

export interface ChatContextRetrievalHandle {
  id: string
  kind: ChatContextRetrievalHandleKind
  sessionId: string
  sourceMessageIndex: Nullable<number>
  role?: LooseOptional<SerializedMessage['role']>
  toolCallId?: LooseOptional<string>
  toolName?: LooseOptional<string>
  label: string
  summary: string
  estimatedChars: number
  priority: number
  metadata?: Record<string, unknown>
}

export interface ChatContextRetrievePayloadRequest {
  sessionId: string
  handleId: string
  jsonPath?: LooseOptional<string>
  /**
   * 续读起点（0 起）：jsonPath 命中数组时是**条目**下标，其余情况是正文**字符**下标；
   * 两条路径都在返回的 metadata 里回带 `nextOffset`，模型按同一个字段推进。
   */
  offset?: LooseOptional<number>
  retrievalScopeId?: LooseOptional<string>
  sessionLineage?: LooseOptional<SessionLineageContext>
  reason?: LooseOptional<string>
  maxChars?: LooseOptional<number>
}

export interface ChatContextRetrievedPayload {
  handleId: string
  sessionId: string
  found: boolean
  kind: ChatContextRetrievalHandleKind | 'unknown'
  content: Nullable<string>
  repeated: boolean
  retrievalCount: number
  warning?: LooseOptional<string>
  metadata?: Record<string, unknown>
}

export interface ChatContextSearchConversationHistoryRequest {
  sessionId: string
  query: string
  retrievalScopeId?: LooseOptional<string>
  sessionLineage?: LooseOptional<SessionLineageContext>
  maxResults?: LooseOptional<number>
  maxChars?: LooseOptional<number>
}

export interface ChatContextSearchConversationHistoryItem {
  handleId: string
  messageId: string
  messageIndex: number
  role: SerializedMessage['role'] | ChatMessage['role']
  timestamp: number
  score: number
  matchReasons: string[]
  pathHints: string[]
  symbolHints: string[]
  recencyScore: number
  errorFingerprint: Nullable<string>
  summary: string
  matchedText: Nullable<string>
  toolNames: string[]
}

export interface ChatContextSearchConversationHistoryResult {
  sessionId: string
  query: string
  totalMessages: number
  items: ChatContextSearchConversationHistoryItem[]
  trace: ChatContextRetrievalQueryTraceEntry
  retryHints?: LooseOptional<string[]>
  warning?: LooseOptional<string>
}

export interface ChatContextReadEvidenceRequest {
  sessionId: string
  evidenceId: string
  retrievalScopeId?: LooseOptional<string>
  sessionLineage?: LooseOptional<SessionLineageContext>
  maxChars?: LooseOptional<number>
}

export interface ChatContextReadEvidenceResult {
  sessionId: string
  evidenceId: string
  found: boolean
  evidence: Nullable<ChatContextEvidenceRecord>
  payloadHandleId: Nullable<string>
  repeated?: boolean
  retrievalCount?: number
  warning?: LooseOptional<string>
}

export interface ChatContextReadToolPayloadRequest {
  sessionId: string
  toolCallId?: string
  payloadRef?: string
  jsonPath?: LooseOptional<string>
  /** jsonPath 命中数组时的起始条目（0 起）；配合 __truncatedItems 标记的 nextOffset 续读。 */
  offset?: LooseOptional<number>
  retrievalScopeId?: LooseOptional<string>
  sessionLineage?: LooseOptional<SessionLineageContext>
  reason?: LooseOptional<string>
  maxChars?: LooseOptional<number>
}

export interface ChatContextSearchTerminalOutputRequest {
  sessionId: string
  query: string
  retrievalScopeId?: LooseOptional<string>
  sessionLineage?: LooseOptional<SessionLineageContext>
  maxResults?: LooseOptional<number>
  maxChars?: LooseOptional<number>
}

export interface ChatContextSearchTerminalOutputItem {
  handleId: string
  toolCallId: string
  logPath: string
  source: string
  score: number
  matchReasons: string[]
  snippet: string
  truncated: boolean
  warning?: LooseOptional<string>
}

export interface ChatContextSearchTerminalOutputResult {
  sessionId: string
  query: string
  items: ChatContextSearchTerminalOutputItem[]
  trace: ChatContextRetrievalQueryTraceEntry
  retryHints?: LooseOptional<string[]>
  warning?: LooseOptional<string>
}

export interface ChatContextRetrievalIndexSourceFingerprint {
  stateMtimeMs: Nullable<number>
  payloadMtimeMs: Nullable<number>
  payloadFingerprint: Nullable<string>
}

export type ChatContextRetrievalQueryKind = 'conversation-history' | 'terminal-output' | 'evidence'

export interface ChatContextRetrievalScoreBucket {
  label: string
  minScore: number
  maxScore: number
  count: number
}

export interface ChatContextRetrievalScoreStats {
  min: Nullable<number>
  max: Nullable<number>
  average: Nullable<number>
  buckets: ChatContextRetrievalScoreBucket[]
}

export interface ChatContextRetrievalQueryTraceEntry {
  id: string
  sessionId: string
  retrievalScopeId: string
  kind: ChatContextRetrievalQueryKind
  query: string
  normalizedQuery: string
  requestedAt: number
  repeated: boolean
  retrievalCount: number
  totalCandidates: number
  matchedCount: number
  returnedCount: number
  topScore: Nullable<number>
  topHandleIds: string[]
  matchReasons: string[]
  scoreStats: ChatContextRetrievalScoreStats
  warning?: LooseOptional<string>
}

export type ChatContextRetrievalIndexLoadSource =
  | 'fresh-index'
  | 'rebuilt-index'
  | 'missing-index'
  | 'invalid-index'
  | 'stale-index'

export interface ChatContextRetrievalIndexDiagnostics {
  sessionId: string
  indexPath: string
  exists: boolean
  fresh: boolean
  staleReason: Nullable<string>
  builtAt: Nullable<number>
  sourceFingerprint: Nullable<ChatContextRetrievalIndexSourceFingerprint>
  currentFingerprint: ChatContextRetrievalIndexSourceFingerprint
  messageCount: number
  toolPayloadCount: number
  evidenceCount: number
  logReferenceCount: number
  artifactReferenceCount: number
  lastLoadSource: Nullable<ChatContextRetrievalIndexLoadSource>
  lastBuildDurationMs: Nullable<number>
  lastBuiltAt: Nullable<number>
  recentQueries: ChatContextRetrievalQueryTraceEntry[]
}

export interface ChatContextRetrievalIndexDiagnosticsRequest {
  sessionId: string
}

export type ChatContextRetentionAction =
  | 'keep-full'
  | 'keep-pinned'
  | 'summarize'
  | 'reference-only'
  | 'drop'

export interface ChatContextDroppedRange {
  startMessageIndex: number
  endMessageIndex: number
  action: ChatContextRetentionAction
  reason: string
  retrievalHandleIds: string[]
}

export interface ChatContextViewTokenStats {
  before: ContextUsageEstimate
  after: ContextUsageEstimate
  source: ChatContextUsageAccountingSource
  confidence: ChatContextUsageAccountingConfidence
}

export interface ChatContextViewRollbackMeta {
  parentViewId: Nullable<string>
  sourceMessageCount: number
  sourceLastMessageId: Nullable<string>
  sourceLastMessageTimestamp: Nullable<number>
  canRollback: boolean
  invalidationReasons: string[]
}

export interface ChatSessionContextView {
  id: string
  parentViewId: Nullable<string>
  sessionId: string
  trigger: ChatContextCompactionTrigger
  createdAt: number
  model: string
  sourceGraph: ChatContextOSSourceGraphSnapshot
  sourceMessageCount: number
  sourceLastMessageId: Nullable<string>
  sourceLastMessageTimestamp: Nullable<number>
  coveredMessageCount: number
  messages: DebugModelMessage[]
  estimatedBefore: ContextUsageEstimate
  estimatedAfter: ContextUsageEstimate
  removedMessages: number
  passes: number
  keptRecentTurns: number
  targetPercent: number
  usageSource: ChatContextUsageAccountingSource
  pipeline: ChatContextPipelineRun
  protectedEvidenceIds: string[]
  droppedRanges: ChatContextDroppedRange[]
  tokenStats: ChatContextViewTokenStats
  rollbackMeta: ChatContextViewRollbackMeta
  evidenceLedger: ChatContextEvidenceRecord[]
  retrievalHandles: ChatContextRetrievalHandle[]
  debugTrace: ChatContextDebugTraceEntry[]
  generatedTitle?: LooseOptional<string>
}

export interface ChatSessionContextViewStore {
  activeViewId: Nullable<string>
  views: ChatSessionContextView[]
  maxViews: number
}

/** Capability-owned evidence freshness snapshot used during compaction. */
export interface ChatCompactContextCapabilityTruth {
  revisionsByResource: Readonly<Record<string, string>>
  externallyTouchedResourceIds: readonly string[]
}

export interface ChatAbortRequest {
  sessionId: string
}

export type ActiveContextArtifactKind = 'plan' | 'decision' | 'requirement'

export type ActiveContextArtifactScope = string

export type ActiveContextArtifactStatus = 'active' | 'completed' | 'archived'

export type ActiveDirectiveType =
  | 'prohibition'
  | 'preference'
  | 'process'
  | 'requirement'
  | 'other'

export interface ActiveContextArtifact {
  id: string
  kind: ActiveContextArtifactKind
  scope: ActiveContextArtifactScope
  status: ActiveContextArtifactStatus
  sessionId: string
  resourceId?: LooseOptional<string>
  title: string
  content: string
  sourceMessageId?: LooseOptional<string>
  metadata?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface ActiveContextUpsertInput {
  id?: string
  kind: ActiveContextArtifactKind
  scope?: ActiveContextArtifactScope
  status?: ActiveContextArtifactStatus
  resourceId?: LooseOptional<string>
  title: string
  content: string
  sourceMessageId?: LooseOptional<string>
  metadata?: Record<string, unknown>
}

export interface ActiveDirectiveUpsertInput {
  id?: string
  title: string
  content: string
  directiveType: ActiveDirectiveType
  sourceMessageId?: string
}

export interface ActiveDirectiveArchiveInput {
  ids?: string[]
  title?: string
  directiveType?: ActiveDirectiveType
}

export interface ActiveContextListOptions {
  status?: ActiveContextArtifactStatus | 'all'
  kinds?: ActiveContextArtifactKind[]
  resourceId?: LooseOptional<string>
}

export interface ActiveContextArchiveFilter {
  ids?: string[]
  kinds?: ActiveContextArtifactKind[]
  resourceId?: LooseOptional<string>
}

export type ActiveContextGovernanceAction =
  | 'keep'
  | 'suggest-complete'
  | 'suggest-archive'
  | 'review'

export type ActiveContextGovernanceSeverity = 'low' | 'medium' | 'high'

export interface ActiveContextGovernanceSuggestion {
  id: string
  artifactId: string
  kind: ActiveContextArtifactKind
  status: ActiveContextArtifactStatus
  title: string
  action: ActiveContextGovernanceAction
  severity: ActiveContextGovernanceSeverity
  score: number
  reason: string
  ageMs: number
  inactiveMs: number
  metadata?: Record<string, unknown>
}

export interface ActiveContextGovernanceOptions {
  resourceId?: LooseOptional<string>
  now?: LooseOptional<number>
  staleAfterMs?: LooseOptional<number>
  completedArchiveAfterMs?: LooseOptional<number>
  maxActiveArtifacts?: LooseOptional<number>
}

export interface ActiveContextGovernanceReport {
  sessionId: string
  generatedAt: number
  activeCount: number
  completedCount: number
  archivedCount: number
  maxActiveArtifacts: number
  suggestions: ActiveContextGovernanceSuggestion[]
  summary: string
}

export type ActiveContextGovernanceDecision = 'accept' | 'reject' | 'ignore'

export interface ActiveContextApplyGovernanceDecisionInput {
  suggestionId: string
  artifactId: string
  action: ActiveContextGovernanceAction
  decision: ActiveContextGovernanceDecision
  reason?: LooseOptional<string>
}

export interface ActiveContextGovernanceApplyResult {
  artifact: Nullable<ActiveContextArtifact>
  report: ActiveContextGovernanceReport
}

export interface ChatActiveContextRequest {
  sessionId: string
}

export interface ChatArchiveActiveDirectiveRequest {
  sessionId: string
  ids: string[]
}

export interface ChatActiveDirectivesChangedEvent {
  sessionId: string
}

export interface ChatAssessActiveContextGovernanceRequest {
  sessionId: string
  options?: ActiveContextGovernanceOptions
}

export interface ChatApplyActiveContextGovernanceRequest extends ActiveContextApplyGovernanceDecisionInput {
  sessionId: string
  options?: ActiveContextGovernanceOptions
}

export interface ChatArchiveActiveContextRequest {
  sessionId: string
  filter: ActiveContextArchiveFilter
}

export type ChatGoalLifecycleAction =
  | 'resume'
  | 'pause'
  | 'block'
  | 'complete'
  | 'cancel'
  | 'remove'

export interface ChatUpdateGoalLifecycleRequest {
  sessionId: string
  action: ChatGoalLifecycleAction
}

export interface ChatUpdateGoalLifecycleResponse {
  goal: ActiveContextArtifact
}

export interface ChatGetGoalLifecycleRequest {
  sessionId: string
}

export interface ChatGetGoalLifecycleResponse {
  goal: Nullable<ActiveContextArtifact>
}

export interface ChatSessionToolResultPayload {
  /** A local copy retained for an explicitly approved task handoff; never grants access to another session. */
  handoff?: { sourceSessionId: string; sourceRef: string; sourceRefs?: string[] }

  serializedResult: string
  displayResult: unknown
  toolCallId?: string
  toolName?: string
  payloadRef?: string
  hash?: string
}

export interface ChatSessionPayloadSnapshot {
  sessionId: string
  userMessages: Record<string, SerializedMessage>
  /** assistant 消息的 serialized payload，卸载到文件以减少 localStorage 体积 */
  assistantMessages: Record<string, SerializedMessage>
  toolResults: Record<string, ChatSessionToolResultPayload>
  widgetArtifacts?: Record<string, ChatSessionWidgetArtifactVersion>
  generatedFiles?: Record<string, StreamAssistantGeneratedFilePayload>
}

export interface ChatPersistSessionPayloadsRequest {
  sessions: ChatSessionPayloadSnapshot[]
}

export interface ChatLoadSessionPayloadRequest {
  sessionId: string
}

export interface ChatSessionStateTimelineSnapshot {
  key: string
  messages: ChatMessage[]
  messagePaging?: LooseOptional<ChatMessagePaging>
}

export interface ChatMessagePaging {
  /** 当前 messages[] 在全量数组中的起始下标 */
  loadedFromIndex: number
  /** 全量消息数 */
  totalCount: number
}

/**
 * 会话磁盘快照的规范 JSON 形状。
 *
 * - 写出：`serializeSessionForDisk`（renderer，不含 executionGraph）
 * - 重组：`ChatStateStore.loadAllSessions` → `entry.data`
 * - 持久化：manifest 中的 `session` 为去掉 messages 后的 metadata；完整快照由上述路径重组
 *
 * renderer `chatTypes.StoredChatSession` 与之同构。
 */
export interface StoredChatSession {
  id: string
  /** 所属 folder id；成员会话搜索结果需要用它回到正确的侧边栏容器。 */
  folderId?: LooseOptional<string>
  title: string
  titleManuallyEdited?: boolean
  isPinned?: boolean
  /** 成员在所属 folder 内的置顶状态；不影响外层 folder 排序。 */
  isMemberPinned?: boolean
  sidebarOrder?: LooseOptional<number>
  createdAt: number
  updatedAt: number
  thinkingDepth?: ThinkingDepth
  /** @deprecated 已并入 `executionModes`；存量磁盘会话仍可能只有这一格，读入时折算。 */
  goalMode?: boolean
  /**
   * 会话执行模式粘性（权威轴）：上次发送实际生效的执行模式。
   * hook send 省略 config 时回落到它，兑现「省略字段回落 session 默认」契约。
   */
  executionModes?: ExecutionModeId[]
  /** 会话能力粘性：上次发送实际生效的 prompt features（**只含能力**，模式已拆到 `executionModes`）。 */
  promptFeatures?: ChatPromptFeatureId[]
  scope?: CapabilityScopeId
  pureChatMode?: boolean
  toolSurfaceProfile?: ToolSurfaceProfileId
  selectedProvider?: LooseOptional<string>
  selectedModel?: string
  resourceId?: LooseOptional<string>
  scopeMetadata?: Record<string, unknown>
  resourceVersion?: number
  messages: ChatMessage[]
  messageRunMarkers?: unknown[]
  isStreaming?: boolean
  runtime?: Record<string, unknown>
  contextView?: LooseOptional<ChatSessionContextView>
  contextViewStore?: ChatSessionContextViewStore
  trace?: unknown[]
  turnContexts?: unknown[]
  workerThreads?: unknown[]
  crewAgentRuns?: unknown[]
  checkpoints?: unknown
  headSnapshot?: LooseOptional<Record<string, unknown>>
  branches?: unknown[]
  activeBranchId?: string
  sourceResourceId?: LooseOptional<string>
  messagePaging?: LooseOptional<ChatMessagePaging>
}

export interface ChatSessionStateSaveSnapshot {
  version: 1
  /** 已移除时间线消息数组的 `StoredChatSession` 元数据。 */
  session: Record<string, unknown>
  timelines: ChatSessionStateTimelineSnapshot[]
  /** 子 Agent 执行线程独立保存，不写入 session manifest。 */
  workerThreads?: unknown[]
}

/**
 * 单个 session 状态的保存请求。
 * snapshot 是 renderer 侧已拆分的 metadata + timeline windows。
 */
export interface ChatSaveSessionStateRequest {
  sessionId: string
  snapshot?: LooseOptional<ChatSessionStateSaveSnapshot>
}

/**
 * folder 注册表单条：虚拟文件夹（会话组）元数据的唯一落盘真值。
 * 成员会话不再反范式复制 pin/排序等 folder 级字段。
 */
export interface ChatFolderRegistryEntry {
  id: string
  title: string
  titleManuallyEdited: boolean
  isPinned: boolean
  sidebarOrder: Nullable<number>
  /** 归档时间；null 表示正常显示，非空表示仅在归档页显示。 */
  archivedAt?: LooseOptional<number>
  /** 单独归档的成员；成员仍留在 folder 中，恢复时可回到原位置。 */
  archivedMembers?: Array<{
    memberSessionId: string
    archivedAt: number
  }>
  /**
   * folder 级执行体绑定 —— **存量读取源，新数据不再往这里写**（2026-08-07 起改成员级）。
   *
   * 它曾是唯一的路由声明：一个 folder 全员由同一个外部引擎执行，于是「在当前对话里加一个
   * 由外部引擎执行的成员」根本表达不出来，只能另开一个 folder。判决：绑定下沉到**成员**
   * （见 {@link ChatFolderRegistryEntry.memberExecutionBindings}），外部引擎成员因此能与
   * 其它资源范围的成员并列在同一个 folder 里。
   *
   * 存量 folders.json 里这一格仍然有效：解析顺序 = 成员级优先、缺席时回落本格。不做落盘迁移，
   * 少一次「迁移脚本写坏用户数据」的机会。
   */
  executionBinding?: LooseOptional<{
    kind: 'engine'
    engineId: 'claude-code' | 'codex'
    workspaceRoot: string
  }>
  /**
   * **成员级执行体绑定**：哪个成员会话由哪个外部引擎执行（2026-08-07 新增，写入面唯一权威）。
   *
   * 数组而不是 Record：与 `archivedMembers` 同形，JSON 里稳定可读；成员数是个位数，查表用 find
   * 即可。缺席成员 = Velar 自己执行。单个成员的绑定创建后不可变——切执行体请新建成员，
   * 避免一条会话混入两种执行账本（这条与原来的 folder 级判决一致，只是粒度换了）。
   */
  memberExecutionBindings?: LooseOptional<
    Array<{
      memberSessionId: string
      kind: 'engine'
      engineId: 'claude-code' | 'codex'
      workspaceRoot: string
    }>
  >
  createdAt: number
  updatedAt: number
  /** 成员会话 id（每个成员一个固定资源范围）。 */
  memberSessionIds: string[]
  /** 当前活跃成员会话 id。 */
  activeMemberSessionId: string
}

/** folder 注册表磁盘快照（storage/chat/folders.json）。 */
export interface ChatFolderRegistrySnapshot {
  version: 1
  /** 当前活跃 folder；启动恢复 = 其 activeMemberSessionId 指向的成员会话。 */
  activeFolderId: string
  folders: ChatFolderRegistryEntry[]
  updatedAt: number
}

/** folder 注册表保存请求（整表覆盖写）。 */
export interface ChatSaveFolderRegistryRequest {
  snapshot: ChatFolderRegistrySnapshot
}

/** 单个 session 磁盘文件记录。 */
export interface ChatSessionStateDiskEntry {
  sessionId: string
  /** JSON 序列化的 {@link StoredChatSession}。 */
  data: string
}

/** 启动首屏快速恢复：先返回最近 session 的可显示窗口，再由 renderer 后台补全全部 session。 */
export interface ChatStartupSessionStateResponse {
  activeEntry: Nullable<ChatSessionStateDiskEntry>
  sessionCount: number
}

/** 启动时批量返回所有已保存的 session 状态。 */
export interface ChatLoadAllSessionStatesResponse {
  sessions: ChatSessionStateDiskEntry[]
}

/**
 * 按需加载较老消息的请求。
 *
 * beforeIndex: 当前已加载部分在全量数组中的起始下标（即 messages[beforeIndex..]已在内存中）。
 * count: 本次期望加载多少条消息。
 */
export interface ChatLoadOlderMessagesRequest {
  sessionId: string
  /** Optional capability-owned context selector. */
  /** 当前活动分支；省略时由磁盘 manifest 的 activeBranchId 兜底。 */
  branchId?: LooseOptional<string>
  /** 已在内存中的消息在全量数组里的起始位置 */
  beforeIndex: number
  /** 期望加载的条数 */
  count: number
}

/** 加载较老消息的响应。 */
export interface ChatLoadOlderMessagesResponse {
  /** 载入的消息（按时间顺序） */
  messages: ChatMessage[]
  /** 这批消息在全量数组里的起始位置 */
  loadedFromIndex: number
  /** 是否还有更老的消息 */
  hasMore: boolean
}

/** 按需加载子 Agent 执行线程详情。 */
export interface ChatLoadWorkerThreadDetailRequest {
  sessionId: string
  threadId: string
}

export interface ChatLoadWorkerThreadDetailResponse {
  workerThread: Nullable<Record<string, unknown>>
}

export type ChatSessionSearchMatchType = 'keyword'

export interface ChatSessionSearchRequest {
  query: string
  limit?: LooseOptional<number>
  kinds?: LooseOptional<Array<'chat'>>
}

export interface ChatSessionSearchMatch {
  messageId: string
  messageIndex: number
  role: SerializedMessage['role'] | ChatMessage['role']
  timestamp: number
  score: number
  matchType: ChatSessionSearchMatchType
  snippet: string
}

export interface ChatSessionSearchResultGroup {
  sessionId: string
  folderId: string
  title: string
  kind: 'chat'
  createdAt: number
  updatedAt: number
  topScore: number
  matches: ChatSessionSearchMatch[]
}

export interface ChatSessionSearchResponse {
  query: string
  groups: ChatSessionSearchResultGroup[]
}

export interface ChatStreamSnapshotCursor {
  sessionId: string
  afterSequence?: LooseOptional<number>
}

export interface ChatStreamSnapshotRequest {
  cursors?: ChatStreamSnapshotCursor[]
}

export interface StreamToolCallPayload {
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  /** 工具所属类别，由后端 ToolRegistry 解析注入，前端直接用于渲染 */
  categoryId?: ToolCategoryId
}

export interface StreamReasoningPayload {
  id: string
  text: string
}

export interface StreamToolResultPayload {
  toolCallId: string
  result: unknown
  error?: string
  /** 工具执行产生的副作用语义，由后端计算后附加，前端无需解析结果 */
  effects?: StreamToolResultEffects
  /** 工具提供给模型读取的图片数据，renderer 用它做聊天内预览。 */
  modelImage?: StreamToolResultModelImage
  /** 工具提供给下一模型轮次的有序文本、图片与文件内容块。 */
  modelContent?: ToolResultModelContentPart[]
}

export interface StreamToolProgressPayload {
  toolCallId: string
  chunk: string
  timestamp?: number
}

export interface StreamToolMetadataPayload {
  toolCallId: string
  title?: string
  metadata?: Record<string, unknown>
  timestamp?: number
}

export interface StreamExecutionGraphPayload {
  kind: 'execution-graph'
  executionId: string
  sourceSessionId: string
  status: ExecutionStatus
  currentTaskId: Nullable<string>
  currentRecommendedAction: ExecutionTaskRecord['recommendedAction']
  currentExecutionAdvice: Nullable<ExecutionTaskExecutionAdvice>
  planView: Nullable<ExecutionPlanView>
  roleId: Nullable<AgentRoleId>
  roleLabel: Nullable<string>
  tasks: ExecutionTaskRecord[]
  events: ExecutionEventRecord[]
}

export type StreamDebugPayload =
  | StreamTurnContextPayload
  | StreamAssistantRawPayload
  | StreamExecutionGraphPayload

export type ChatStreamNoticeEvent = {
  type: 'notice'
  kind: string
  payload: unknown
}

export type ChatStreamEvent =
  | { type: 'reasoning'; payload: StreamReasoningPayload }
  | { type: 'tool-call'; payload: StreamToolCallPayload }
  | { type: 'tool-progress'; payload: StreamToolProgressPayload }
  | { type: 'tool-metadata'; payload: StreamToolMetadataPayload }
  | { type: 'tool-result'; payload: StreamToolResultPayload }
  | { type: 'worker-thread'; payload: StreamWorkerThreadPayload }
  | { type: 'state'; payload: StreamStatePayload }
  | { type: 'debug'; payload: StreamDebugPayload }
  | ChatStreamNoticeEvent
  | { type: 'end' }
  | { type: 'error'; payload: SerializedError }

/** IPC 信封：所有 stream 事件都携带 sourceSessionId，前端据此路由到正确 session */
export interface ChatStreamDeltaEnvelope {
  sourceSessionId: string
  text: string
  sequence?: number
}

export interface ChatStreamEventEnvelope {
  sourceSessionId: string
  event: ChatStreamEvent
  sequence?: number
}

export interface ChatHookSendTaskEvent {
  sessionId: string
  capabilityContext?: unknown
  messageId: string
  message: string
  timestamp: number
  /** 外部 hook 指定的发送配置覆盖（模型/运行模式/思考力度等）；省略则用目标上下文默认。 */
  config?: unknown
  /** hook 携带的图片输入（等价 composer 贴图/选图）；renderer 装配进 serialized.imageAttachments。 */
  imageAttachments?: SerializedImageAttachment[]
}

/**
 * hook 可见性操作的会话选中通知：主进程窗口前置后,让 renderer 把目标会话切成 UI 当前选中
 * （等价侧边栏点击）。sessionId 可为成员 id 或 folder id,renderer 用与 send_task 同一套解析。
 * 没有这一步时 focus/send 只有 OS 级窗口聚焦——已存在会话的界面永远不切换（真机踩坑）。
 */
export interface ChatHookFocusSessionEvent {
  sessionId: string
}

/** hook provide_guidance：向运行中的会话追加用户引导（renderer 负责入会话+持久化）。 */
export interface ChatHookProvideGuidanceEvent {
  sessionId: string
  messageId: string
  message: string
  timestamp: number
}

/** hook bridge_ping：主进程探测 renderer hook 桥活性的 ping 事件；renderer 收到后以同 nonce 回 pong。 */
export interface ChatHookBridgePingEvent {
  nonce: string
}

/**
 * hook resolve_confirmation：主进程 headless 放行确认后,通知 renderer 对目标会话重新进入
 * streaming 态(prepareSessionStreamStart + markSessionStreaming)。UI 点按钮走
 * useChatExecutionResolveConfirmation 会自己 re-prime;hook 批准绕过 renderer,不补这一步
 * 则恢复流(tool-result+后续回答)会被当迟到输入丢弃、不落 state store。
 */
export interface ChatHookResolveConfirmationEvent {
  confirmationId?: string
  sessionId: string
}

/** hook arm_handoff：绕过降级判定，直接给目标会话布防转交建议卡（测试驱动）。 */
export interface ChatHookArmHandoffEvent {
  sessionId: string
}

/** hook resolve_handoff：程序化解析目标会话当前布防的转交建议卡（等价点击卡片按钮）。 */
export interface ChatHookResolveHandoffEvent {
  sessionId: string
  approved: boolean
}

export type BackendLogNotificationLevel = 'warn' | 'error' | 'fatal'

export type BackendLogNotificationTone = 'warning' | 'error'

export interface BackendLogNotificationEvent {
  id: string
  title: string
  tone: BackendLogNotificationTone
  level: BackendLogNotificationLevel
  scope: string
  timestamp: number
}

export type ChatStreamSnapshotItem =
  | { kind: 'delta'; sequence: number; text: string }
  | { kind: 'event'; sequence: number; event: ChatStreamEvent }

export interface ChatStreamSnapshot {
  sourceSessionId: string
  isStreaming: boolean
  latestSequence: number
  items: ChatStreamSnapshotItem[]
}

export interface ChatConfig {
  /** Product-owned model selection. Core does not define provider/catalog/auth DTOs. */
  modelSelection?: unknown
  systemPromptAppend: string
}

export type SubAgentTaskMode = 'sync' | 'async'

/** Opaque worker type id registered by the product composition root. */
export type SubAgentTypeId = string

export type SubAgentSessionStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'wind_down'

export type SubAgentWindDownReason = 'time' | 'turn_cap' | 'user_interrupt'

export type SubAgentToolScope = 'type_default' | 'inherit' | 'custom'

export type SubAgentTaskResultStatus =
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'wind_down'
  | 'running'

export interface SubAgentToolDigestEntry {
  tool: string
  outcome: 'ok' | 'error'
  hint?: LooseOptional<string>
}

export interface SubAgentTaskArtifacts {
  changed_paths?: string[]
  discovery_paths?: string[]
  verification?: {
    status: 'passed' | 'failed' | 'skipped'
    command?: LooseOptional<string>
  }
}

export interface SubAgentTaskRequest {
  agent_name?: LooseOptional<string>
  subagent_type: SubAgentTypeId
  /** 文件式自定义 agent id；存在时 subagent_type 为其 base 内置类型。 */
  custom_agent_id?: LooseOptional<string>
  prompt: string
  description?: LooseOptional<string>
  tool_scope?: LooseOptional<SubAgentToolScope>
  tool_categories?: LooseOptional<ToolCategoryId[]>
  thread_id?: LooseOptional<string>
  mode?: LooseOptional<SubAgentTaskMode>
  readonly?: LooseOptional<boolean>
  model?: LooseOptional<string>
  /** 本线程生效的 reasoning effort；续跑省略 effort 时沿用它。 */
  effort?: LooseOptional<ThinkingDepth>
  route_category?: LooseOptional<TeamModelRouteCategory>
  attachments?: LooseOptional<string[]>
  interrupt?: LooseOptional<boolean>
  run_profile?: LooseOptional<RunProfileId>
}

/**
 * 文件式自定义子智能体定义（storage/agents/<id>.md）。
 *
 * 设计为「内置 base 类型 + 覆盖项」的预设：路由/阶段映射/写租约语义全部沿用 base，
 * 自定义只覆盖提示词、工具分类、模型与只读默认值——避免自定义 id 渗入
 * SubAgentTypeId 的封闭枚举。
 */
export interface CustomSubAgentDefinition {
  /** slug = 文件名（不含 .md），派发时作为 subagent_type 引用。 */
  id: string
  name: string
  /** 一句话适用边界；会注入主 Agent 提示词，用于判断何时派发（防滥用的第一道闸）。 */
  description: string
  /** 继承的内置类型；缺省 general。 */
  base: SubAgentTypeId
  /** 覆盖 base 默认工具分类；null 表示沿用 base。 */
  toolCategories: Nullable<ToolCategoryId[]>
  /** 覆盖模型 id；null 表示走团队路由。 */
  model: Nullable<string>
  /** 覆盖 reasoning effort（思考力度档）；null 表示继承会话 effort。 */
  effort: Nullable<ThinkingDepth>
  /** 覆盖只读默认值；null 表示沿用 base。 */
  readonly: Nullable<boolean>
  /** 正文 = 追加到子 Agent 指令的系统提示词。 */
  promptMarkdown: string
  filePath: string
  updatedAt: number
}

/** 自定义 agent 的轻量描述符（注入主 Agent 提示词/设置页列表用）。 */
export interface CustomSubAgentDescriptor {
  id: string
  name: string
  description: string
  base: SubAgentTypeId
  updatedAt: number
}

/** 自定义 agent 市场条目（远端 manifest + 本地安装状态合成）。 */
export interface CustomAgentMarketEntry {
  id: string
  name: string
  description: string
  version: string
  installState: 'not-installed' | 'installed' | 'update-available'
  install?: {
    phase: 'installing' | 'failed'
    error?: string
  }
}

export interface CustomAgentMarketCatalog {
  generatedAt: number
  entries: CustomAgentMarketEntry[]
}

/**
 * 子 Agent 一次运行的 token/成本用量汇总（跨全部轮次累加）。
 * 由 QueryLoop 从每轮 model span 的四字段冒泡，经派发结果 envelope 回传父 Agent，
 * 供父侧成本感知（不派/派便宜模型的调度依据）。缺字段表示该次运行未回报对应指标。
 */
export interface SubAgentUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  costUsd?: number
  /** 已含在 outputTokens 里的推理 token。 */
  reasoningTokens?: number
  /** 已含在 inputTokens 里、命中 / 写入供应方缓存的部分；界面按缓存单价单独计价。 */
  cacheReadInputTokens?: number
  cacheWriteInputTokens?: number
}

export interface SubAgentTaskResult {
  thread_id: string
  status: SubAgentTaskResultStatus
  summary: string
  /** 调用方声明 output schema 时，经 QueryLoop 校验通过的规范化 JSON 值。 */
  structured_output?: LooseOptional<unknown>
  /** 本次子 Agent 运行的 token/成本用量汇总（跨全部轮次累加）。 */
  usage?: LooseOptional<SubAgentUsage>
  artifacts?: LooseOptional<SubAgentTaskArtifacts>
  tool_digest?: LooseOptional<SubAgentToolDigestEntry[]>
  model_trace?: LooseOptional<TeamModelSelectionTrace>
  wind_down_reason?: LooseOptional<SubAgentWindDownReason>
  full_digest_ref?: LooseOptional<string>
  /** 父 Agent 能否带 thread_id 续跑这条线程（它保留着之前的上下文）；缺省表示本结果不作判断。 */
  resumable?: LooseOptional<boolean>
  /** 可续跑线程的保留期限估计（epoch 毫秒）；线程过多时可能被更早淘汰，过期后续跑会明确报错。 */
  retained_until?: LooseOptional<number>
}

export interface SubAgentSessionRecord {
  thread_id: string
  /** 线程当前挂靠（或最后挂靠）的顶层执行；续跑会把线程重新挂到发起续跑的执行上。 */
  execution_id: string
  parent_session_id: string
  /** 派发时父上下文的资源标识（resourceId）；续跑须在同一资源上。 */
  resource_id?: LooseOptional<string>
  subagent_type: SubAgentTypeId
  status: SubAgentSessionStatus
  created_at: number
  updated_at: number
  request: SubAgentTaskRequest
  results: SubAgentTaskResult[]
}

export interface SubAgentWorkerOutcome {
  text: string
  result: SubAgentTaskResult
}

export type ExecutionStatus =
  | 'pending'
  | 'awaiting_confirmation'
  | 'running'
  | 'awaiting_input'
  | 'aborted'
  | 'completed'
  | 'failed'

export type ExecutionTaskStatus =
  | 'pending'
  | 'running'
  | 'awaiting_confirmation'
  | 'awaiting_input'
  | 'aborted'
  | 'completed'
  | 'failed'

export interface ExecutionInputRequest {
  question: string
  askedAt: number
}

export interface ExecutionConfirmationRequest {
  /** 当前卡的身份；回复必须携带，不能用 execution/session 身份替代。 */
  confirmationId?: string
  message: string
  askedAt: number
  userActionCards?: UserActionCard[]
  /** 结构化信封；缺席时消费方按 `message` 散文兜底。 */
  detail?: ConfirmationRequestDetail
}

export interface ExecutionProvideInputRequest {
  sessionId: string
  answer: string
}

export interface ExecutionResolveConfirmationRequest {
  sessionId: string
  confirmationId?: string
  approved: boolean
  rejectionMessage?: LooseOptional<string>
  userActionCardResults?: LooseOptional<UserActionCardResult[]>
}

export type ExecutionPendingInteractionKind = 'confirmation' | 'input'

export interface ExecutionHasPendingInteractionRequest {
  sessionId: string
  kind: ExecutionPendingInteractionKind
}

export type ExecutionPendingInteractionSnapshot =
  | {
      kind: 'confirmation'
      executionId: string
      confirmationId?: string
      message: string
      userActionCards?: LooseOptional<UserActionCard[]>
    }
  | {
      kind: 'input'
      executionId: string
      question: string
    }

export interface ExecutionHasPendingInteractionResult {
  available: boolean
  interaction?: LooseOptional<ExecutionPendingInteractionSnapshot>
}

export interface ExecutionAbortSubAgentWorkerRequest {
  sessionId: string
  threadId: string
  reason?: LooseOptional<string>
}

export interface ExecutionAbortSubAgentWorkerResult {
  aborted: boolean
}

export interface ExecutionRelaySubAgentGuidanceRequest {
  sessionId: string
  threadId: string
  message: string
}

export interface ExecutionRelaySubAgentGuidanceResult {
  relayed: boolean
}

export type ExecutionTaskPlanStepStatus =
  | 'pending'
  | 'delegated'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'

export interface ExecutionTaskPlanStep {
  id: string
  title: string
  roleId: AgentRoleId
  objective: string
  kind: 'respond' | 'prepare' | 'implement' | 'synthesize'
  mode: 'self' | 'delegated'
  required: boolean
  dependsOn: string[]
  actionable: boolean
  status: ExecutionTaskPlanStepStatus
  taskId: Nullable<string>
  updatedAt: Nullable<number>
  /**
   * 步骤来源：'scaffold' 是路由按 workflow 角色注入的默认占位步骤（如 operator-execute），
   * 'manual' 是模型经 plan:update 亲自编写的计划步骤。缺省视作 scaffold（兼容旧数据）。
   * 一旦存在 manual 步骤，角色 turn 的 scaffold 合并就不得再覆盖模型计划（见 mergeExecutionPlan）。
   */
  origin?: 'scaffold' | 'manual'
}

export interface ExecutionPlanViewStep extends ExecutionTaskPlanStep {
  active: boolean
  blockedBy: string[]
  linkedTaskTitle: Nullable<string>
  linkedTaskStatus: Nullable<ExecutionTaskStatus>
}

export interface ExecutionPlanViewSummary {
  total: number
  pending: number
  delegated: number
  running: number
  completed: number
  failed: number
  skipped: number
}

export interface ExecutionPlanView {
  taskId: string
  taskTitle: string
  activeStepId: Nullable<string>
  steps: ExecutionPlanViewStep[]
  summary: ExecutionPlanViewSummary
  recommendedAction: Nullable<ExecutionTaskRecommendedAction>
  executionAdvice: Nullable<ExecutionTaskExecutionAdvice>
}

export type ExecutionTaskRecommendedActionKind =
  | 'self'
  | 'delegate'
  | 'wait'
  | 'done'

export interface ExecutionTaskRecommendedAction {
  kind: ExecutionTaskRecommendedActionKind
  planStepId: Nullable<string>
  roleId: Nullable<AgentRoleId>
  title: string
  objective: string
  blockingStepIds: string[]
}

export type ExecutionTaskExecutionAdviceMode =
  | 'auto-continue'
  | 'prompt-delegation'
  | 'wait'
  | 'completed'

export interface ExecutionTaskExecutionAdvice {
  mode: ExecutionTaskExecutionAdviceMode
  planStepId: Nullable<string>
  roleId: Nullable<AgentRoleId>
  title: string
  objective: string
  reason: string
  blockingStepIds: string[]
}

export type ExecutionEventSeverity = 'info' | 'success' | 'warning' | 'error'

export type ExecutionEventKind =
  | 'execution-created'
  | 'execution-status-changed'
  | 'runtime-state-captured'
  | 'turn-context-captured'
  | 'assistant-output-captured'
  | 'tool-call-started'
  | 'tool-call-progress'
  | 'tool-call-metadata'
  | 'tool-call-completed'
  | 'task-created'
  | 'task-status-changed'
  | 'task-focus-changed'
  | 'plan-updated'
  | 'plan-step-updated'

export interface ExecutionEventRecord {
  id: string
  executionId: string
  kind: ExecutionEventKind
  severity: ExecutionEventSeverity
  title: string
  message: string
  timestamp: number
  taskId: Nullable<string>
  planStepId: Nullable<string>
  payload: Record<string, unknown>
}

export interface ExecutionTaskRecord {
  id: string
  kind: 'root' | 'delegated'
  title: string
  instruction: string
  roleId: Nullable<AgentRoleId>
  workflowType: Nullable<WorkflowType>
  expectedOutput: Nullable<AgentRoleExpectedOutputKind>
  delegatedByRoleId: Nullable<AgentRoleId>
  delegation: Nullable<AgentDelegationContract>
  suggestedNextRoles: AgentRoleId[]
  executionPlan: ExecutionTaskPlanStep[]
  recommendedAction: Nullable<ExecutionTaskRecommendedAction>
  linkedPlanStepId: Nullable<string>
  parentTaskId: Nullable<string>
  status: ExecutionTaskStatus
  createdAt: number
  updatedAt: number
  startedAt: Nullable<number>
  completedAt: Nullable<number>
  result: Nullable<string>
  error: Nullable<string>
}

export interface ExecutionRecord {
  id: string
  sourceSessionId: string
  status: ExecutionStatus
  summary: string
  resourceId: Nullable<string>
  createdAt: number
  updatedAt: number
  roleId: Nullable<AgentRoleId>
  roleLabel: Nullable<string>
  roleDescription: Nullable<string>
  awaitingConfirmation: Nullable<ExecutionConfirmationRequest>
  awaitingInput: Nullable<ExecutionInputRequest>
  error: Nullable<string>
  currentTaskId: string
  tasks: ExecutionTaskRecord[]
  events: ExecutionEventRecord[]
}

export type AppLocale = 'zh-CN' | 'en-US'

/** Product-owned role identifier. Core does not register built-in roles. */
export type AgentRoleId = string

export type WorkflowType = string

export type AgentRoleExpectedOutputKind = string

/** Host-neutral role contract supplied by an injected role provider. */
export interface AgentRoleProfileConfig {
  id: AgentRoleId
  label: string
  description: string
  skillMarkdown: string
  toolNames: string[]
  /** Opaque capability-scope policy interpreted by the provider that owns it. */
  scopePolicy?: unknown
  allowedNextRoles?: AgentRoleId[]
}

export interface AgentDelegationContract {
  title: string
  objective: string
  targetRoleId: AgentRoleId
  authorizedContext?: string
  authorizedToolCategories: ToolCategoryId[]
  expectedOutput: AgentRoleExpectedOutputKind
  canDelegateFurther: boolean
  delegatedByRoleId: AgentRoleId
  identity?: string
}

export type ToolApprovalRiskLevel = 'low' | 'high'

export interface PromptSegmentOverride {
  id: string
  enabled: boolean
  reason: Nullable<string>
  updatedAt: number
}

export type PermissionConfirmationMode = 'standard-open' | 'never-ask' | 'ask-every-time'

export type TurnContextSourceId = string

/** 摘要不足时可用哪个现有工具核实当前事实；argsHint 只能由事件自身字段构造。 */
export interface TurnContextInspectHint {
  tool: string
  argsHint?: Record<string, unknown>
}

export interface TurnContextDelta {
  /** 全局唯一：`${sourceId}#${seq}`。 */
  id: string
  sourceId: TurnContextSourceId
  /** source 内单调递增；source 内排序只信 seq。 */
  seq: number
  occurredAt: number
  /** composer/气泡 chip 短标签。 */
  label: string
  /** 冻结进 textBlocks 的最终文本；main 侧一次性格式化，冻结后不得重排版。 */
  summaryText: string
  inspect?: TurnContextInspectHint
}

/** 稳定态锚点；只在重发条件命中时随消息附加，不做成可删 chip。 */
export interface TurnContextAnchor {
  sourceId: TurnContextSourceId
  key: string
  text: string
}

export interface TurnContextSourcePeekInput {
  sessionId: string
  /** 上次已消费到的 seq；generation 不匹配时忽略此值。 */
  afterSeq: number
  /** 上次 cursor 的 generation；null 表示首次。 */
  generation: Nullable<string>
}

export interface TurnContextSourcePeekResult {
  /** source 实例代次（进程启动随机 id）；不匹配时消费方不回放旧 delta，只取 anchors。 */
  generation: string
  headSeq: number
  tailSeq: number
  /** ring buffer 已丢弃的边界：cursor 落在其之前说明有缺口，需附省略行并推进到 tailSeq。 */
  droppedBeforeSeq?: number
  deltas: TurnContextDelta[]
  anchors: TurnContextAnchor[]
}

export interface TurnContextSourceCursor {
  generation: string
  seq: number
}

export type TurnContextCursorVector = Partial<Record<TurnContextSourceId, TurnContextSourceCursor>>

/**
 * 发送时冻结在 user 消息上的回执；main 在 chat.send.accepted 后据此整向量幂等提交 cursor。
 * observedThrough 推进到本次 peek 的 tailSeq——含被用户删除的 delta，删掉的不会下轮重新出现。
 */
export interface ContextDeltaReceipt {
  observedThrough: TurnContextCursorVector
  includedDeltaIds: string[]
  dismissedDeltaIds: string[]
  /** `${space}|${contextViewId ?? 'raw'}|${anchorsHash}`；变化即重发 anchors。 */
  anchorGeneration: string
  /** anchors 最后一次实际附加的消息 id；距今 ≥ 心跳轮数时强制重发（防旧轮被摘要化）。 */
  anchorCarrierMessageId: string
}

/** 挂在 ChatMessage 上的环境上下文元数据：receipt 供协议，chips 供气泡展示。 */
export interface ChatMessageTurnContext {
  receipt: ContextDeltaReceipt
  chips: Array<{ sourceId: TurnContextSourceId; label: string }>
}

/** pre-send peek 请求（renderer → main，纯内存同步聚合）。 */
export interface ChatTurnContextPeekRequest {
  sessionId: string
  scope: CapabilityScopeId
}

/** delta 写入后的变更推送（main → renderer，写入侧防抖），驱动 composer chips 实时刷新。 */
export interface ChatTurnContextChangedEvent {
  sessionId: string
}

/** fan-in 聚合后经 IPC 给 renderer 的快照；renderer 据此渲染 chips 并在发送时冻结。 */
export interface TurnContextPeekSnapshot {
  sessionId: string
  scope: CapabilityScopeId
  capturedAt: number
  /** 各 source 本次 peek 的 {generation, tailSeq}，即 receipt.observedThrough 的基底。 */
  observedThrough: TurnContextCursorVector
  /** 已按 occurredAt/sourceId/seq 确定性排序、已应用 cap；renderer 只做 dismissed 过滤不得重排。 */
  deltas: TurnContextDelta[]
  anchors: TurnContextAnchor[]
  /** anchors 内容哈希；renderer 与 space/viewId 组合成 anchorGeneration。 */
  anchorsHash: string
  /** 溢出/缺口提示行（已格式化），冻结时置于 delta 文本之前。 */
  overflowNotes: string[]
}

export type AgentSkillSourceKind = 'builtin' | 'global' | 'project' | 'plugin'

export type AgentSkillSystemKind = 'system-bound' | 'optional-enhancement'

export interface AgentSkillDescriptor {
  id: string
  label: string
  description?: string
  sourceKind: AgentSkillSourceKind
  sourceId: string
  roleIds: AgentRoleId[]
  priority: number
  /** 是否展示在普通用户可见列表中。 */
  userVisible: boolean
  /** 调用提示（frontmatter `argument-hint`）：说明该技能期望怎样的输入/参数，索引段随描述展示。 */
  argumentHint?: string
  /** 每技能工具门控（frontmatter `allowed-tools`）：显式选中该技能的轮次，工具面收缩到声明集+交互必备。 */
  allowedTools?: readonly string[]
}

/** 文件式技能的对外摘要（设置页/聊天 / 列表用，不含正文）。 */
export interface SkillSummary {
  id: string
  name: string
  description: string
  version: Nullable<string>
  updatedAt: number
  sourceKind?: AgentSkillSourceKind
  systemKind?: AgentSkillSystemKind
  userVisible?: boolean
  enabled?: boolean
  toggleable?: boolean
  deletable?: boolean
  revealable?: boolean
  /** 必填且非空；通用 Skill 也必须显式列出宿主支持的全部空间。 */
  capabilityScopes: CapabilityScopeId[]
}

export interface SkillListRequest {
  includeHidden?: boolean
  includeDisabled?: boolean
}

export interface SkillSetEnabledRequest {
  id: string
  enabled: boolean
}

/** 技能市场条目（远端 manifest + 本地安装状态合成）。 */
export interface SkillMarketEntry {
  id: string
  name: string
  description: string
  version: string
  installState: 'not-installed' | 'installed' | 'update-available'
  install?: {
    phase: 'installing' | 'failed'
    error?: string
  }
}

export interface SkillMarketCatalog {
  generatedAt: number
  entries: SkillMarketEntry[]
}

export interface ContextUsageEstimate {
  /** 本地仅估算文本；图片、音频、文档的供应方专用计量不在此口径内。 */
  mediaTokenCoverage?: 'none' | 'unknown'
  mediaPartCount?: number
  estimatedTokens: number
  estimatedChars: number
  contextWindow: number
  /** 扣除输出预留与安全余量后的可用窗口；未启用预算调优时等于 contextWindow。 */
  usableContextWindow: number
  /** 本次计量采用的输出预留 token 数（未启用时为 0）。 */
  reservedOutputTokens: number
  tokenPercent: number
  payloadPercent: number
  percent: number
}

export interface SemverVersion {
  major: number
  minor: number
  patch: number
}

export type SemverComparator =
  | { kind: 'any' }
  | { kind: '=' | '>' | '>=' | '<' | '<='; version: SemverVersion }
  | { kind: '^' | '~'; version: SemverVersion }

export type AgentModContributionAxisName =
  | 'tools'
  | 'toolCategories'
  | 'promptSegments'
  | 'skills'
  | 'spaces'
  | 'subAgentTypes'
  | 'turnContextSources'
  | 'executionModes'
  | 'hooks'

export type AgentModHookEvent =
  | 'session:start'
  | 'session:end'
  | 'turn:start'
  | 'turn:end'
  | 'turn-context:assemble'
  | 'prompt:compose'
  | 'tool-call:before'
  | 'tool-call:after'
  | 'tool-result:after'
  | 'model-request:before'
  | 'model-response:after'
  | 'sub-agent:dispatch'
  | 'compaction:before'
  | 'skill:select'
  | 'diagnostic:publish'

/** @deprecated 只为现有调用方保留；新代码使用 HookEvent 命名。 */
export type AgentModSeamKind = AgentModHookEvent

export type AgentModCommandHandler = {
  type: 'command'
  entry: string
  permissions?: string[]
}

export type AgentModToolContribution = {
  name: string
  categoryId?: string
  summary?: string
  readOnly?: boolean
  permissions?: string[]
  inputSchema?: Record<string, unknown>
  handler?: AgentModCommandHandler
  availableInSpaces?: string[]
  residentInSpaces?: string[]
}

export type AgentModToolCategoryContribution = {
  id: string
  label: string
  description?: string
  order?: number
}

export type AgentModPromptSegmentContribution = {
  id: string
  stability: 'stable' | 'dynamic'
  priority: number
  label?: string
  retention?: 'normal' | 'protected'
  text?: string
}

export type AgentModSkillContribution = {
  id: string
  name: string
  spaces: string[]
  description?: string
  skillKind?: 'role' | 'capability'
  priority?: number
}

export type AgentModSpaceContribution = {
  id: string
  identityStrategy: 'path' | 'ordinal' | 'origin'
  descriptor?: {
    label: string
    hint?: string
    startTitle?: string
    order?: number
    localeKey?: string
  }
  iconId?: string
  surfaceProfileId?: string
  boundCapabilityIds?: string[]
  inheritsSpaceIds?: string[]
  toolCategoryIds?: string[]
  residentToolNames?: string[]
  turnContextSourceIds?: string[]
  promptSegmentIds?: string[]
}

export type AgentModSubAgentTypeContribution = {
  id: string
  label?: string
  description?: string
  toolCategoryIds?: string[]
  toolNames?: string[]
  readonlyDefault?: boolean
}

export type AgentModTurnContextSourceContribution = {
  id: string
  label?: string
  spaces?: string[]
  rendererVisible?: boolean
  priority?: number
}

export type AgentModExecutionModeContribution = {
  id: string
  label: string
  promptFeatureId?: LooseOptional<string>
  sessionSticky?: boolean
}

export type AgentModHookMatcher = {
  toolNames?: string[]
  phases?: string[]
  statuses?: string[]
}

/** @deprecated 新代码使用通用 AgentModCommandHandler。 */
export type AgentModCommandHookHandler = AgentModCommandHandler

export type AgentModHookExecutionMode = 'blocking' | 'background'

export type AgentModHookContribution = {
  event: 'session:start' | 'session:end' | 'turn:start' | 'turn:end' | 'turn-context:assemble' | 'prompt:compose' | 'tool-call:before' | 'tool-call:after' | 'tool-result:after' | 'model-request:before' | 'model-response:after' | 'sub-agent:dispatch' | 'compaction:before' | 'skill:select' | 'diagnostic:publish'
  id: string
  mode: 'blocking' | 'background'
  priority?: number
  reason?: string
  matcher?: AgentModHookMatcher
  timeoutMs?: number
  handler?: AgentModCommandHandler
}

export type AgentModContributes = {
  tools?: AgentModToolContribution[]
  toolCategories?: AgentModToolCategoryContribution[]
  promptSegments?: AgentModPromptSegmentContribution[]
  skills?: AgentModSkillContribution[]
  spaces?: AgentModSpaceContribution[]
  subAgentTypes?: AgentModSubAgentTypeContribution[]
  turnContextSources?: AgentModTurnContextSourceContribution[]
  executionModes?: AgentModExecutionModeContribution[]
  hooks?: AgentModHookContribution[]
}

export type AgentModTrustLevel = 'bundled-official' | 'marketplace-signed' | 'local-dev'

export type AgentModEngines = {
  velaros: string
  agent?: string
  shell?: Record<string, string>
}

export type AgentModManifest = {
  id: string
  version: string
  manifestSchemaVersion: 1
  engines: AgentModEngines
  trust: 'bundled-official' | 'marketplace-signed' | 'local-dev'
  contributes: AgentModContributes
  publisher?: string
  displayName?: string
  description?: string
  permissions?: string[]
  requiredAxes?: Array<'spaces' | 'tools' | 'toolCategories' | 'promptSegments' | 'skills' | 'subAgentTypes' | 'turnContextSources' | 'executionModes' | 'hooks'>
  entitlements?: string[]
  budget?: {
    residentPromptTokens?: number
  }
  locale?: Record<string, Record<string, string>>
}

/** 可读诊断：拒载/缺席/跳过一律经此上报，绝不静默。 */
export interface AgentModDiagnostic {
  code: string
  message: string
  path?: string
  modId?: string
  origin?: string
}

export type AgentModManifestParseResult =
  | { ok: true; manifest: AgentModManifest }
  | { ok: false; diagnostics: readonly AgentModDiagnostic[] }

export interface ParseAgentModManifestOptions {
  /** 诊断里回显的来源（pack 目录 / bundled id）。 */
  origin?: string
}

export type ToolCatalogEntry = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  category?: string
  readOnly?: boolean
}

export type ToolCatalogSnapshot = {
  protocolVersion: 1
  catalogRevision: string
  tools: ToolCatalogEntry[]
}

export type ContractLease = {
  contractId: string
  catalogRevision: string
  needsRefresh: boolean
  expiresInMs: Nullable<number>
}

export type VelarToolCallEnvelope = {
  protocolVersion: 1
  contractId: string
  catalogRevision: string
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
}

export type VelarToolResultStatus = 'error' | 'success' | 'denied'

export type VelarToolResultEnvelope = {
  protocolVersion: 1
  contractId: string
  catalogRevision: string
  toolCallId: string
  toolName: string
  status: VelarToolResultStatus
  output?: unknown
  error?: string
}

export type LeaseDenialReason = 'stale-revision' | 'unknown-contract' | 'unknown-tool' | 'out-of-scope' | 'malformed'

export type LeaseDeniedResponse = {
  protocolVersion: 1
  status: 'lease-denied'
  reason: LeaseDenialReason
  contractId: Nullable<string>
  latestCatalogRevision: string
}

export type AgentCapabilityExecutionChannel = 'agent' | 'state' | 'debug'

export interface AgentCapabilityExecutionSource {
  readonly productId: string
  readonly sessionId: string
  readonly correlationId?: string
}

export interface AgentCapabilityExecutionDescriptorV1 {
  readonly id: string
  readonly source: AgentCapabilityExecutionSource
  readonly scopeMetadata?: Readonly<Record<string, unknown>>
}

/** renderer/Host 订阅的统一 Agent 执行事件信封。 */
export interface AgentCapabilityExecutionEventEnvelopeV1 {
  readonly protocolVersion: 1
  readonly executionId: string
  readonly sourceProductId: string
  readonly sourceSessionId: string
  readonly sessionCorrelationId?: string
  readonly channel: AgentCapabilityExecutionChannel
  readonly payload: unknown
}

export type ExecutionSpanCategory = 'capability' | 'run' | 'turn' | 'model' | 'tool' | 'policy'

export type ExecutionSpanStatus = 'error' | 'ok' | 'aborted'

export type ExecutionSpanMetrics = {
  latencyMs: Nullable<number>
  tokensIn: Nullable<number>
  tokensOut: Nullable<number>
  costUsd: Nullable<number>
}

export type RunSpan = {
  category: 'run'
  rootInputId: Nullable<string>
  agentName: Nullable<string>
  dispatchSource: Nullable<string>
  spanId: string
  parentSpanId: Nullable<string>
  runId: Nullable<string>
  sessionId: string
  name: string
  startedAt: number
  endedAt: number
  status: ExecutionSpanStatus
  metrics: ExecutionSpanMetrics
}

export type TurnSpan = {
  category: 'turn'
  turn: number
  roleId: Nullable<string>
  model: Nullable<string>
  spanId: string
  parentSpanId: Nullable<string>
  runId: Nullable<string>
  sessionId: string
  name: string
  startedAt: number
  endedAt: number
  status: ExecutionSpanStatus
  metrics: ExecutionSpanMetrics
}

export type ModelSpan = {
  category: 'model'
  provider: string
  model: string
  requestFingerprint: Nullable<string>
  finishReason: Nullable<string>
  spanId: string
  parentSpanId: Nullable<string>
  runId: Nullable<string>
  sessionId: string
  name: string
  startedAt: number
  endedAt: number
  status: ExecutionSpanStatus
  metrics: ExecutionSpanMetrics
  errorCode?: LooseOptional<string>
  errorMessage?: LooseOptional<string>
}

export type ToolSpan = {
  category: 'tool'
  toolCallId: string
  toolName: string
  toolCategoryId: Nullable<string>
  errorCode: Nullable<string>
  spanId: string
  parentSpanId: Nullable<string>
  runId: Nullable<string>
  sessionId: string
  name: string
  startedAt: number
  endedAt: number
  status: ExecutionSpanStatus
  metrics: ExecutionSpanMetrics
  toolEffectKind?: LooseOptional<string>
}

export type CapabilitySpan = {
  category: 'capability'
  capabilityId: string
  operationId: string
  metadata: Record<string, unknown>
  spanId: string
  parentSpanId: Nullable<string>
  runId: Nullable<string>
  sessionId: string
  name: string
  startedAt: number
  endedAt: number
  status: ExecutionSpanStatus
  metrics: ExecutionSpanMetrics
}

export type PolicySpan = {
  category: 'policy'
  source: string
  action: string
  reason: string
  spanId: string
  parentSpanId: Nullable<string>
  runId: Nullable<string>
  sessionId: string
  name: string
  startedAt: number
  endedAt: number
  status: ExecutionSpanStatus
  metrics: ExecutionSpanMetrics
}

export type ExecutionSpan = RunSpan | TurnSpan | ModelSpan | ToolSpan | CapabilitySpan | PolicySpan

export type ExternalAgentBridgeCommand = {
  sequence: number
  type: string
  payload: Record<string, unknown>
}

export type ExternalAgentBridgeClientMessage = {
  version: 2
  type: 'probe'
} 
  | {
  version: 2
  type: 'pair'
  code: string
  provider: string
  capabilities: unknown
  tabUrl: string
  modelLabel: Nullable<string>
  providerSnapshot: unknown
} 
  | {
  version: 2
  type: 'resume'
  token: string
  deviceId: string
  after: number
} 
  | {
  version: 2
  type: 'ping'
} 
  | {
  version: 2
  type: 'ack'
  sequence: number
} 
  | {
  version: 2
  type: 'event'
  eventId: string
  event: Record<string, unknown>
} 
  | {
  version: 2
  type: 'disconnect'
}

export type ExternalAgentBridgeHostMessage = {
  version: 2
  type: 'hello'
  service: string
  protocol: 2
  pairingAvailable: boolean
  deviceId: Nullable<string>
} 
  | {
  version: 2
  type: 'paired'
  token: string
  device: Record<string, unknown>
} 
  | {
  version: 2
  type: 'resumed'
  device: Record<string, unknown>
  after: number
} 
  | {
  version: 2
  type: 'pong'
  at: number
} 
  | {
  version: 2
  type: 'event_ack'
  eventId: string
} 
  | {
  version: 2
  type: 'command'
  command: ExternalAgentBridgeCommand
} 
  | {
  version: 2
  type: 'disconnected'
} 
  | {
  version: 2
  type: 'error'
  code: string
  error: string
}

export type ExternalAgentBridgeMessage = ExternalAgentBridgeClientMessage | ExternalAgentBridgeHostMessage

export type ModelMessageRole = 'tool' | 'system' | 'user' | 'assistant'

export type ModelMessagePart = {
  type: 'text'
  text: string
} 
  | {
  type: 'tool-call'
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
} 
  | {
  type: 'tool-result'
  toolCallId: string
  toolName: string
  output: unknown
}

export type ModelMessage = {
  role: ModelMessageRole
  content: string | ModelMessagePart[]
}

export type SessionInputDelivery = 'queue' | 'steer'

export type SessionInfoEntry = {
  type: 'session-info'
  spaceId: string
  id: string
  parentId: Nullable<string>
  createdAt: number
}

export type MessageEntry = {
  type: 'message'
  message: ModelMessage
  id: string
  parentId: Nullable<string>
  createdAt: number
}

export type CompactionEntry = {
  type: 'compaction'
  summary: string
  replacedEntryIds: string[]
  id: string
  parentId: Nullable<string>
  createdAt: number
}

export type CustomEntry = {
  type: 'custom'
  customType: string
  data: unknown
  id: string
  parentId: Nullable<string>
  createdAt: number
}

export type CustomMessageEntry = {
  type: 'custom-message'
  customType: string
  message: ModelMessage
  data: unknown
  id: string
  parentId: Nullable<string>
  createdAt: number
}

export type ModelChangeEntry = {
  type: 'model-change'
  fromModelId: Nullable<string>
  toModelId: string
  id: string
  parentId: Nullable<string>
  createdAt: number
}

export type BranchSummaryEntry = {
  type: 'branch-summary'
  summary: string
  branchEntryId: string
  id: string
  parentId: Nullable<string>
  createdAt: number
}

export type SessionEntry = SessionInfoEntry | MessageEntry | CompactionEntry | CustomEntry | CustomMessageEntry | ModelChangeEntry | BranchSummaryEntry

export type SessionTarget = {
  sessionId: string
  seq: Nullable<number>
}

export type AdmitRequest = {
  sessionId: string
  inputId: string
  role: Nullable<ModelMessageRole>
  content: string
  delivery: Nullable<SessionInputDelivery>
  metadata: Nullable<Record<string, unknown>>
  parts?: ModelMessagePart[]
}

export type AdmitReceipt = {
  inputId: string
  sessionId: string
  seq: number
}

export type WakeRequest = {
  sessionId: string
  seq: Nullable<number>
}

export type SteerRequest = {
  sessionId: string
  inputId: string
  role: Nullable<ModelMessageRole>
  content: string
}

export type AnswerRequest = {
  sessionId: string
  seq: Nullable<number>
  answer: string
}

export type ApproveRequest = {
  sessionId: string
  seq: Nullable<number>
  approved: boolean
  rejectionMessage: Nullable<string>
  approvalPayload: unknown
}

export type CancelRequest = {
  sessionId: string
  seq: Nullable<number>
}

export type CancelResult = {
  aborted: boolean
}

export type RuntimeStatusRequest = {
  sessionId: string
  seq: Nullable<number>
}

export type RuntimeStatusResponse = {
  hasPendingConfirmation: boolean
  hasPendingInput: boolean
  running: boolean
  pendingPrompt: boolean
  cancelRequested: boolean
  cancellable: boolean
  queuedInputs: number
  backgroundJobs: number
}

export type SessionEventPayload = {
  kind: 'lifecycle'
  phase: string
} | {
  kind: 'custom'
  customType: string
  data: unknown
}

export type SessionEventEnvelope = {
  sessionId: string
  sequence: number
  event: SessionEventPayload
}

export type HostProjection = {
  hostId: string
  includeCategories: Nullable<string[]>
  excludeToolNames: Nullable<string[]>
}

export type ResolveCatalogRequest = {
  hostProjection: HostProjection
}

export type DescribeToolSchemaRequest = {
  name: string
}

export type DescribeToolSchemaResponse = {
  tool: ToolCatalogEntry
  catalogRevision: string
}

export type ExecuteToolRequest = {
  protocolVersion: 1
  contractId: string
  catalogRevision: string
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
}

export type ExecuteToolResponse = {
  protocolVersion: 1
  contractId: string
  catalogRevision: string
  toolCallId: string
  toolName: string
  status: VelarToolResultStatus
  output?: unknown
  error?: string
}

export type RunTurnOptions = {
  modelId?: string
  maxToolTurns?: number
}

export type RunTurnRequest = {
  messages: ModelMessage[]
  tools: ToolCatalogEntry[]
  options?: RunTurnOptions
}

export type RunTurnResponse = {
  messages: ModelMessage[]
  toolResults: VelarToolResultEnvelope[]
}

/**
 * A product-level Agent surface is a host-neutral composition contract.
 *
 * It selects existing capability Skills by default. The selected Skills remain
 * subject to host enablement, scope, entitlement and pure-chat policies; this
 * contract does not grant tools, permissions or workflow authority.
 */
export interface AgentProductSurfaceDefinition {
  readonly id: AgentSurfaceId
  readonly defaultSkillIds: readonly string[]
}

export interface AgentSurfaceContextEntry {
  readonly id: string
  readonly label: string
  readonly content: string
  readonly source?: string
}

/** Immutable domain-data snapshot captured by a product surface for one turn. */
export interface AgentSurfaceContextSnapshot {
  readonly revision: string
  readonly entries: readonly AgentSurfaceContextEntry[]
}
