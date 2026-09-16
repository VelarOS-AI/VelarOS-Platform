
import type { ModelMessage } from 'ai'

import type { AppError } from '@velaros-ai/core/error'
import type { ScopedLog } from '@velaros-ai/core/logger'

import type { AgentRuntimeCapabilityPorts,ApprovalPort, ContextPayloadStore, ToolExecutionApi } from '../contract/requires.js'

import type { ChatPromptFeatureId } from './agent'
import type { AgentEvent, AgentModelInputModality, AgentRoleId, CapabilityAutoApprovalNotice, CapabilityScopeId, ChatRuntimeEvent, ExecutionRecord, ExecutionTaskRecord, RunProfileSelectionId, StreamToolCallPayload, StreamToolMetadataPayload, StreamToolProgressPayload, StreamToolResultEffects, StreamToolResultPayload, ToolAvailabilityScope, ToolCapabilitySchema, ToolCategoryId, ToolCategoryOverview,ToolConfirmationDecisionOptions, ToolDescriptor, ToolExecutionPlanUpdate, ToolExposurePolicy, ToolOsState, ToolPermission, ToolProviderKind, ToolResultModelContentPart, ToolRole, ToolSurfaceProfileId } from './agent.js'
import type { ToolResultModelImage, ToolValidationIssueDetail } from './capabilities.js'
import type { ContextRefEnvelope } from './context.js'
import type { ToolSpanHandle } from './ledgers.js'
import type { AppliedAdjustment,ToolInputReuseContract, ToolInputReuseMigrationRequest } from './toolkit.js'

export interface ToolRegistryCodingSession {
  isToolCategoryAllowed: (categoryId: ToolCategoryId) => boolean
  hasToolCategoryAccess(categoryId: ToolCategoryId): boolean
  hasActiveToolCategoryAccess: (categoryId: ToolCategoryId) => boolean
  /**
   * 具体工具是否由 tooling:replace 显式换入。
   *
   * Prompt feature 是产品入口选择，不是第二套工具权限。显式工具租约只对这一项
   * schema 生效，仍需通过类别、作用域、系统开关和工具自身运行态闸门。
   */
  hasToolNameAccess?: (toolName: string) => boolean
  hasPromptFeatureAccess: (feature: ChatPromptFeatureId) => boolean
  getToolSurfaceProfile: () => ToolSurfaceProfileId
  /** 会话声明/切换后的当前能力作用域；可选——外部端口缺失时回退运行态推断。 */
  getActiveCapabilityScope?: () => CapabilityScopeId
}

export interface ToolRegistryContext {
  role: {
    id: AgentRoleId
  }
  codingSession: ToolRegistryCodingSession
  capabilityPorts?: AgentRuntimeCapabilityPorts
  isToolSystemEnabled(toolName: string): boolean
  /** 本轮实际模型声明支持的输入类型；缺席表示未知，注册表允许 provider 实际尝试。 */
  getSupportedModelInputModalities?: () => readonly AgentModelInputModality[]
}

export interface RegistryTool<TContext extends ToolRegistryContext = ToolRegistryContext> extends ToolInputReuseContract<TContext> {
  description: string
  /** companion skill id；描述末尾已带指路行，这里让工具页卡片也能结构化透出。 */
  usageSkillId?: string
  role?: ToolRole
  permissions: ToolPermission[]
  capabilities?: ToolCapabilitySchema
  requiredModelInputModalities?: readonly AgentModelInputModality[]
  exposure?: ToolExposurePolicy
  /** 输出禁止 page-out、始终内联（发现/索引类工具，如 tooling:map）。 */
  outputInline?: boolean
  /** 运行依赖不存在时从工具发现层彻底移除，而不是展示为不可用。 */
  hideWhenUnavailable?: boolean
  isAvailable?: (ctx: TContext) => boolean
  /**
   * 不可用时给发现层的**具体原因**（`hideWhenUnavailable: false` 的工具必须回答这一句）。
   *
   * 留在页表里却只给一句泛化的「当前运行态不可用」，模型读到的就是「此路不通」——与整族隐身
   * 同一个结局。返回 null = 没有比泛化文案更具体的可说的。
   */
  unavailableReason?: (ctx: TContext) => Nullable<string>
}

