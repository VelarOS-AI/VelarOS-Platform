import type { ApprovalPort } from '../contract/requires.js'

import type { ActiveContextArchiveFilter, ActiveContextArtifact, ActiveContextListOptions, ActiveContextUpsertInput, ActiveDirectiveType, AgentModManifest, AgentSkillDescriptor, AgentWorkflowDefinition,ToolCategoryDomainId, ToolCategoryId, ToolExecutionPlanItemStatus, ToolOsState, ToolPermission } from './agent.js'
import type { BuiltInPromptOptions } from './guidance.js'
import type { AgentModBindings,AgentModPackage } from './mods.js'
import type { KernelToolContext } from './tool-context.js'
import type { DefineToolRuntimeSpecInput,ToolContractRuntimeSpec, ToolContractSurface } from './toolkit.js'
import type { ToolDiscoveryAvailability, ToolDiscoveryNextAction, ToolDiscoverySchemaState, ToolSpacePage,ToolSpacePageKind, ToolSpacePageRisk, ToolSpaceReason, ToolSpaceSchemaPolicy } from './tools.js'

export interface BuiltinAgentModOptions {
  /** 透传给内置提示词段构造（宿主身份说明）。 */
  promptOptions?: BuiltInPromptOptions
  /** 随主包版本流转；缺省与 manifest schema 同档的保守值。 */
  version?: string
}

export interface BuiltinAgentModPackage extends AgentModPackage {
  readonly manifest: AgentModManifest
  readonly bindings: AgentModBindings
}

export interface DistillContextInput extends Record<string, unknown> {
  facts: string[]
  note?: string
}

/** 一次 filter 应用的结果：输出本身 + 让模型能自己判断「是没输出还是没命中」的账。 */
export interface BackgroundJobOutputFilterResult {
  /** 呈现给模型的输出正文（filter 未生效时 = 原始输出）。 */
  output: string
  /** filter 是否真的施加了。给了非法正则时为 false（fail-open）。 */
  applied: boolean
  /** 过滤前的行数。 */
  totalLines: number
  /** filter 命中的行数；`applied` 为 false 时等于 totalLines。 */
  matchedLines: number
  /** filter 被忽略的原因（非法正则）。 */
  ignoredReason: Nullable<string>
}

export interface ActiveDirectiveContext {
  listActiveContextArtifacts(options?: ActiveContextListOptions): Promise<ActiveContextArtifact[]>
  upsertActiveContextArtifact(input: ActiveContextUpsertInput): Promise<ActiveContextArtifact>
  archiveActiveContextArtifacts(
    filter: ActiveContextArchiveFilter
  ): Promise<ActiveContextArtifact[]>
}

export interface ActiveDirectiveMetadata {
  directive?: unknown
  directiveType?: unknown
}

export interface GoalConstraintReference {
  goalId: string
  constraintId: string
  title: Nullable<string>
}

/**
 * interaction:confirm 的最小执行上下文：只需审批通道与取消信号。
 *
 * 声明成 host ToolContext 的**超集**（字段更少），故本工具可赋给宿主更宽的 VelaTool 契约
 * （TContext 逆变），无需把宿主 ToolContext 拖进内核。
 */
export interface RequestConfirmationToolContext {
  approval: ApprovalPort
  abortSignal: AbortSignal
}

export interface HandoffContextInput extends Record<string, unknown> {
  reason: string
}

export interface AgentWorkflowToolCollection {
  readonly 'agent:run_workflow': VelaTool<RunAgentWorkflowInput>
}

export type ToolSpaceReplacePageDetail = Pick<
  ToolDiscoveryCard,
  | 'id'
  | 'kind'
  | 'name'
  | 'categoryId'
  | 'summary'
  | 'availability'
  | 'toolOsState'
  | 'schemaState'
  | 'schemaPolicy'
  | 'nextAction'
  | 'resident'
> & {
  reasons: ToolReasonRef[]
  activation: ToolActivationRef
}

export interface ResolvedToolInputSchema {
  profileId: string
  description: string
  schema: unknown
}

export type VelaToolSurface<
  TSurfaceInput extends Record<string, any> = Record<string, any>,
  TBaseInput extends Record<string, any> = Record<string, any>,
  TCtx extends KernelToolContext = KernelToolContext,
> = ToolContractSurface<TSurfaceInput, TBaseInput, TCtx>

