import { z } from 'zod'

import { AgentToolLimits } from '../../contract/constants.js'
import type { ActiveContextArtifact, ExecutionTaskPlanStep } from '../../types/agent.js'
import type { PlanLifecycle, PlanStepCompletionResult, PlanStepRef, StepEngineOptions,UpdatePlanInput, UserPlanStatus, UserPlanStep } from '../../types/builtin.js'

import { completeSteps, describeStepRefsForModel } from './step-refs'

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

/** 步骤引用：1-based 序号或精确标题；标题长度与步骤标题上限一致，模型看得到。 */
export const planStepRefSchema: z.ZodType<string | number> = z.union([
  z.string().trim().min(1).max(AgentToolLimits.planning.stepTitleChars),
  z.number().int().positive(),
])

/** 当前执行计划在活动上下文里的固定 artifact id。 */
export const PlanArtifactId: string = 'active-plan'

/** 计划生命周期的取值表。 */
export const PlanLifecycleValues: readonly PlanLifecycle[] = ['active', 'paused', 'completed', 'archived']

/** 按取值表建的判定集合，用来认出历史 artifact 上存的生命周期。 */
export const PlanLifecycleSet: ReadonlySet<unknown> = new Set<unknown>(PlanLifecycleValues)

/** 在活动上下文条目里找出本次执行的计划条目；同一执行有多条时取最近更新的那条。 */
export function findPlanArtifact(
  artifacts: readonly ActiveContextArtifact[],
  executionId: string
): ActiveContextArtifact | undefined {
  return artifacts
    .filter(
      (candidate) =>
        candidate.id === PlanArtifactId &&
        candidate.kind === 'plan' &&
        candidate.metadata?.executionId === executionId
    )
    .sort((left, right) => right.updatedAt - left.updatedAt)[0]
}

/** 读当前计划的生命周期：优先用条目上存的值，其次看条目状态，最后按步骤推导。 */
export function readPlanLifecycle(
  artifacts: readonly ActiveContextArtifact[],
  plan: readonly ExecutionTaskPlanStep[],
  executionId: string
): PlanLifecycle {
  const artifact = findPlanArtifact(artifacts, executionId)
  const stored = artifact?.metadata?.planLifecycle
  if (PlanLifecycleSet.has(stored)) return stored as PlanLifecycle
  if (artifact?.status === 'archived') return 'archived'
  if (artifact?.status === 'completed') return 'completed'
  return resolvePlanLifecycle({ plan: toUserPlanSteps(plan) })
}

/** 计划步骤 → 模型可引用清单（共享步骤引擎；执行计划的标题字段是 title）。 */
export function describePlanStepRefsForModel(
  plan: ReadonlyArray<{ title: string; status: string }>
): Array<{ ref: number; title: string; status: string }> {
  return describeStepRefsForModel(plan, (step) => step.title)
}