export interface RegisteredTool<TTool extends RegistryTool<any> = RegistryTool<any>> {
  descriptorId?: string
  registrationSignature?: string
  categoryId: ToolCategoryId
  providerId?: string
  providerKind?: ToolProviderKind
  registrationStatus?: 'active' | 'overridden'
  overriddenByProviderId?: string
  overriddenByProviderKind?: ToolProviderKind
  tool: TTool
}

export type RegisteredToolMap<TTool extends RegistryTool<any> = RegistryTool<any>> = Map<
  string,
  RegisteredTool<TTool>
>

export type ToolCapabilityPageKind = 'tool'

export type ToolCapabilitySchemaPolicy = 'full' | 'preview' | 'hidden' | 'none'

export interface ToolCapabilityReason {
  layer: string
  code: string
  message: string
  details?: Record<string, unknown>
}

export interface ToolCapabilityPage {
  id: string
  kind: ToolCapabilityPageKind
  name: string
  categoryId: ToolCategoryId
  descriptor: ToolDescriptor
  permissions: ToolPermission[]
  availability: ToolDiscoveryAvailability
  schemaState: ToolDiscoverySchemaState
  schemaPolicy: ToolCapabilitySchemaPolicy
  nextAction: ToolDiscoveryNextAction
  resident: boolean
  reasons: ToolCapabilityReason[]
}

export interface ToolCapabilityRegistryListOptions {
  allowList?: string[]
  scope?: ToolAvailabilityScope
}

export type ToolCapabilityRegistryContext = ToolRegistryContext & {
  getCurrentVisibleToolNames(): string[]
}

export type ToolAllocatorOperation = string

export interface ToolAllocatorRequest {
  intent: string
  operations: readonly ToolAllocatorOperation[]
  targets?: readonly string[]
  reason: string
}

export interface ToolAllocatorCategory<TTool extends { name: string } = ToolDescriptor> {
  category: { id: ToolCategoryId }
  tools: readonly TTool[]
}

export type ToolAllocatorDenialCode =
  | 'not_implemented'
  | 'role_blocked'
  | 'request_fuse_tripped'
  | 'prerequisite_missing'
  | 'delegated'
  | (string & {})

export interface ToolAllocatorDeniedRequest {
  operation: ToolAllocatorOperation
  categoryId: ToolCategoryId
  code: ToolAllocatorDenialCode
  message: string
}

export interface ToolAllocatorFuseState {
  tripped: boolean
  message?: string
}

export interface ToolAllocatorAdvisorState {
  called: boolean
  message?: string
  error?: string
}

export interface SessionToolAllocatorPlan {
  baselineToolNames: string[]
  grantedCategoryIds: ToolCategoryId[]
  grantedToolNames: string[]
  deniedRequests: ToolAllocatorDeniedRequest[]
  fuse: ToolAllocatorFuseState
  advisor: ToolAllocatorAdvisorState
  message: string
}

export interface ToolAllocatorRuntimeIndex<TTool extends { name: string }> {
  categoryMap: Map<ToolCategoryId, TTool[]>
  toolNames: Set<string>
}

export type ToolInputReuse = {
  reuse: string
  changes: Array<{
    op: 'set' | 'remove'
    path: Array<string | number>
    value?: unknown
  }>
}

export type ToolAttemptOutcome = 'not-applied' | 'completed' | 'unknown'

export interface ToolInputReuseContext {
  sessionId?: string
  resourceId?: string
  contextPayloadStore?: ContextPayloadStore
  project?: { getRootPath(): string }
}

export interface AttemptInput {
  kind: 'tool-attempt-input'
  version: 1
  contractVersion?: number
  toolName: string
  scope?: string
  args: Record<string, unknown>
}

export interface ToolInputReuseOptions {
  inputContractVersion?: number
  inputReuseSourceTools?: readonly string[]
  migrateReusedInput?: (
    request: ToolInputReuseMigrationRequest
  ) => Promise<Record<string, unknown>> | Record<string, unknown>
}

