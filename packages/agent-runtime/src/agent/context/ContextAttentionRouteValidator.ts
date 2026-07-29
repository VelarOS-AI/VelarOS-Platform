import { isEmpty } from '@velaros-ai/core'

import type { ContextAttentionDecision } from './ContextAttentionPolicyEngine'

export type ContextAttentionRouteViolationSeverity = 'fatal' | 'warning'

export interface ContextAttentionRouteViolation {
  severity: ContextAttentionRouteViolationSeverity
  code:
    | 'hard-retained-demoted'
    | 'failure-evidence-demoted'
    | 'stateful-tool-result-demoted'
    | 'current-task-dropped'
    | 'explicit-mention-dropped'
    | 'unrecoverable-handle'
    | 'router-exception'
  blockId: string
  message: string
}

export interface ContextAttentionRouteValidation {
  passed: boolean
  checked: string[]
  violations: ContextAttentionRouteViolation[]
  fatalViolations: ContextAttentionRouteViolation[]
  warningViolations: ContextAttentionRouteViolation[]
  fallbackRequired: boolean
  fallbackApplied: boolean
}

export interface ContextAttentionRouteValidatorInput {
  decisions: readonly ContextAttentionDecision[]
}

function isInlineResidentAction(decision: ContextAttentionDecision): boolean {
  return decision.action === 'inline' || decision.action === 'retain'
}

function validateDecision(decision: ContextAttentionDecision): ContextAttentionRouteViolation[] {
  const violations: ContextAttentionRouteViolation[] = []

  if (decision.hardRetained && decision.ledgerAction !== 'inline') {
    violations.push({
      severity: 'fatal',
      code: 'hard-retained-demoted',
      blockId: decision.blockId,
      message: `context attention route attempted to demote hard-retained block ${decision.blockId}`,
    })
  }

  if (decision.features.toolFailureReason && !isInlineResidentAction(decision)) {
    violations.push({
      severity: 'fatal',
      code: 'failure-evidence-demoted',
      blockId: decision.blockId,
      message: `context attention route attempted to demote failure evidence ${decision.blockId}`,
    })
  }

  if (decision.features.statefulToolResult && !isInlineResidentAction(decision)) {
    violations.push({
      severity: 'fatal',
      code: 'stateful-tool-result-demoted',
      blockId: decision.blockId,
      message: `context attention route attempted to demote stateful tool result ${decision.blockId}`,
    })
  }

  if (decision.features.currentTaskEvidence && decision.action === 'drop') {
    violations.push({
      severity: 'fatal',
      code: 'current-task-dropped',
      blockId: decision.blockId,
      message: `context attention route attempted to drop current task evidence ${decision.blockId}`,
    })
  }

  if (decision.features.explicitlyMentioned && decision.action === 'drop') {
    violations.push({
      severity: 'fatal',
      code: 'explicit-mention-dropped',
      blockId: decision.blockId,
      message: `context attention route attempted to drop explicitly mentioned context ${decision.blockId}`,
    })
  }

  if (decision.action === 'handle' && !decision.features.recoverable) {
    violations.push({
      severity: 'fatal',
      code: 'unrecoverable-handle',
      blockId: decision.blockId,
      message: `context attention route produced unrecoverable handle for ${decision.blockId}`,
    })
  }

  return violations
}

export class ContextAttentionRouteValidator {
  public validate(input: ContextAttentionRouteValidatorInput): ContextAttentionRouteValidation {
    const violations = input.decisions.flatMap(validateDecision)
    const fatalViolations = violations.filter((violation) => violation.severity === 'fatal')
    const warningViolations = violations.filter((violation) => violation.severity === 'warning')

    return {
      passed: isEmpty(fatalViolations),
      checked: [
        'hard-retained-inline',
        'failure-evidence-inline',
        'stateful-tool-result-inline',
        'current-task-not-dropped',
        'explicit-mention-not-dropped',
        'handles-recoverable',
      ],
      violations,
      fatalViolations,
      warningViolations,
      fallbackRequired: !isEmpty(fatalViolations),
      fallbackApplied: false,
    }
  }
}
