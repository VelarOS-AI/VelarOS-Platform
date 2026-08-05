import type { ToolCategoryId } from './tool'

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
