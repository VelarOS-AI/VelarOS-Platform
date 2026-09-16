import { isArray, isEmpty, isNonBlankString, isNull, isNumber, isPlainObject, isString } from '@velaros-ai/core'

import type { AgentPlan, AgentPlanStep, AgentPlanStepStatus } from '../../types/product-session.js'

export function createSteps(values: readonly string[]): AgentPlanStep[] {
  return values.map((text, index) => ({ id: `step-${index + 1}`, text, status: 'pending' }))
}

export function normalizeSteps(values: readonly string[]): string[] {
  const steps = values.map((value) => requireText(value, 'Plan step'))
  if (isEmpty(steps) || steps.length > 24) throw new Error('A plan requires 1 to 24 steps.')
  return steps.map((step) => step.slice(0, 1_000))
}

export function freezePlan(plan: AgentPlan): AgentPlan {
  return Object.freeze({
    ...plan,
    steps: Object.freeze(plan.steps.map((step) => Object.freeze({ ...step }))),
  })
}

export function isPlan(value: unknown): value is AgentPlan {
  return isRecord(value)
    && isString(value.id)
    && isString(value.sessionId)
    && isString(value.objective)
    && isArray(value.steps)
    && value.steps.every(isPlanStep)
    && value.status === 'draft'
    && (isNull(value.reviewFeedback) || isString(value.reviewFeedback))
    && isNumber(value.createdAt)
    && isNumber(value.updatedAt)
}

export function isPlanDraft(value: Record<string, unknown>): value is Record<string, unknown> & {
  objective: string
  steps: AgentPlanStep[]
} {
  return isString(value.objective)
    && isArray(value.steps)
    && value.steps.every(isPlanStep)
}

export function isPlanStep(value: unknown): value is AgentPlanStep {
  return isRecord(value)
    && isString(value.id)
    && isString(value.text)
    && isPlanStepStatus(value.status)
}

export function isPlanStepUpdate(value: Record<string, unknown>): value is Record<string, unknown> & {
  stepId: string
  status: AgentPlanStepStatus
} {
  return isString(value.stepId) && isPlanStepStatus(value.status)
}

export function isPlanStepStatus(value: unknown): value is AgentPlanStepStatus {
  return value === 'pending' || value === 'in_progress' || value === 'complete' || value === 'skipped'
}

export function requireText(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} cannot be empty.`)
  return normalized
}

export function stringValue(value: unknown): Nullable<string> {
  return isNonBlankString(value) ? value.trim() : null
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value)
}
