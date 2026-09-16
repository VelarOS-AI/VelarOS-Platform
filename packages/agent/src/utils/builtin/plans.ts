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

/**
 * 定出本次更新后计划的生命周期：模型显式写了 `lifecycle` 就照写；没写则看步骤——
 * **有步骤且每一步都是 completed / skipped / failed** 才判 `completed`，否则 `active`。
 * 步骤为空时刻意判 `active` 而不是 `completed`：空计划是「还没排」，不是「做完了」。
 */
export function resolvePlanLifecycle(input: UpdatePlanInput): PlanLifecycle {
  if (input.lifecycle) return input.lifecycle

  const hasSteps = !!input.plan?.length
  const allTerminal = hasSteps && input.plan!.every(
    (step) =>
      step.status === 'completed' || step.status === 'skipped' || step.status === 'failed'
  )
  return allTerminal ? 'completed' : 'active'
}

/**
 * 把执行侧的计划步骤投影成用户/模型面的形状：`title` 改叫 `step`，保留 id 与 objective，
 * 状态过 `toUserPlanStatus` 收窄。执行侧独有的字段（调度、归属等）一概不带出去。
 */
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
  emptyMessage: '当前执行计划里没有可以完成的步骤。',
  resolvedStatuses: ['completed', 'skipped', 'failed'],
  promoteFallbackAnywhere: false,
}

/** 收尾单个计划步骤：等价于用单元素数组调 `completePlanSteps`，只是省掉调用方包一层。 */
export function completePlanStep(
  steps: readonly UserPlanStep[],
  stepRef: PlanStepRef
): PlanStepCompletionResult {
  return completePlanSteps(steps, [stepRef])
}

/**
 * 按 plan 语义收尾一个或多个步骤：走共用步骤引擎，配 `PlanStepEngineOptions`——
 * failed 计入「已解决」，且**不做全表回头晋升**（只晋升收尾位之后的 pending，计划步骤有先后）。
 * 返回新的 `plan` 数组、本次收尾的步骤、被自动晋升的步骤，以及是否全部解决。
 * 引用匹配不上会抛带可引用清单的 `VALIDATION`，单个引用也接受（不必自己包数组）。
 */
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
/**
 * 把当前计划渲染成一段文本：可选的 `说明：…` 行（explanation 为空白就整行不出现）、
 * 固定的 `步骤：` 行，其后每步一行 `<1-based 序号>. [<状态>] <标题>`，
 * 且 objective 与标题不同时才追加 ` - <objective>`（相同就不重复占字）。
 * 序号就是模型下次 complete_step 能直接引用的 ref。
 */
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

/**
 * 把执行侧状态收窄成模型面五态：`running` 与 `delegated` 都折成 `in_progress`
 * （「是不是自己干的」属于调度细节，对模型只需要知道这步在进行中），其余状态原样透传。
 */
function toUserPlanStatus(status: ExecutionTaskPlanStep['status']): UserPlanStatus {
  if (status === 'running' || status === 'delegated') return 'in_progress'
  return status
}
