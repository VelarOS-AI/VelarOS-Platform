import { z } from 'zod'

import {
  renderParameterDescription as parameterDescription,
} from '@velaros-ai/agent/tool-contract'
import { isPresent, toNullable } from '@velaros-ai/core'

import { defineVelaTool } from '../defineVelaTool'

import type { UpdatePlanInput } from './Plans'
import {
  completePlanSteps,
  formatActivePlanContent,
  planLifecycleSchema,
  planStatusSchema,
  resolvePlanLifecycle,
  toUserPlanSteps,
} from './Plans'
import { describeStepRefsForModel } from './StepRefs'

const planStepRefSchema = z.union([z.string().trim().min(1).max(160), z.number().int().positive()])

/** 计划步骤 → 模型可引用清单(共享步骤引擎;执行计划的标题字段是 title)。 */
function describePlanStepRefsForModel(
  plan: ReadonlyArray<{ title: string; status: string }>
): Array<{ ref: number; title: string; status: string }> {
  return describeStepRefsForModel(plan, (step) => step.title)
}

/** 更新当前 execution 的可见计划。 */
const updatePlan = defineVelaTool<UpdatePlanInput>({
  name: 'plan:update',
  role: 'control',
  category: 'planning',
  summary: '更新当前 execution 的可见执行计划。',
  suitable: [
    '任务复杂、需要多个具体步骤时，应由模型自主创建计划。',
    '需要同步现有计划进度。',
  ],
  forbidden: ['不要为简单单步任务创建计划；用户明确要求不用计划时不得自主启用。'],
  usage: [
    '首次为复杂任务传入 plan 会自主启用计划模式；先只建立计划，再按计划模式要求向用户确认后实施。',
    '维护计划最省心的方式:直接传完整 plan 列表(每步带 status:pending/in_progress/completed),这一项就能建立并同步整个计划,想改哪步就改它的 status。',
    '完成某步的简写:传 complete_step(1-based 序号或精确标题;步骤没有 id,别自造 "step-1"),host 标记 completed 并自动推进下一个 pending。',
    'plan 和 complete_step 可以一起传(先按 plan 重建、再完成引用步骤);两个都不传则视为读取当前计划、不报错。',
  ],
  examples: [
    { plan: [{ step: "实现", status: "in_progress" }, { step: "验证", status: "pending" }] },
    { complete_step: 1 },
    { complete_step: ['实现', '验证'] },
  ],
  notes: [
    '返回里的 steps 字段给出每步 ref(序号)+标题+状态,下次引用照它传。首次自主建计划不要与实施工具同批；进入实施后，进度更新可与对应执行工具同批发出。',
  ],
  schema: z
    .object({
      explanation: z.string().min(1).max(500).optional().describe(
        parameterDescription({
          description: '本次计划变化的简短说明。',
        })
      ),
      lifecycle: planLifecycleSchema
        .optional()
        .describe(
          parameterDescription({
            description: '计划生命周期。',
            values: [
              'active：计划仍在执行。',
              'completed：当前任务已完成。',
              'archived：用户改变目标或废弃旧方案。',
            ],
          })
        ),
      plan: z
        .array(
          z.object({
            id: z.string().min(1).max(80).optional().describe(
              parameterDescription({
                description: '稳定步骤 ID。',
                notes: ['已有步骤可复用。'],
              })
            ),
            step: z.string().min(1).max(160).describe(
              parameterDescription({
                description: '步骤标题。',
              })
            ),
            objective: z.string().min(1).max(300).optional().describe(
              parameterDescription({
                description: '可选的步骤目标。',
              })
            ),
            status: planStatusSchema.describe(
              parameterDescription({
                description: '步骤状态。',
                values: [
                  'pending：尚未开始。',
                  'in_progress：正在执行。',
                  'completed：已完成。',
                  'failed：执行失败。',
                  'skipped：已跳过。',
                ],
              })
            ),
          })
        )
        .min(1)
        .max(12)
        .optional()
        .describe(
          parameterDescription({
            description: '完整的当前计划列表。',
            notes: ['按执行顺序排列。'],
          })
        ),
      complete_step: z
        // 空数组不再硬拒(模型会传 [] 表示"这次没有要完成的"),execute 侧按未传处理(no-op)。
        .union([planStepRefSchema, z.array(planStepRefSchema).max(12)])
        .optional()
        .describe(
          parameterDescription({
            description: '要标记完成的一个或多个步骤:用 1-based 序号或精确标题引用。',
            notes: [
              '步骤通常没有 id,优先用序号(1、2、3…);不要自造 id。',
              '可以和 plan 一起传:先按 plan 重建列表,再完成引用的步骤。',
              '传空数组等价不传(无步骤要完成)。',
            ],
          })
        ),
    }),
  permissions: [],
  isConcurrencySafe: () => true,
  execute: async (input, ctx) => {
    ctx.abortSignal.throwIfAborted()
    const interaction = ctx.interaction

    // 先读取旧计划，用于判断这次是否是初始计划。
    const previousPlan = interaction.getCurrentPlan()
    const previousUserPlan = toUserPlanSteps(previousPlan)

    const hasPlan = !!input.plan?.length
    // 空数组视为"没有要完成的步骤"(宽容:模型重报计划时常带 complete_step: [])。
    const hasComplete =
      isPresent(input.complete_step) &&
      !(Array.isArray(input.complete_step) && input.complete_step.length === 0)

    // 空调用 = 无操作:回带当前计划状态,不报错(宽容:模型偶尔空传不该被判失败)。
    if (!hasPlan && !hasComplete && !input.lifecycle && !input.explanation)
      return {
        updated: false,
        noop: true,
        plan: previousPlan,
        steps: describePlanStepRefsForModel(previousPlan),
      }

    // 基线列表:传了完整 plan 就用它重建,否则沿用旧计划。
    // complete_step 与 plan 可组合:先重建、再针对重建后的列表完成引用步骤。
    const basePlan = hasPlan ? input.plan! : previousUserPlan
    const stepCompletion = hasComplete ? completePlanSteps(basePlan, input.complete_step!) : null
    const effectivePlan = stepCompletion ? stepCompletion.plan : basePlan

    if (!effectivePlan.length)
      // 只更新 lifecycle/explanation 却没有任何步骤且无旧计划:无步骤可维护,回带当前(no-op)。
      return {
        updated: false,
        noop: true,
        plan: previousPlan,
        steps: describePlanStepRefsForModel(previousPlan),
      }

    ctx.codingSession.enablePromptFeatures(
      ['plan'],
      previousPlan.length === 0
        ? 'model autonomously created a complex-task plan'
        : 'model maintained an execution plan'
    )

    const updateWithPlan = {
      explanation: input.explanation,
      lifecycle: input.lifecycle,
      plan: effectivePlan,
    }

    const plan = interaction.updateCurrentPlan(updateWithPlan)
    const lifecycle = resolvePlanLifecycle(updateWithPlan)
    await ctx.activeContext.upsertActiveContextArtifact({
      id: 'active-plan',
      kind: 'plan',
      scope: 'session',
      status: lifecycle === 'archived' ? 'archived' : lifecycle,
      resourceId: null,
      title: input.explanation?.trim() || '当前执行计划',
      content: formatActivePlanContent(toNullable(input.explanation), plan),
      metadata: {
        source: 'plan:update',
        executionId: interaction.executionId,
        planStepCount: plan.length,
      },
    })

    return {
      updated: true,
      isInitialPlan: previousPlan.length === 0,
      activeContextStatus: lifecycle,
      explanation: toNullable(input.explanation),
      plan,
      // 显式回带每步的可引用 ref(1-based 序号)+标题+状态:下次 complete_step 直接照 ref 传,
      // 不必自己数数组位置、更不要自造 id(步骤没有 id)。
      steps: describePlanStepRefsForModel(plan),
      completedStep: toNullable(stepCompletion?.completedStep),
      completedSteps: stepCompletion?.completedSteps ?? [],
      promotedStep: toNullable(stepCompletion?.promotedStep),
      allStepsResolved: toNullable(stepCompletion?.allStepsResolved),
    }
  },
})