export type ToolInputChange = ToolInputReuse['changes'][number]

export interface MaterializeKernelToolResultInput {
  sessionId?: LooseOptional<string>
  localInstructionClaimScope?: LooseOptional<string>
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  result: unknown
  error?: LooseOptional<string>
  effects?: StreamToolResultEffects
  notices?: Array<Extract<AgentEvent, { type: 'notice' }>>
  /** 工具声明 outputInline：跳过 page-out，输出始终内联（不卸载为 payload 引用）。 */
  keepOutputInline?: boolean
}

export interface MaterializedKernelToolResult {
  displayResult: unknown
  modelResult: unknown
  effects: StreamToolResultEffects
  notices: Array<Extract<AgentEvent, { type: 'notice' }>>
  storedOutput: Nullable<KernelStoredToolOutput>
}

export interface ToolTransportNamePlan {
  readonly canonicalToProvider: Readonly<Record<string, string>>
  readonly providerToCanonical: Readonly<Record<string, string>>
}

export interface ToolTransportProjection {
  readonly plan: ToolTransportNamePlan
  readonly visibleCanonicalToProvider: Readonly<Record<string, string>>
}

export interface ProviderToolReferenceCanonicalizer {
  push(text: string): string
  flush(): string
}

export type ToolVisibleSurfaceProfileId = ToolSurfaceProfileId | 'base'

export interface ToolExecutionPolicySurface<TSurfaceInput = any, TBaseInput = any> {
  schema: ToolSchema<TSurfaceInput>
  normalize?: (input: TSurfaceInput, context: any) => TBaseInput
}

export interface ToolExecutionPolicyTool<TInput = any> extends ToolInputReuseContract<any> {
  schema: ToolSchema<TInput>
  surfaces?: Partial<Record<ToolSurfaceProfileId, ToolExecutionPolicySurface<any, TInput>>>
  permissions?: readonly ToolPermission[]
  capabilities?: ToolCapabilitySchema
  execute(input: TInput, context: ToolExecutionPolicyContext): Promise<unknown> | unknown
  isConcurrencySafe?: (input: Record<string, unknown>) => boolean
}

export interface ToolExecutionPolicyRegistry {
  get(toolName: string): LooseOptional<ToolExecutionPolicyTool<any>>
  getRegistrationSignature?: (toolName: string) => LooseOptional<string>
  /**
   * 从 turn 快照背后的可变注册表读取当前签名。
   * getRegistrationSignature 保留 provider 曝光时的冻结值；此方法在执行前检测替换/卸载。
   */
  getCurrentRegistrationSignature?: (toolName: string) => LooseOptional<string>
  listAvailable(
    toolContext: unknown,
    allowList?: string[],
    scope?: ToolAvailabilityScope
  ): Array<{ name: string }>
  getDescriptor(
    toolName: string
  ): LooseOptional<{
    categoryId?: ToolCategoryId
    capabilities?: ToolCapabilitySchema
    role?: ToolRole
    outputInline?: boolean
    requiredModelInputModalities?: readonly AgentModelInputModality[]
  }>
}

export interface ToolExecutionPolicyCodingSession {
  recordToolResult(toolName: string, output: unknown): void
  recordToolCallResult?: (toolName: string, args: Record<string, unknown>, output: unknown) => void
  recordInvisibleToolCall?: (toolName: string) => void
  getRedundantToolCallMessage: (
    toolName: string,
    args: Record<string, unknown>
  ) => LooseOptional<string>
  consumePendingAutoApprovalNotice: (
    categoryId: ToolCategoryId
  ) => LooseOptional<CapabilityAutoApprovalNotice>
  hasSessionToolCategoryApproval: (categoryId: ToolCategoryId) => boolean
  grantSessionToolCategoryApproval?: (categoryId: ToolCategoryId) => unknown
  getToolSurfaceProfile: () => ToolSurfaceProfileId
  setToolSurfaceProfile: (profile: ToolSurfaceProfileId, reason?: string) => ToolSurfaceProfileId
  getRunProfile: () => RunProfileSelectionId
  setRunProfile: (profile: RunProfileSelectionId, reason?: string) => RunProfileSelectionId
  /** 会话声明/切换后的当前能力作用域；可选——缺失时回退运行态推断。 */
  getActiveCapabilityScope?: () => CapabilityScopeId
}

