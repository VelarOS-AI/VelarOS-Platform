import type { ChatPromptFeatureId } from './agent'
import type { RunProfileId } from './runProfile'

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

export type ToolCapabilityEffectKind = string
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
  /** 内置工具默认走 ToolMetadataCatalog；provider 可用此字段覆盖或补充暴露策略。 */
  exposure?: ToolExposurePolicy
  /** 输出必须保持内联、禁止 page-out 成 payload 引用（发现/索引类工具，如 tool_map）。 */
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

export interface UserActionCardBlock {
  type: 'user-action-card'
  card: UserActionCard
}