/** generic 工具的统一形状；TCtx 默认核心面 KernelToolContext。 */
export type VelaTool<
  TInput extends Record<string, any> = Record<string, any>,
  TCtx extends KernelToolContext = KernelToolContext,
> = ToolContractRuntimeSpec<TInput, TCtx, any, ToolPermission>

export type DefineVelaToolInput<
  TInput extends Record<string, any> = Record<string, any>,
  TCtx extends KernelToolContext = KernelToolContext,
> = DefineToolRuntimeSpecInput<TInput, TCtx, any, ToolPermission>

export type ToolMapCategoryKind = 'bundle' | 'leaf'

export interface ToolCategoryFilterResolution {
  expandedCategoryIds: ToolCategoryId[]
  validDomainIds: ToolCategoryDomainId[]
  unknownDomainIds: ToolCategoryDomainId[]
  categoryFilter: Nullable<Set<ToolCategoryId>>
}

export type UserPlanStatus = Extract<
  ToolExecutionPlanItemStatus,
  'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped'
>

export interface UserPlanStep {
  /** 稳定步骤 id；已有步骤可复用。 */
  id?: string
  /** 步骤标题。 */
  step: string
  /** 可选步骤目标。 */
  objective?: string
  /** 当前步骤状态。 */
  status: UserPlanStatus
}

export type PlanStepRef = string | number

export type PlanLifecycle = 'active' | 'paused' | 'completed' | 'archived'

/** plan:update 工具入参。 */
export type UpdatePlanInput = {
  /** 本次计划变更的简短说明。 */
  explanation?: LooseOptional<string>
  /** 计划生命周期；可暂停/恢复，完成或用户改变目标时应显式收尾。 */
  lifecycle?: PlanLifecycle
  /** 当前完整计划列表，而不是增量 patch。 */
  plan?: UserPlanStep[]
  /** 标记当前计划中的一个或多个步骤已完成；传步骤 id、标题或 1-based 序号。 */
  complete_step?: PlanStepRef | PlanStepRef[]
}

export interface PlanStepCompletionResult {
  plan: UserPlanStep[]
  completedStep: UserPlanStep
  completedSteps: UserPlanStep[]
  promotedStep: Nullable<UserPlanStep>
  allStepsResolved: boolean
}

export type ToolAvailability = ToolDiscoveryAvailability

export type ToolDiscoveryKind = ToolSpacePageKind

export type ToolDiscoveryRisk = ToolSpacePageRisk

export type ToolSchemaState = ToolDiscoverySchemaState

export type ToolNextAction = ToolDiscoveryNextAction

export type ToolSchemaPolicy = ToolSpaceSchemaPolicy

export type ToolDiscoveryReason = ToolSpaceReason

export type ToolDiscoveryCard = ToolSpacePage

export type ToolActivationMethod =
  | 'direct_call'
  | 'page_in_only'
  | 'request_approval'
  | 'request_user_action'
  | 'inspect_reasons'

export type ToolDependencyKind =
  | 'capability'
  | 'plugin'
  | 'runtime'
  | 'residency'

export type ToolDependencyState =
  | 'satisfied'
  | 'loadable'
  | 'requires_approval'
  | 'requires_user_action'
  | 'blocked'

export interface ToolDependencyGuide {
  id: string
  kind: ToolDependencyKind
  state: ToolDependencyState
  required: boolean
  summary: string
  pageId: Nullable<string>
  pageIn: string[]
  nextTool: Nullable<string>
  reasonKeys: string[]
  activationHint: string
}

export interface ToolActivationGuide {
  method: ToolActivationMethod
  summary: string
  pageIn: string[]
  capabilityId: Nullable<string>
  nextTool: Nullable<string>
  notes: string[]
  dependencies: ToolDependencyGuide[]
  activationFlow: string[]
}

export type ToolReasonRef = Pick<ToolDiscoveryReason, 'layer' | 'code' | 'message'>

export type ToolDependencyRef = Pick<
  ToolDependencyGuide,
  'id' | 'kind' | 'state' | 'required' | 'pageId' | 'pageIn' | 'nextTool' | 'reasonKeys'
>

export interface ToolActivationRef {
  method: ToolActivationMethod
  pageIn: string[]
  capabilityId: Nullable<string>
  nextTool: Nullable<string>
  dependencies: ToolDependencyRef[]
}