export interface ToolExecutionPolicyExecution {
  awaitConfirmation?: ApprovalPort['awaitConfirmation']
  awaitConfirmationDecision(
    message: string,
    abortSignal: AbortSignal,
    options?: ToolConfirmationDecisionOptions
  ): Promise<{
    approved: boolean
    message?: LooseOptional<string>
  }>
}

export interface ToolExecutionPolicyContext {
  /** Original model call identity for host approval and durable tool execution. */
  toolCallId?: string
  abortSignal: AbortSignal
  log: ScopedLog
  planningMode?: boolean
  codingSession: ToolExecutionPolicyCodingSession
  /** Concrete capability behavior is supplied by the composition root. */
  capabilityPorts?: AgentRuntimeCapabilityPorts
  role: { id: AgentRoleId }
  getCurrentVisibleToolSurfaceProfile: (
    toolName: string
  ) => LooseOptional<ToolVisibleSurfaceProfileId>
  getCurrentVisibleToolNames?: () => string[]
  resolveCurrentVisibleCanonicalToolName?: (providerToolName: string) => LooseOptional<string>
  getCurrentVisibleToolRegistrationSignature?: (toolName: string) => LooseOptional<string>
  execution: LooseOptional<ToolExecutionPolicyExecution>
  approval?: ApprovalPort
  emitProgress?: (chunk: string) => void
  updateMetadata?: (payload: { title?: string; metadata?: Record<string, unknown> }) => void
}

export type AnyVelaTool = ToolExecutionPolicyTool<any>

export interface ToolExecutionRequest {
  /** 模型生成的 tool call id。 */
  toolCallId: string
  /** 工具名。 */
  toolName: string
  /** 模型生成的工具参数。 */
  args?: Record<string, unknown>
  /** 本轮基础 ToolContext。 */
  baseContext: ToolExecutionPolicyContext
  /** 当前工具独立的取消信号。 */
  abortSignal: AbortSignal
  /** 当前 tool call 的进度回调，由 ToolExecutor 按 toolCallId 绑定。 */
  emitProgress?: (chunk: string) => void
  /** 当前 tool call 的结构化展示元数据回调，由 ToolExecutor 按 toolCallId 绑定。 */
  updateMetadata?: (payload: { title?: string; metadata?: Record<string, unknown> }) => void
  /** Registry 可用性过滤范围；普通调用只允许 enabled，反射代理可请求 all 以覆盖 loadable 工具。 */
  availabilityScope?: ToolAvailabilityScope
}

export interface ToolExecutionPrepared {
  /** Registry 中实际执行的 canonical 工具名。 */
  toolName: string
  /** 通过 Registry 找到的工具定义。 */
  tool: AnyVelaTool
  /** 模型发出调用时激活的工具表面；为空则使用主 schema。 */
  selectedSurface?: LooseOptional<ToolExecutionPolicySurface<any, any>>
  /** schema 与 surface normalize 之后的实际工具参数；旧的外部 prepared 调用方可省略。 */
  effectiveArgs?: Record<string, unknown>
  /** prepare 阶段的校验结果；旧调用方省略时 executePrepared 会兼容性补算。 */
  validationResult?: ToolArgsValidationResult<any>
  /** prepare 时绑定的注册签名；实际准入时用于识别等待期间的替换或卸载。 */
  registrationSignature?: LooseOptional<string>
  /** 为当前工具覆写过 log/abortSignal 的上下文。 */
  toolContext: ToolExecutionPolicyContext
}

export type ToolExecutionDecision =
  | {
      allowed: true
      prepared: ToolExecutionPrepared
    }
  | {
      allowed: false
      error: string
      /** 若模型工具名已修复为 canonical 名，这里用于失败结果继续使用同一个名字。 */
      toolName?: string
    }

export interface ToolExecutionSuccessInput {
  toolName: string
  args: Record<string, unknown>
  output: unknown
  toolContext: ToolExecutionPolicyContext
}

