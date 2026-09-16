import { z } from 'zod'

import type { ExecutionTaskPlanStep } from '../../types/agent.js'
import type { PlanLifecycle, PlanStepCompletionResult, PlanStepRef, StepEngineOptions,UpdatePlanInput, UserPlanStatus, UserPlanStep } from '../../types/builtin.js'

import { completeSteps } from './step-refs'

/** 对模型开放的计划步骤状态，收窄为用户能理解的几种状态。 */
export const planStatusSchema = z.enum([
  'pending',
  'in_progress',
  'completed',
  'failed',
  'skipped',
] satisfies [UserPlanStatus, ...UserPlanStatus[]])

export const planLifecycleSchema = z.enum(['active', 'paused', 'completed', 'archived'])

export function resolvePlanLifecycle(input: UpdatePlanInput): PlanLifecycle {
  if (input.lifecycle) return input.lifecycle

  const hasSteps = !!input.plan?.length
  const allTerminal = hasSteps && input.plan!.every(
    (step) =>
      step.status === 'completed' || step.status === 'skipped' || step.status === 'failed'
  )
  return allTerminal ? 'completed' : 'active'
}

export function toUserPlanSteps(plan: readonly ExecutionTaskPlanStep[]): UserPlanStep[] {
  return plan.map((step) => ({
    id: step.id,
    step: step.title,
    objective: step.objective,
    status: toUserPlanStatus(step.status),
  }))
}

/** plan 侧步骤引擎参数:failed 计入已解决;无 in_progress 时只晋升完成位之后的 pending。 */
const PlanStepEngineOptions: StepEngineOptions = {
  kindLabel: 'plan',
  listLabel: '当前计划步骤',
  emptyMessage: 'Active execution plan has no steps to complete.',
  resolvedStatuses: ['completed', 'skipped', 'failed'],
  promoteFallbackAnywhere: false,
}

export function completePlanStep(
  steps: readonly UserPlanStep[],
  stepRef: PlanStepRef
): PlanStepCompletionResult {
  return completePlanSteps(steps, [stepRef])
}

export function completePlanSteps(
  steps: readonly UserPlanStep[],
  stepRefs: PlanStepRef | readonly PlanStepRef[]
): PlanStepCompletionResult {
  const completion = completeSteps(steps, stepRefs, PlanStepEngineOptions)
  return {
    plan: completion.steps,
    completedStep: completion.completedStep,
    completedSteps: completion.completedSteps,
    promotedStep: completion.promotedStep,
    allStepsResolved: completion.allStepsResolved,
  }
}
export function formatActivePlanContent(
  explanation: Nullable<string>,
  plan: ExecutionTaskPlanStep[]
): string {
  const lines = [
    explanation?.trim() ? `说明：${explanation.trim()}` : null,
    '步骤：',
    ...plan.map((step, index) => {
      const objective =
        step.objective && step.objective !== step.title ? ` - ${step.objective}` : ''
      return `${index + 1}. [${step.status}] ${step.title}${objective}`
    }),
  ]

  return lines.filter((line): line is string => !!line).join('\n')
}

function toUserPlanStatus(status: ExecutionTaskPlanStep['status']): UserPlanStatus {
  if (status === 'running' || status === 'delegated') return 'in_progress'
  return status
}
