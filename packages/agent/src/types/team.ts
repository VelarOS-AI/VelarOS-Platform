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
