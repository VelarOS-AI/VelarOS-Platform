import { randomUUID } from 'node:crypto'

import type { AgentSessionEventPort } from './event-port'

export type AgentPlanStatus = 'draft' | 'approved' | 'complete' | 'cancelled'
export type AgentPlanStepStatus = 'pending' | 'in_progress' | 'complete' | 'skipped'

export interface AgentPlanStep {
  readonly id: string
  readonly text: string
  readonly status: AgentPlanStepStatus
}

export interface AgentPlan {
  readonly id: string
  readonly sessionId: string
  readonly objective: string
  readonly steps: readonly AgentPlanStep[]
  readonly status: AgentPlanStatus
  readonly reviewFeedback: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

export class AgentPlanService {
  public constructor(private readonly sessions: AgentSessionEventPort) {}

  public get(sessionId: string): AgentPlan | null {
    let plan: AgentPlan | null = null
    for (const event of this.sessions.readEvents(sessionId)) {
      if (event.type === 'plan.created' && isPlan(event.payload)) {
        plan = { ...event.payload, sessionId }
        continue
      }
      if (!plan || !isRecord(event.payload) || event.payload.id !== plan.id) continue
      if (event.type === 'plan.drafted' && isPlanDraft(event.payload)) {
        plan = {
          ...plan,
          objective: event.payload.objective,
          steps: event.payload.steps,
          status: 'draft',
          reviewFeedback: null,
          updatedAt: event.createdAt,
        }
      } else if (event.type === 'plan.approved') {
        plan = { ...plan, status: 'approved', reviewFeedback: null, updatedAt: event.createdAt }
      } else if (event.type === 'plan.rejected') {
        plan = {
          ...plan,
          status: 'draft',
          reviewFeedback: stringValue(event.payload.feedback),
          updatedAt: event.createdAt,
        }
      } else if (event.type === 'plan.step.updated' && isPlanStepUpdate(event.payload)) {
        const update = event.payload
        plan = {
          ...plan,
          steps: plan.steps.map((step) => step.id === update.stepId
            ? { ...step, status: update.status }
            : step),
          updatedAt: event.createdAt,
        }
      } else if (event.type === 'plan.completed') {
        plan = {
          ...plan,
          status: 'complete',
          steps: plan.steps.map((step) => step.status === 'skipped'
            ? step
            : { ...step, status: 'complete' as const }),
          updatedAt: event.createdAt,
        }
      } else if (event.type === 'plan.cancelled') {
        plan = { ...plan, status: 'cancelled', updatedAt: event.createdAt }
      }
    }
    return plan ? freezePlan(plan) : null
  }

  public saveDraft(
    sessionId: string,
    input: { readonly objective: string; readonly steps: readonly string[] },
  ): AgentPlan {
    const objective = requireText(input.objective, 'Plan objective')
    const stepTexts = normalizeSteps(input.steps)
    const current = this.get(sessionId)
    if (current?.status === 'approved') {
      throw new Error('The approved plan is already executing. Complete or cancel it before replacing it.')
    }
    const now = Date.now()
    if (!current || current.status === 'complete' || current.status === 'cancelled') {
      const plan: AgentPlan = {
        id: randomUUID(),
        sessionId,
        objective,
        steps: createSteps(stepTexts),
        status: 'draft',
        reviewFeedback: null,
        createdAt: now,
        updatedAt: now,
      }
      this.sessions.appendEvent(sessionId, { type: 'plan.created', payload: plan, createdAt: now })
      return freezePlan(plan)
    }
    this.sessions.appendEvent(sessionId, {
      type: 'plan.drafted',
      payload: { id: current.id, objective, steps: createSteps(stepTexts) },
      createdAt: now,
    })
    return this.get(sessionId)!
  }

  public approve(sessionId: string): AgentPlan {
    const plan = this.requireDraft(sessionId)
    this.sessions.appendEvent(sessionId, { type: 'plan.approved', payload: { id: plan.id } })
    return this.get(sessionId)!
  }

