import { randomUUID } from 'node:crypto'

import type { AgentSessionEventPort } from '../../contract/requires.js'
import type { AgentPlan, AgentPlanStepStatus } from '../../types/product-session.js'
import { createSteps, freezePlan, isPlan, isPlanDraft, isPlanStepUpdate, isRecord, normalizeSteps, requireText, stringValue } from '../../utils/product-session/plans'

export class AgentPlanService {
  public constructor(private readonly sessions: AgentSessionEventPort) {}

  public get(sessionId: string): Nullable<AgentPlan> {
    let plan: Nullable<AgentPlan> = null
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






















