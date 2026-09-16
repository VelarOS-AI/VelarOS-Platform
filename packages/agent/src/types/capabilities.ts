import type { CapabilityContextCollector, CapabilityIntentClassifier, CapabilityPromptContributor, CapabilityScopePolicy,CapabilityValidationInterpreter, ToolAllocationMetadata, ToolResultMiddleware, ToolValidationHintProvider } from '../contract/requires.js'

import type { AgentEvent, CapabilityScopeId,StreamToolResultEffects, ToolCategoryDefinition, ToolCategoryId, ToolResultModelContentPart } from './agent.js'

export type CapabilityValidationStatus =
  | 'aborted'
  | 'failed'
  | 'passed'
  | 'timed-out'
  | 'unknown'

export type CapabilityValidationGoal = 'quick' | 'standard' | 'thorough'

export interface CapabilityValidationSummary {
  kind: string
  status: CapabilityValidationStatus
  issues: string[]
}

export interface CapabilityCommandResult {
  command: string
  verification: CapabilityValidationSummary
}

export interface CapabilityValidationSuggestion {
  command: string
  label?: string
  priority: number
}

export interface CapabilityValidationRunResult {
  steps: Array<{
    suggestion: CapabilityValidationSuggestion
    result: CapabilityCommandResult
  }>
  overallStatus: CapabilityValidationStatus
  stoppedEarly: boolean
}

/**
 * Host-neutral description of a capability that can be composed into Agent Runtime.
 *
 * The descriptor intentionally contains no product vocabulary or executable policy.
 * Capability packages own their tool names, operation aliases, validation guidance,
 * result middleware, and allocation prerequisites and inject them at composition time.
 */
export interface AgentRuntimeCapabilityDescriptor {
  id: string
  version?: string
  toolNames?: readonly string[]
  categories?: readonly ToolCategoryDefinition[]
  categoryIds?: readonly ToolCategoryId[]
  operationIds?: readonly string[]
  metadata?: Readonly<Record<string, unknown>>
}

export interface ToolResultMiddlewareContext<TExecutionContext = unknown> {
  toolCallId: string
  toolName: string
  args: Readonly<Record<string, unknown>>
  result: unknown
  executionContext: TExecutionContext
}

export interface ToolResultModelImage {
  data: string
  mediaType: 'image/png' | 'image/jpeg'
  /** Capability-owned display metadata. Agent Runtime treats this as opaque data. */
  artifact?: unknown
}

export interface ToolResultMiddlewareResult {
  result: unknown
  /** Ordered provider-visible blocks appended by this middleware. */
  modelContent?: readonly ToolResultModelContentPart[]
  modelImage?: ToolResultModelImage
  effects?: StreamToolResultEffects
  notices?: Array<Extract<AgentEvent, { type: 'notice' }>>
}

export interface ToolValidationIssueDetail {
  path: string
  message: string
}

export interface ToolValidationHintContext {
  toolName: string
  pageId: string
  issues: string
  issueDetails: readonly ToolValidationIssueDetail[]
}

export interface ToolValidationRecovery {
  hint?: string
  nextActions?: readonly string[]
}

export interface CapabilityValidationInterpretation {
  status: 'passed' | 'failed' | 'timed-out' | 'unknown'
  failure?: {
    operation: string
    status: 'failed' | 'timed-out'
    issues: readonly string[]
  }
  notes?: readonly string[]
}

export interface CapabilityIntentSignal {
  domainId: string
  categoryIds?: readonly ToolCategoryId[]
  requiresDiscovery?: boolean
  requiresEvidence?: boolean
  requiresMutation?: boolean
  requiresValidation?: boolean
}

export interface CapabilityIntentClassifierContext {
  scopeId?: CapabilityScopeId
}

export interface ToolAllocationDelegation {
  code?: string
  message: string
}

export interface ToolAllocationPrerequisite {
  id: string
  categoryIds: readonly ToolCategoryId[]
  denialCode?: string
  message: string
}

export interface CapabilityScopeRuntimeFacts {
  scopeId?: CapabilityScopeId
  satisfiedFactIds?: readonly string[]
}

export interface CapabilityScopeCategoryDecision {
  allowed: boolean
  reasonCode?: string
  message?: string
}

export interface CapabilityScopeResidency {
  residentToolNames?: readonly string[]
  excludedToolNames?: readonly string[]
  protectedToolNames?: readonly string[]
}

export interface AgentRuntimeCapabilityExtension {
  descriptor: AgentRuntimeCapabilityDescriptor
  toolAliases?: Readonly<Record<string, string>>
  resultMiddlewares?: ReadonlyArray<ToolResultMiddleware<any>>
  validationHintProviders?: readonly ToolValidationHintProvider[]
  validationInterpreters?: readonly CapabilityValidationInterpreter[]
  promptContributors?: readonly CapabilityPromptContributor[]
  contextCollectors?: readonly CapabilityContextCollector[]
  intentClassifiers?: readonly CapabilityIntentClassifier[]
  allocation?: ToolAllocationMetadata
  scopePolicy?: CapabilityScopePolicy
  /** 本扩展提供的「请求用户动作」角色工具名；语义与 `AgentRuntimeCapabilityPorts.userActionRequestToolName` 完全一致。 */
  userActionRequestToolName?: string
}
