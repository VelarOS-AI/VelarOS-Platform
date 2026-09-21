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

export type ToolApprovalRiskLevel = 'low' | 'high'

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

export type UserActionCardTone = 'info' | 'warning' | 'success' | 'danger'

export type UserActionCardIcon = string

export type UserActionCardAction =
  | UserActionCardEnablePromptFeaturesAction
  | UserActionCardAcknowledgeAction
  | UserActionCardRejectAction
  | UserActionCardSubmitInputAction
  | UserActionCardSubmitFormAction

export interface UserActionCardEnablePromptFeaturesAction {
  kind: 'enable_prompt_features'
  label: string
  completedLabel?: string
  icon?: UserActionCardActionIcon
  promptFeatures: string[]
  completedDescription?: string
  disableAfterClick?: boolean
}

export type UserActionCardActionIcon = string

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

export interface UserActionCardTextInput {
  placeholder?: string
  required?: boolean
  maxLength?: number
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

export type UserActionFormFieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'select'
  | 'radio'
  | 'checkbox'
  | 'checkboxes'

export interface UserActionFormOption {
  value: string
  label: string
  description?: string
  /** 模型推荐项：渲染时显示"推荐"标记，帮用户在拿不准时有个默认倾向。 */
  recommended?: boolean
}

export type UserActionFormValue = string | number | boolean | string[]

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

// ── 审批与有界读 ─────────────────────────────────────────────────

/** 一次必须由用户亲自裁决的审批请求可以填的东西：手动确认与是否记住风险分类两格由构造器补。 */
export type ManualApprovalOptions = Omit<
  ToolConfirmationDecisionOptions,
  'requireManualApproval' | 'rememberRiskScope'
>