/** 读取当前 execution 的计划和执行建议。 */
const getPlan = defineVelaTool<Record<string, never>>({
  name: 'plan:get',
  role: 'inspect',
  category: 'planning',
  summary: '读取当前 execution 的可见执行计划。',
  suitable: ['需要确认当前任务步骤、状态或系统推荐下一步。'],
  forbidden: ['不要用它修改计划。'],
  usage: ['无需参数。'],
  examples: [{}],
  notes: ['需要 execution 上下文。'],
  schema: z.object({}),
  permissions: [],
  isConcurrencySafe: () => true,
  execute: async (_input, ctx) => {
    const interaction = ctx.interaction

    // 同时返回任务、推荐动作和执行建议，方便模型恢复当前执行上下文。
    const currentPlan = interaction.getCurrentPlan()
    return {
      plan: currentPlan,
      // 显式可引用 ref(1-based 序号):complete_step 直接照 ref 传,别自造 id。
      steps: describePlanStepRefsForModel(currentPlan),
      task: interaction.getCurrentTask(),
      recommendedAction: interaction.getCurrentRecommendedAction(),
      executionAdvice: interaction.getCurrentExecutionAdvice(),
    }
  },
})
const plansTools = {
  'plan:update': updatePlan,
  'plan:get': getPlan,
}

export { plansTools }