export interface ToolExecutionFailureInput {
  toolName: string
  error: AppError
  isConcurrencySafe: boolean
}

/** 工具死循环守卫的一次记账输入。 */
export interface KernelToolLoopGuardInput {
  /** 工具名。 */
  toolName: string
  /** 工具入参。 */
  args: Record<string, unknown>
  /** 这次调用是不是写类操作。 */
  writeLike: boolean
}

export interface KernelToolFailureBatchEntry {
  toolName: string
  /** 使用实际执行参数，区分相同错误下对不同目标的探索。 */
  args?: Record<string, unknown>
  error: string
}

export type OverriddenToolMap<TTool extends RegistryTool<any> = RegistryTool<any>> = Map<
  string,
  Array<RegisteredTool<TTool>>
>

export interface ToolExecutionApiHost {
  awaitConfirmation: (
    executionId: string,
    ...args: Parameters<ToolExecutionApi['awaitConfirmation']>
  ) => ReturnType<ToolExecutionApi['awaitConfirmation']>
  awaitConfirmationDecision: (
    executionId: string,
    ...args: Parameters<ToolExecutionApi['awaitConfirmationDecision']>
  ) => ReturnType<ToolExecutionApi['awaitConfirmationDecision']>
  awaitUserInput: (
    executionId: string,
    ...args: Parameters<ToolExecutionApi['awaitUserInput']>
  ) => ReturnType<ToolExecutionApi['awaitUserInput']>
  startTask: (executionId: string, taskId: string) => void
  completeTask: (executionId: string, taskId: string, result?: LooseOptional<string>) => void
  failTask: (executionId: string, taskId: string, error: string) => void
  getExecution: (executionId: string) => ExecutionRecord
  getCurrentTask: (executionId: string) => ExecutionTaskRecord
  getCurrentPlan: (executionId: string) => ReturnType<ToolExecutionApi['getCurrentPlan']>
  updateCurrentPlan: (
    executionId: string,
    input: ToolExecutionPlanUpdate
  ) => ReturnType<ToolExecutionApi['updateCurrentPlan']>
  getCurrentRecommendedAction: (
    executionId: string
  ) => ExecutionTaskRecord['recommendedAction']
  getCurrentExecutionAdvice: (
    executionId: string
  ) => ReturnType<ToolExecutionApi['getCurrentExecutionAdvice']>
}

// B3:kernel 页出桩统一为 ContextRefEnvelope(唯一持久化桩;旧 __kernelRef 归档由
// isFoldStubText/normalizeLegacyFoldStub 永久只读兼容)。outputId/hash 归 meta。
export type KernelToolOutputProjection = ContextRefEnvelope

export interface KernelStoredToolOutput {
  outputId: string
  payloadRef?: string
  hash?: string
  sessionId: string
  toolCallId: string
  toolName: string
  output: unknown
  serialized: string
  chars: number
  createdAt: number
  sameAsToolCallId?: string
}

export interface ProjectKernelToolOutputInput {
  sessionId?: LooseOptional<string>
  toolCallId: string
  toolName: string
  output: unknown
}

export interface ProjectKernelToolOutputResult {
  output: unknown
  stored: Nullable<KernelStoredToolOutput>
}

export interface ContextPayloadKernelToolOutputStoreOptions {
  projectionChars?: number
}

export interface ToolExecutorEvents {
  emitRuntime(event: ChatRuntimeEvent): void;
  emitNotice(event: Extract<AgentEvent, { type: "notice" }>): void;
  emitToolStart(payload: StreamToolCallPayload): void;
  emitToolProgress?(payload: StreamToolProgressPayload): void;
  emitToolMetadata?(payload: StreamToolMetadataPayload): void;
  emitToolDone(payload: StreamToolResultPayload): void;
}

export interface ActiveToolExecutionContext {
  toolName: string;
  args: Record<string, unknown>;
  isConcurrencySafe: boolean;
  toolContext: ToolExecutionPolicyContext;
}

