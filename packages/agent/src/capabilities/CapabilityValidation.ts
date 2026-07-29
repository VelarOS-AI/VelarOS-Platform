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