  public reject(sessionId: string, feedback?: string): AgentPlan {
    const plan = this.requireDraft(sessionId)
    this.sessions.appendEvent(sessionId, {
      type: 'plan.rejected',
      payload: { id: plan.id, feedback: feedback?.trim() || null },
    })
    return this.get(sessionId)!
  }

  public updateStep(
    sessionId: string,
    stepId: string,
    status: AgentPlanStepStatus,
  ): AgentPlan {
    const plan = this.require(sessionId)
    if (plan.status !== 'approved') throw new Error('Approve the plan before recording execution progress.')
    const normalizedId = requireText(stepId, 'Plan step id')
    if (!plan.steps.some((step) => step.id === normalizedId)) throw new Error(`Plan step does not exist: ${normalizedId}`)
    this.sessions.appendEvent(sessionId, {
      type: 'plan.step.updated',
      payload: { id: plan.id, stepId: normalizedId, status },
    })
    return this.get(sessionId)!
  }

  public complete(sessionId: string): AgentPlan {
    const plan = this.require(sessionId)
    if (plan.status !== 'approved') throw new Error('Only an approved plan can be completed.')
    this.sessions.appendEvent(sessionId, { type: 'plan.completed', payload: { id: plan.id } })
    return this.get(sessionId)!
  }

  public cancel(sessionId: string): AgentPlan {
    const plan = this.require(sessionId)
    if (plan.status === 'complete' || plan.status === 'cancelled') {
      throw new Error(`Plan is already ${plan.status}.`)
    }
    this.sessions.appendEvent(sessionId, { type: 'plan.cancelled', payload: { id: plan.id } })
    return this.get(sessionId)!
  }

  public require(sessionId: string): AgentPlan {
    const plan = this.get(sessionId)
    if (!plan) throw new Error('No plan exists for this Session.')
    return plan
  }

  private requireDraft(sessionId: string): AgentPlan {
    const plan = this.require(sessionId)
    if (plan.status !== 'draft') throw new Error(`Plan is already ${plan.status}.`)
    return plan
  }
}

function createSteps(values: readonly string[]): AgentPlanStep[] {
  return values.map((text, index) => ({ id: `step-${index + 1}`, text, status: 'pending' }))
}

function normalizeSteps(values: readonly string[]): string[] {
  const steps = values.map((value) => requireText(value, 'Plan step'))
  if (steps.length < 1 || steps.length > 24) throw new Error('A plan requires 1 to 24 steps.')
  return steps.map((step) => step.slice(0, 1_000))
}

function freezePlan(plan: AgentPlan): AgentPlan {
  return Object.freeze({
    ...plan,
    steps: Object.freeze(plan.steps.map((step) => Object.freeze({ ...step }))),
  })
}

function isPlan(value: unknown): value is AgentPlan {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.sessionId === 'string'
    && typeof value.objective === 'string'
    && Array.isArray(value.steps)
    && value.steps.every(isPlanStep)
    && value.status === 'draft'
    && (value.reviewFeedback === null || typeof value.reviewFeedback === 'string')
    && typeof value.createdAt === 'number'
    && typeof value.updatedAt === 'number'
}

function isPlanDraft(value: Record<string, unknown>): value is Record<string, unknown> & {
  objective: string
  steps: AgentPlanStep[]
} {
  return typeof value.objective === 'string'
    && Array.isArray(value.steps)
    && value.steps.every(isPlanStep)
}

function isPlanStep(value: unknown): value is AgentPlanStep {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.text === 'string'
    && isPlanStepStatus(value.status)
}

function isPlanStepUpdate(value: Record<string, unknown>): value is Record<string, unknown> & {
  stepId: string
  status: AgentPlanStepStatus
} {
  return typeof value.stepId === 'string' && isPlanStepStatus(value.status)
}

function isPlanStepStatus(value: unknown): value is AgentPlanStepStatus {
  return value === 'pending' || value === 'in_progress' || value === 'complete' || value === 'skipped'
}

function requireText(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} cannot be empty.`)
  return normalized
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