export interface ToolEffectiveAdmission {
  state: "pending" | "waiting" | "active" | "released";
  isConcurrencySafe?: boolean;
  resolve?: (admitted: boolean) => void;
  abortSignal?: AbortSignal;
  abortListener?: () => void;
}

export interface PendingTool {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  /** 是否可与其他工具并发执行 */
  isConcurrencySafe: boolean;
  status: "queued" | "executing" | "done";
  promise?: Promise<ToolResult>;
  result?: ToolResult;
  /**
   * 本工具的观测 tool span handle（可选端口装配时才有；缺省 = 不产 span）。
   * 在 {@link ToolExecutor.runOne} 开工时开启，在 {@link ToolExecutor.finalizeResult}（唯一终结点）
   * 收敛后置空——单开单闭、纯旁路，span 失败不冒泡进执行主路。
   */
  spanHandle?: LooseOptional<ToolSpanHandle>;
}

export interface ScheduledTool extends PendingTool {
  /** before/schema/surface normalize 后，按接收顺序授予的实际调用槽。 */
  effectiveAdmission: ToolEffectiveAdmission;
  attemptSaved?: boolean;
  requestedInputChars?: number;
  inputReused?: boolean;
  operationStarted?: boolean;
  /** 拿到调用槽、真正开始执行的时刻；同一批里排队等其他工具的时间不算在这个工具头上。 */
  executionStartedAt?: number;
  /** 最近一次转发给宿主的工具元数据：宿主可能整份替换元数据，补发执行开始时刻时连同它一起发。 */
  lastMetadata?: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  toolName: string;
  args?: Record<string, unknown>;
  result: unknown;
  modelResult?: unknown;
  error?: string;
  modelContent?: ToolResultModelContentPart[];
  modelImage?: ToolResultModelImage;
  effects?: StreamToolResultEffects;
  notices?: Array<Extract<AgentEvent, { type: "notice" }>>;
}

export type ToolExecutionSettlement =
  | { status: "completed"; result: ToolResult }
  | { status: "failed"; error: unknown }
  | { status: "aborted" };

export type ToolCategoryUnavailableReason = string

export interface ToolAccessRuntimeState {
  roleId: AgentRoleId
  activeCapabilityScope?: CapabilityScopeId
  capabilityPorts?: AgentRuntimeCapabilityPorts
  satisfiedScopeFactIds?: readonly string[]
}

export interface ToolCategoryAccessDecision {
  allowed: boolean
  reason: Nullable<ToolCategoryUnavailableReason>
  message?: string
}

export type ToolAccessLayer = string

export type ToolAccessPageKind = 'tool' | 'capability' | 'plugin'

export type ToolAccessFinalState = ToolDiscoveryAvailability

export interface ToolAccessReason {
  layer: ToolAccessLayer
  code: string
  message: string
  details?: Record<string, unknown>
}

export interface ToolAccessGates {
  catalog: 'ready' | 'role_blocked' | 'system_disabled'
  capability: 'enabled' | 'default_open' | 'loadable' | 'requires_approval'
  runtime: 'ready' | 'tool_unavailable'
  security: 'granted'
  approval: 'not_required' | 'auto_approved' | 'manual_required' | 'rejected'
  residency: 'visible' | 'loadable' | 'not_resident'
  plugin: 'not_required' | 'enabled' | 'requires_user_action'
}

export interface ToolAccessDecision {
  targetId: string
  kind: ToolAccessPageKind
  toolName?: string
  categoryId: ToolCategoryId
  finalState: ToolAccessFinalState
  toolOsState: ToolOsState
  nextAction: ToolDiscoveryNextAction
  gates: ToolAccessGates
  reasons: ToolAccessReason[]
}

export interface BuildToolAccessDecisionInput {
  targetId: string
  kind: ToolAccessPageKind
  toolName?: string
  categoryId: ToolCategoryId
  finalState: ToolAccessFinalState
  nextAction: ToolDiscoveryNextAction
  categoryAllowed: boolean
  categoryEnabled: boolean
  categoryAccessAllowed: boolean
  categoryUnavailableReason: Nullable<ToolCategoryUnavailableReason>
  systemEnabled?: boolean
  pluginBacked: boolean
  visible: boolean
  runtimeAvailable: boolean
  requiresApproval: boolean
  reasons: readonly ToolAccessReason[]
}