export interface ToolSearchResultEntry {
  id: string
  kind: ToolDiscoveryKind
  name: string
  categoryId: ToolCategoryId
  summary: string
  usageSkillId: Nullable<string>
  score: number
  availability: ToolAvailability
  toolOsState: ToolOsState
  risk: ToolDiscoveryRisk
  schemaState: ToolSchemaState
  schemaPolicy: ToolSchemaPolicy
  nextAction: ToolNextAction
  resident: boolean
  activation: Pick<ToolActivationRef, 'method' | 'pageIn' | 'capabilityId' | 'nextTool'>
  matchedFields: Array<ToolMatchSignal['field']>
}

export interface ToolMatchSignal {
  field:
    | 'id'
    | 'name'
    | 'category'
    | 'aliases'
    | 'search_hints'
    | 'summary'
    | 'description'
    | 'suitable'
    | 'forbidden'
    | 'schema'
    | 'activation'
    | 'reverse_activation'
  terms: string[]
}

export interface ToolSearchScoreContext {
  schemaTextById: ReadonlyMap<string, string>
  activationTextById: ReadonlyMap<string, string>
  reverseActivationTextByName: ReadonlyMap<string, string>
}

export type ToolSpaceInput = {
  op: 'find'
  query: string
  kind?: 'capability' | 'tool' | 'plugin' | 'all'
  categoryIds?: string[]
  domainIds?: string[]
  toolOsStates?: Array<'resident' | 'loadable' | 'needs_setup' | 'unavailable'>
  limit?: number
  cursor?: LooseOptional<string>
} 
  | {
  op: 'page'
  kind?: 'capability' | 'tool' | 'plugin' | 'all'
  categoryIds?: string[]
  domainIds?: string[]
  toolOsStates?: Array<'resident' | 'loadable' | 'needs_setup' | 'unavailable'>
  limit?: number
  cursor?: LooseOptional<string>
} 
  | {
  op: 'map'
  kind?: 'capability' | 'tool' | 'plugin' | 'all'
  categoryIds?: string[]
  domainIds?: string[]
  toolOsStates?: Array<'resident' | 'loadable' | 'needs_setup' | 'unavailable'>
  categoryLimit?: number
  cursor?: LooseOptional<string>
  maxToolsPerCategory?: number
} 
  | {
  op: 'read'
  ids: string[]
  detail?: 'brief' | 'full'
} 
  | {
  op: 'replace'
  reason: string
  pageIn?: string[]
  pageOut?: string[]
}

export type ToolSpaceFindInput = {
  op: 'find'
  query: string
  kind: 'capability' | 'tool' | 'plugin' | 'all'
  categoryIds: string[]
  domainIds: string[]
  toolOsStates: Array<'resident' | 'loadable' | 'needs_setup' | 'unavailable'>
  limit: number
  cursor?: LooseOptional<string>
}

export type ToolSpacePageInput = {
  op: 'page'
  kind: 'capability' | 'tool' | 'plugin' | 'all'
  categoryIds: string[]
  domainIds: string[]
  toolOsStates: Array<'resident' | 'loadable' | 'needs_setup' | 'unavailable'>
  limit: number
  cursor?: LooseOptional<string>
}

export type ToolSpaceMapInput = {
  op: 'map'
  kind: 'capability' | 'tool' | 'plugin' | 'all'
  categoryIds: string[]
  domainIds: string[]
  toolOsStates: Array<'resident' | 'loadable' | 'needs_setup' | 'unavailable'>
  categoryLimit: number
  maxToolsPerCategory: number
  cursor?: LooseOptional<string>
}

export type ToolSpaceReadInput = {
  op: 'read'
  ids: string[]
  detail: 'brief' | 'full'
}

export type ToolSpaceReplaceInput = {
  op: 'replace'
  pageIn: string[]
  pageOut: string[]
  reason: string
}

export type ToolSpaceOperationInput = ToolSpaceFindInput | ToolSpacePageInput | ToolSpaceMapInput | ToolSpaceReadInput | ToolSpaceReplaceInput

/**
 * 计划/目标共享的步骤引擎。
 *
 * Plans 与 Goals 的步骤形状完全同构(`{id?, step, objective?, status}`),此前
 * 匹配/完成/晋升/引用清单四套逻辑是两份近拷贝(修 scaffold-clobber 时逐行比对过)。
 * 本模块收敛为单一实现;两侧语义差异(已解决状态集/晋升回退策略)显式参数化,
 * 不做静默行为漂移。匹配器统一采用更宽容的版本(NFKC/全角冒号归一/唯一子串命中)。
 */
