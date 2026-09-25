/** @AgentView 对方可选的一个答案：id 在同一问题里唯一，label 是给对方看的一句话，recommended 标出建议项（最多一个）。 */
export interface InteractionOption {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly recommended?: boolean
}

/**
 * @AgentView 表单里要对方填的一项：kind 为 text、number、boolean 或 choice。
 * choice 要给 options（2 到 8 个），multiple 允许多选；required 表示必填。
 */
export interface InteractionField {
  readonly id: string
  readonly label: string
  readonly kind: 'text' | 'number' | 'boolean' | 'choice'
  readonly options?: readonly InteractionOption[]
  readonly multiple?: boolean
  readonly required?: boolean
  readonly placeholder?: string
}

/**
 * @AgentView 要对方回答的话：message 1 到 8000 个字符，写清楚要补什么、为什么需要。
 * 只有几个可能的答案时给 options（2 到 8 个），对方点选；multiple 允许多选，allowText 允许在选项之外自己写。
 * 要对方一次填好几项时给 fields（1 到 8 项）。options 与 fields 不同时给。
 */
export interface InteractionRequest {
  readonly message: string
  readonly options?: readonly InteractionOption[]
  readonly multiple?: boolean
  readonly allowText?: boolean
  readonly fields?: readonly InteractionField[]
}

/** @AgentView 表单里一项的值：text 是文字，number 是数，boolean 是真假，choice 是选项 id（多选时是 id 列表）。 */
export type InteractionFieldValue = string | number | boolean | readonly string[]

/**
 * @AgentView ask 的回答：自由作答在 text；点选的选项 id 在 choices；表单按字段 id 在 values。
 * 对方不回答、跳过这个问题时 declined 为 true，reason 是对方给的理由。
 */
export interface InteractionAnswer {
  readonly text?: string
  readonly choices?: readonly string[]
  readonly values?: Readonly<Record<string, InteractionFieldValue>>
  readonly declined?: boolean
  readonly reason?: string
}

/** @AgentView 要对方确认的话：message 1 到 8000 个字符，说清楚要同意什么、会产生什么效果。 */
export interface ConfirmationRequest {
  readonly message: string
}

/** @AgentView confirm 的回答：approved 表示对方同意；不同意时 reason 是对方给的理由。 */
export interface ConfirmationAnswer {
  readonly approved: boolean
  readonly reason?: string
}

/** @AgentView 说明缺少的能力：message 1 到 8000 个字符；detail 放任意 JSON 补充，比如为什么需要、要哪个模块。 */
export interface CapabilityRequest {
  readonly message: string
  readonly detail?: unknown
}