export interface ToolSpaceRecoveryGuide {
  query: string
  pageId: string
  capabilityId: Nullable<string>
  nextActions: string[]
}

export type ToolDiscoveryAvailability =
  | 'visible'
  | 'loadable'
  | 'requires_approval'
  | 'requires_user_action'
  | 'unavailable'

export type ToolDiscoverySchemaState = 'visible' | 'hidden' | 'not_applicable'

export type ToolDiscoveryNextAction =
  | 'call_tool'
  | 'describe'
  | 'replace_page'
  | 'request_approval'
  | 'request_user_action'
  | 'none'

export interface ToolDiscoveryCategoryAvailabilityInput {
  categoryId: ToolCategoryId
  categoryEnabled: boolean
  categoryAllowed: boolean
  categoryAccessAllowed: boolean
  categoryUnavailableReason: Nullable<ToolCategoryUnavailableReason>
  pluginBacked: boolean
  hasRuntimeAvailableTool: boolean
  requiresApproval: boolean
}

export interface ToolDiscoveryToolAvailabilityInput extends ToolDiscoveryCategoryAvailabilityInput {
  toolName?: string
  systemEnabled: boolean
  visible: boolean
  runtimeAvailable: boolean
}

export interface ErrorCauseRecord {
  reason?: unknown
  details?: unknown
  suggestedNextAction?: unknown
  cause?: unknown
}

export interface RuntimeToolIssue {
  severity: 'requires_diagnosis'
  action: 'model_report_diagnosis_then_continue_or_stop'
  requiredClassification: Array<'system_or_runtime_bug' | 'model_decision_issue'>
  systemBugBehavior: string
  modelDecisionBehavior: string
}

export interface ToolFailureResult {
  error: string
  reason: string
  toolName: string
  code?: string
  details?: Record<string, unknown>
  nextActions?: string[]
  toolSpaceRecovery?: ToolSpaceRecoveryGuide
  runtimeToolIssue?: RuntimeToolIssue
}

export interface ToolFailureBuildOptions {
  code?: string
  details?: Record<string, unknown>
  nextActions?: string[]
  recovery?: ToolSpaceRecoveryGuide
}

/** A tool can use this envelope when its ordinary result is not itself an object. */
export interface ToolResultModelContentEnvelope {
  result: unknown
  modelContent: readonly ToolResultModelContentPart[]
}

export interface ToolResultCompactionLimits {
  maxSerializedLength: number;
  maxStringLength: number;
  maxDepth: number;
  maxArrayItems: number;
  preserveLargeContent: boolean;
}

/**
 * 工具序列化提示：允许调用方传入工具输入参数中的大内容上限，
 * 序列化层据此动态放大 maxSerializedLength 并豁免大内容字段的字符串长度截断。
 */
export interface SerializationHints {
  /**
   * bash 的 maxOutputChars 参数；指定后序列化上限动态扩展到该值加 JSON 封装开销。
   */
  maxOutputChars?: number;
  /**
   * read_file / project:read 的 maxChars 或 maxBytes；指定后内容预算随之扩展。
   */
  maxChars?: number;
}

export interface ToolSchemaIssue {
  path: PropertyKey[]
  message: string
  expected?: unknown
  code?: unknown
  errors?: ToolSchemaIssue[][]
  /** unrecognized_keys 的多余字段。 */
  keys?: unknown
  /** invalid_value 的可选值。 */
  values?: unknown
}

export type ToolSchemaResult<TInput> =
  | {
      success: true
      data: TInput
    }
  | {
      success: false
      error: {
        issues: ToolSchemaIssue[]
      }
    }

export type ToolSchema<TInput> = {
  safeParse(input: unknown): ToolSchemaResult<TInput>
}

export type ToolSchemaIssueDetail = ToolValidationIssueDetail

export type ToolInputAdjustment = AppliedAdjustment