export interface UserStep {
  /** 稳定步骤 id;通常没有(创建时未指定),引用优先用序号。 */
  id?: string
  /** 步骤标题。 */
  step: string
  /** 可选步骤目标。 */
  objective?: string
  /** 当前状态。 */
  status: UserPlanStatus
}

export interface StepEngineOptions {
  /** 错误文案里的种类名(plan/goal),保持与历史报错逐字一致。 */
  kindLabel: 'plan' | 'goal'
  /** 匹配失败时清单前缀,如「当前计划步骤」/「当前目标步骤」。 */
  listLabel: string
  /** 空列表报错文案。 */
  emptyMessage: string
  /** 计入 allStepsResolved 的终态集合。 */
  resolvedStatuses: readonly UserPlanStatus[]
  /**
   * 晋升回退策略:完成一步后若无 in_progress,优先晋升「完成位之后的第一个 pending」;
   * true 时找不到则回退「任意位置的第一个 pending」(goal 语义),false 则不晋升(plan 语义)。
   */
  promoteFallbackAnywhere: boolean
}

export interface StepCompletionResult<T extends UserStep> {
  steps: T[]
  completedStep: T
  completedSteps: T[]
  promotedStep: Nullable<T>
  allStepsResolved: boolean
}

export type StepRef = string | number

export interface SkillReadPage {
  id: string
  kind: 'skill'
  name: string
  label: string
  description: string
  sourceKind: AgentSkillDescriptor['sourceKind']
  sourceId: string
  roleIds: AgentSkillDescriptor['roleIds']
  priority: number
  markdown: string
  fullDetails?: {
    readGuidance: string[]
  }
}

export type GoalStatus = 'active' | 'paused' | 'complete' | 'blocked' | 'cancelled' | 'removed'

export interface GoalStep {
  id?: string
  step: string
  objective?: string
  status: UserPlanStatus
}

export interface GoalConstraint {
  id?: string
  title: string
  content: string
  directiveType: ActiveDirectiveType
  sourceMessageId?: string
}

export interface GoalMetadata extends Record<string, unknown> {
  goal: true
  goalStatus: GoalStatus
  tokenBudget?: number
  blockedAuditTurns: number
  createdAt: number
  terminalAt?: number
  steps?: GoalStep[]
  constraints?: GoalConstraint[]
}

export interface GoalSnapshot {
  id: string
  objective: string
  status: GoalStatus
  steps: GoalStep[]
  constraints: GoalConstraint[]
  tokenBudget: Nullable<number>
  blockedAuditTurns: number
  createdAt: number
  updatedAt: number
  terminalAt: Nullable<number>
}

export interface GoalStepCompletionResult {
  steps: GoalStep[]
  completedStep: GoalStep
  promotedStep: Nullable<GoalStep>
  allStepsResolved: boolean
}

export type DispatchAgentInput = {
  mode: 'sync' | 'async'
  interrupt: boolean
  agent_name?: string
  subagent_type?: string
  tool_scope?: 'custom' | 'type_default' | 'inherit'
  tool_categories?: string[]
  prompt?: string
  description?: string
  thread_id?: string
  readonly?: boolean
  model?: string
  effort?: 'fast' | 'balanced' | 'deep'
  output_schema?: Record<string, unknown>
  route_category?: string
  attachments?: string[]
}

export type RecallContextInput = {
  path?: string
  revision?: string
  query?: string
  kind?: 'all' | 'conversation' | 'terminal'
  ref?: string
  refKind?: 'evidence' | 'tool-payload' | 'payload-ref' | 'context-handle' | 'file-snapshot'
  jsonPath?: string
  offset?: number
  reason?: string
  maxResults?: number
  maxChars?: number
}

export type RunAgentWorkflowInput = AgentWorkflowDefinition

export type ReadBackgroundJobOutputInput = {
  job_id: string
  mode?: 'incremental' | 'snapshot'
  filter?: string
}

export type WaitBackgroundJobsInput = {
  job_ids?: string[]
  timeout_ms?: number
  filter?: string
}

export type CancelBackgroundJobInput = {
  job_id: string
}
