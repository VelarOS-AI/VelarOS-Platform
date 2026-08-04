import { z } from 'zod'

import type { ExecutionTaskPlanStep, ToolExecutionPlanItemStatus } from '@velaros-ai/agent/protocol'

import type { StepEngineOptions } from './StepRefs'
import { completeSteps } from './StepRefs'

export type UserPlanStatus = Extract<
  ToolExecutionPlanItemStatus,
  'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped'
>

export interface UserPlanStep {
  /** 稳定步骤 id；已有步骤可复用。 */
  id?: string
  /** 步骤标题。 */
  step: string
  /** 可选步骤目标。 */
  objective?: string
  /** 当前步骤状态。 */
  status: UserPlanStatus
}

type PlanStepRef = string | number

/** 对模型开放的计划步骤状态，收窄为用户能理解的几种状态。 */
export const planStatusSchema = z.enum([
  'pending',
  'in_progress',
  'completed',
  'failed',
  'skipped',
] satisfies [UserPlanStatus, ...UserPlanStatus[]])

export const planLifecycleSchema = z.enum(['active', 'completed', 'archived'])

/** plan:update 工具入参。 */
export type UpdatePlanInput = {
  /** 本次计划变更的简短说明。 */
  explanation?: LooseOptional<string>
  /** 计划生命周期；完成或用户改变目标时应显式归档。 */
  lifecycle?: 'active' | 'completed' | 'archived'
  /** 当前完整计划列表，而不是增量 patch。 */
  plan?: UserPlanStep[]
  /** 标记当前计划中的一个或多个步骤已完成；传步骤 id、标题或 1-based 序号。 */
  complete_step?: PlanStepRef | PlanStepRef[]
}

interface PlanStepCompletionResult {
  plan: UserPlanStep[]
  completedStep: UserPlanStep
  completedSteps: UserPlanStep[]
  promotedStep: Nullable<UserPlanStep>
  allStepsResolved: boolean
}

export function resolvePlanLifecycle(input: UpdatePlanInput): 'active' | 'completed' | 'archived' {
  if (input.lifecycle === 'completed' || input.lifecycle === 'archived') return input.lifecycle

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