export type ToolArgsValidationResult<TInput> =
  | {
      success: true
      data: TInput
      /** 真正交给工具执行、写入历史和去重账本的参数。 */
      args: Record<string, unknown>
      /** 模型最初提交的参数快照，仅用于诊断调整，不进入工具执行。 */
      requestedArgs: Record<string, unknown>
      normalized: boolean
      adjustments: ToolInputAdjustment[]
    }
  | {
      success: false
      error: { issues: ToolSchemaIssue[] }
      issues: ToolSchemaIssueDetail[]
    }

export interface ToolInputAdjustmentCollector {
  adjustments: ToolInputAdjustment[]
  truncated: boolean
}

export interface Omission {
  path: Array<string | number>
  jsonPath: string
  chars?: number
  items?: number
  ref?: string
}

export type RecordValue = Record<string, unknown>

export type Line = [number, string]

export type Fragment = { line: number; columns: [number, number]; text: string }

export type ToolSpacePageKind = 'tool' | 'capability' | 'plugin'

export type ToolSpacePageRisk = 'none' | 'read' | 'write' | 'execute' | 'external' | 'destructive'

export type ToolSpaceSchemaPolicy = 'full' | 'preview' | 'hidden' | 'none'

export interface ToolSpaceReason {
  layer: string
  code: string
  message: string
  details?: Record<string, unknown>
}

export interface ToolSpacePage {
  id: string
  kind: ToolSpacePageKind
  name: string
  categoryId: ToolCategoryId
  summary: string
  suitable: string[]
  forbidden: string[]
  aliases: string[]
  searchHints: string[]
  permissions: string[]
  risk: ToolSpacePageRisk
  availability: ToolDiscoveryAvailability
  toolOsState: ToolOsState
  schemaState: ToolDiscoverySchemaState
  schemaPolicy: ToolSpaceSchemaPolicy
  nextAction: ToolDiscoveryNextAction
  resident: boolean
  access: ToolAccessDecision
  reasons: ToolSpaceReason[]
  description?: string
  /** companion skill id：这张页的深度用法住在哪个技能里（`tooling:map` 卡片透出）。 */
  usageSkillId?: string
}

export interface ToolSpaceResolverCodingSession {
  hasToolCategoryAccess(categoryId: ToolCategoryId): boolean
  isToolCategoryAllowed?: (categoryId: ToolCategoryId) => boolean
  getEnabledPromptFeatures(): ChatPromptFeatureId[]
  /** 会话声明/切换后的当前能力作用域。 */
  getActiveCapabilityScope?: () => CapabilityScopeId
}

export interface ToolSpaceResolverContext {
  capabilityPorts?: AgentRuntimeCapabilityPorts
  role?: { id?: AgentRoleId }
  codingSession: ToolSpaceResolverCodingSession
  requiresToolCategoryApproval?: (categoryId: ToolCategoryId) => boolean
  requestToolCategoryAccess?: unknown
  getCurrentVisibleToolNames(): string[]
  listCapabilityPages?: () => ToolCapabilityPage[]
  listTools?: (scope?: ToolAvailabilityScope) => ToolDescriptor[]
  listToolCategories(scope?: ToolAvailabilityScope): ToolCategoryOverview[]
}

export interface PluginEntry {
  id: ChatPromptFeatureId
  label: string
  description: string
  toolCategoryIds: readonly ToolCategoryId[]
  enabled: boolean
}

/**
 * 紧接失败之后的那一次决策要看清被复用的原参数：历史视图会省略大段正文，模型只能先召回才能判断该改
 * 范围还是改正文。只还原最近一次决策里、确证未写入且可复用的修改调用；越过下一次决策边界后恢复省略形态，
 * 持久历史不变。原参数取自执行器保存的 attempt 记录，读取失败时保持原样。
 */
export interface RestoredReusableInputs {
  messages: ModelMessage[]
  /** 本次还原了完整参数的调用；编译期结构清洗据此不再压缩它们。 */
  restoredToolCallIds: ReadonlySet<string>
}

export interface ToolModelInputRequirements {
  requiredModelInputModalities?: readonly AgentModelInputModality[]
}

export interface ToolModelInputContext {
  getSupportedModelInputModalities?: () => readonly AgentModelInputModality[]
}
