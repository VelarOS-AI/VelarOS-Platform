import type { ModelMessage } from 'ai'

import type { ProviderRequestPressureKind } from '../impl/context/ProviderRequestCompiler'
import type { ContextWorkingSetBudgetAllocation } from '../utils/context/context-working-set-budget-governor'
import type { ContextDegradeAction } from '../utils/loop/context-degrade-ladder'
import type { ToolSpaceBootstrapState } from '../utils/loop/tool-space-bootstrap-planner'

import type { ControlPlaneLedgerEntry, ControlPlaneLedgerSource } from './agent'
import type { AgentModelRequestOptions } from './model-contracts'
import type { RunProfileId, RunProfileSelectionId } from './run-profile'
import type { ToolCategoryId, ToolDescriptor } from './tool'

export type AgentIntentDomain = string

export interface AgentIntentPlan {
  latestUserText: string
  domains: AgentIntentDomain[]
  complexity: 'low' | 'single-domain' | 'multi-domain'
  confidence: 'low' | 'medium' | 'high'
  requiresCapabilityEvidence: boolean
  requiresToolDiscovery: boolean
}

export interface AgentRuntimePlan {
  providerId: string
  model: string
  contextWindow?: number
  runProfile: RunProfileId
  runProfileReason: string
  modelRequestOptions?: AgentModelRequestOptions
}

export interface ToolPageFault {
  toolName: string
  categoryId?: ToolCategoryId
  reason: 'schema-budget' | 'role-boundary' | 'permission' | 'runtime-unavailable'
  recoveryHint: 'page-out-other-tools' | 'request-approval' | 'request-user-action' | 'stop'
}

export interface CapabilityRunPlan {
  requestedCategories: ToolCategoryId[]
  enabledCategories: ToolCategoryId[]
  protectedToolNames: string[]
  baseAllowedToolNames: string[]
  residentToolNames: string[]
  droppedToolNames: string[]
  forcedToolChoice?: { type: 'tool'; toolName: string }
  pageFaults: ToolPageFault[]
  bootstrapState: ToolSpaceBootstrapState
  bootstrapReminder?: string
}

export interface ContextRunPlan {
  contextWindow: number
  usableContextWindow: number
  zoneAllocation: ContextWorkingSetBudgetAllocation
  toolSchemaCharBudget: number
  toolSchemaBudgetScale: number
  expectedInputTokens?: number
  payloadPolicy: 'inline' | 'reference-large' | 'dedupe-and-reference'
  pressure: ProviderRequestPressureKind
}

export interface PromptRunPlan {
  runProfile: RunProfileId
  promptBudget?: { profile: RunProfileId; maxChars: number }
  internalReminders: Array<{
    id: string
    phase: 'before-model' | 'after-tool' | 'finishing'
    reason: string
    text: string
    dedupeKey?: string
  }>
}

export interface RecoveryRunPlan {
  ignoredToolChoice: {
    enabled: boolean
    maxRetries: number
    fallbackReminderId?: string
  }
  contextOverflow: {
    ladder: ContextDegradeAction[]
  }
  missingCapability: {
    action: 'discover' | 'read-page' | 'request-user-action' | 'stop'
  }
  staleEvidence: {
    action: 'refresh-capability-context' | 'none'
  }
}

export type AgentRunPlanLedgerSource = ControlPlaneLedgerSource

export type AgentRunPlanLedgerEntry = ControlPlaneLedgerEntry

export interface AgentRunPlan {
  id: string
  turn: number
  intent: AgentIntentPlan
  runtime: AgentRuntimePlan
  capabilities: CapabilityRunPlan
  context: ContextRunPlan
  prompt: PromptRunPlan
  recovery: RecoveryRunPlan
  ledger: AgentRunPlanLedgerEntry[]
}

export interface AgentRunPlannerInput<TToolContext = unknown> {
  turn: number
  history: ModelMessage[]
  roleRuntime: AgentRuntimePlan
  requestedRunProfile: RunProfileSelectionId
  toolContext: TToolContext
  roleAllowedTools: string[]
  configuredTools?: string[]
  toolDescriptors?: ToolDescriptor[]
}
