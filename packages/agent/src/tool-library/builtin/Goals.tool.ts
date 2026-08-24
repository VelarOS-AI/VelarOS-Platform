import { z } from 'zod'

import { renderParameterDescription as parameterDescription } from '@velaros-ai/agent/tool-contract'
import { isPresent, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { defineVelaTool } from '../defineVelaTool'

import { directiveTypeSchema } from './ActiveDirectives'
import {
  assertGoalCanComplete,
  buildGoalLifecycleUpsertInput,
  buildGoalStateUpsertInput,
  buildGoalUpsertInput,
  completeGoalStep,
  findCurrentGoalArtifact,
  type GoalConstraint,
  type GoalStep,
  toGoalSnapshot,
} from './Goals'
import { planStatusSchema } from './Plans'
import { describeStepRefsForModel } from './StepRefs'

/** 目标步骤 → 模型可引用清单(共享步骤引擎;目标步骤的标题字段是 step)。 */
function describeGoalStepRefsForModel(
  steps: readonly GoalStep[]
): Array<{ ref: number; title: string; status: string }> {
  return describeStepRefsForModel(steps, (step) => step.step)
}

const goalStatusSchema = z.enum(['active', 'paused', 'complete', 'blocked', 'cancelled'])
const goalStepSchema = z.object({
  id: z.string().min(1).max(80).optional().describe(
    parameterDescription({
      description: '稳定步骤 ID；已有步骤可复用。',
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

const goalConstraintSchema = z.object({
  id: z.string().min(1).max(120).optional().describe(
    parameterDescription({
      description: '可选稳定 ID；更新同一约束时复用。',
    })
  ),
  title: z.string().min(1).max(160).describe(
    parameterDescription({
      description: '约束标题，简短描述用户固定的规则。',
    })
  ),
  content: z.string().min(1).max(1000).describe(
    parameterDescription({
      description: '后续轮次必须遵守的具体约束内容。',
    })
  ),
  directiveType: directiveTypeSchema.describe(
    parameterDescription({
      description: '约束类型。',
      values: [
        'prohibition：禁令或不允许做的事。',
        'preference：用户偏好。',
        'process：执行流程要求。',
        'requirement：结果或行为需求。',
        'other：无法归类但用户明确要求固定。',
      ],
    })
  ),
  sourceMessageId: z.string().min(1).max(120).optional().describe(
    parameterDescription({
      description: '触发该约束的用户消息 ID；没有时省略。',
    })
  ),
})

const getGoal = defineVelaTool<Record<string, never>>({
  name: 'goal:get',
  role: 'inspect',
  category: 'planning',
  summary: '读取当前 session 的目标模式目标状态。',
  suitable: ['目标模式下需要确认目标是否已创建、完成或进入受阻审计。'],
  forbidden: ['不要用它修改目标状态。'],
  usage: ['无需参数。'],
  examples: [{}],
  notes: ['目标模式下收尾前应先确认当前目标状态。'],
  schema: z.object({}),
  permissions: [],
  isConcurrencySafe: () => true,
  execute: async (_input, ctx) => {
    const artifacts = await ctx.activeContext.listActiveContextArtifacts({
      status: 'all',
      kinds: ['requirement'],
    })
    const artifact = findCurrentGoalArtifact(artifacts)
    const goal = artifact ? toGoalSnapshot(artifact) : null

    return {
      status: goal?.status ?? 'none',
      goal,
    }
  },
})

const createGoal = defineVelaTool<{
  objective: string
  token_budget?: number
  steps?: GoalStep[]
  constraints?: GoalConstraint[]
}>({
  name: 'goal:create',
  role: 'control',
  category: 'planning',
  summary: '为需要长时间持续工作的任务创建当前 session 活动目标。',
  suitable: [
    '模型判断任务需要长时间持续工作时，应自主创建活动目标。',
    '目标模式刚开始且尚未存在活动目标。',
  ],
  forbidden: [
    '不要为短小、可立即完成的任务创建目标；用户明确要求不用目标模式时不得自主启用。',
    '不要在已有活动目标时重复创建；改目标内容或完成/阻塞状态请用 goal:update。重复调用只会返回并保留当前目标。',
  ],
  usage: [
    '预计任务会长时间运行、跨多轮推进或等待后台工作时，可主动创建目标；普通任务不要创建。',
    'objective 写清本次要达成的结果；token_budget 只有用户明确给预算时才传。',
    '目标生命周期步骤写入 steps；如果用户同时要求可见 plan/计划，另行调用 plan:update 维护 execution plan；需要持续遵守的用户约束写入 constraints。',
  ],
  examples: [
    {
      objective: '修复保存失败并跑验证',
      steps: [{ step: '定位保存失败路径', status: 'in_progress' }],
    },
  ],
  notes: ['同一 session 同时只允许一个活动目标；重复创建是幂等读取，不会覆盖当前目标。'],
  schema: z.object({
    objective: z.string().trim().min(1).max(2000).describe(
      parameterDescription({
        description: '本次目标模式要达成的具体目标。',
      })
    ),
    token_budget: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        parameterDescription({
          description: '可选 token 预算；只有用户明确要求预算时设置。',
        })
      ),
    steps: z
      .array(goalStepSchema)
      .min(1)
      .max(12)
      .optional()
      .describe(
        parameterDescription({
          description: '目标拆解出的完整生命周期步骤列表；不替代 plan:update 的可见 execution plan。',
        })
      ),
    constraints: z
      .array(goalConstraintSchema)
      .min(1)
      .max(20)
      .optional()
      .describe(
        parameterDescription({
          description: '仅在当前目标边界内持续遵守的完整约束列表；跨目标长期有效的用户指令使用 active directive。',
        })
      ),
  }),
  permissions: [],
  isConcurrencySafe: () => false,
  execute: async (input, ctx) => {
    ctx.abortSignal.throwIfAborted()
    const artifacts = await ctx.activeContext.listActiveContextArtifacts({
      status: 'all',
      kinds: ['requirement'],
    })
    const current = findCurrentGoalArtifact(artifacts)
    if (current && toGoalSnapshot(current).status === 'active') {
      const goal = toGoalSnapshot(current)
      return {
        status: goal.status,
        goal,
        reused: true,
        nextAction: 'An active goal already exists and was preserved. Use goal:update to change or complete it.',
      }
    }

    const artifact = await ctx.activeContext.upsertActiveContextArtifact(
      buildGoalUpsertInput({
        objective: input.objective.trim(),
        tokenBudget: input.token_budget,
        steps: input.steps,
        constraints: input.constraints,
        now: Date.now(),
      })
    )
    const goal = toGoalSnapshot(artifact)

    return {
      status: goal.status,
      goal,
    }
  },
})

const updateGoal = defineVelaTool<{
  status?: 'active' | 'paused' | 'complete' | 'blocked' | 'cancelled'
  objective?: string
  steps?: GoalStep[]
  complete_step?: string | number
  constraints?: GoalConstraint[]
}>({
  name: 'goal:update',
  role: 'control',
  category: 'planning',
  summary: '更新当前 session 的目标，支持暂停、恢复、完成、受阻或取消。',
  suitable: [
    '需要同步目标、步骤或约束状态。',
    '需要暂停或恢复目标。',
    '目标已实际完成、用户取消目标，或模型确认存在无法继续推进的真实阻碍。',
  ],
  forbidden: [
    '不要用它创建目标。',
    '不要仅因为任务困难、耗时、结果不确定或希望获得澄清就草率标记 blocked。',
    '不要在用户仍要求继续推进时把目标标记 cancelled。',
  ],
  usage: [
    '维护步骤最省心:传完整 steps 列表(每步带 status),这一项就能同步全部步骤;想改哪步就改它的 status。',
    '完成某步的简写:传 complete_step(1-based 序号或精确标题,别自造 id);host 标记 completed 并推进下一个 pending。steps 与 complete_step 可一起传。',
    'status=complete 宣布目标完成:未收尾的 pending/in_progress 步骤会被自动标完成,不用逐个 complete_step。',
    'status=blocked 宣布目标受阻:模型确认缺少必要授权、用户输入或外部状态等真实阻碍导致无法继续推进时,可以自行调用,不需要等待多轮审计。',
    'status=paused 暂停目标并结束本次推进；后续得到继续指令时用 status=active 恢复。',
    'status=cancelled 只用于用户取消、目标被明确替换或已确认不再需要继续的情况。',
    '所有字段都不传则视为读取当前目标、不报错。',
  ],
  examples: [
    { steps: [{ step: '跑验证', status: 'in_progress' }] },
    { complete_step: 1 },
    { status: 'paused' },
    { status: 'active' },
    { status: 'complete' },
    { status: 'blocked' },
    { status: 'cancelled' },
  ],
  notes: ['返回里的 steps 字段给出每步 ref(序号)+标题+状态,下次引用照它传。目标进入终态后,目标模式收尾门才允许本次执行完成。'],
  schema: z
    .object({
      status: goalStatusSchema
        .optional()
        .describe(
          parameterDescription({
            description: '目标生命周期状态；不传时仅更新目标内容字段。',
            values: [
              'active：恢复暂停的目标并继续推进。',
              'paused：暂停目标并结束本次推进，保留后续恢复入口。',
              'complete：目标已经真正完成。',
              'blocked：模型确认存在无法继续推进的真实阻碍。',
              'cancelled：用户取消、目标被替换或明确不再需要继续。',
            ],
          })
        ),
      objective: z.string().trim().min(1).max(2000).optional().describe(
        parameterDescription({
          description: '可选的新目标描述；省略则保留当前目标。',
        })
      ),
      steps: z
        .array(goalStepSchema)
        .min(1)
        .max(12)
        .optional()
        .describe(
          parameterDescription({
            description: '目标拆解出的完整生命周期步骤列表；不替代 plan:update 的可见 execution plan。',
          })
        ),
      complete_step: z
        .union([z.string().trim().min(1).max(160), z.number().int().positive().max(12)])
        .optional()
        .describe(
          parameterDescription({
            description: '可选:完成一个目标步骤;用 1-based 序号或精确标题引用。',
            notes: [
              '步骤通常没有 id,优先用序号;不要自造 id。',
              '可以和 steps 一起传:先按 steps 重建、再完成引用的步骤。',
            ],
          })
        ),
      constraints: z
        .array(goalConstraintSchema)
        .min(1)
        .max(20)
        .optional()
        .describe(
          parameterDescription({
            description: '仅在当前目标边界内持续遵守的完整约束列表;跨目标长期有效的用户指令使用 active directive。',
          })
        ),
    }),
  permissions: [],
  isConcurrencySafe: () => false,
  execute: async (input, ctx) => {
    ctx.abortSignal.throwIfAborted()
    const artifacts = await ctx.activeContext.listActiveContextArtifacts({
      status: 'all',
      kinds: ['requirement'],
    })
    const artifact = findCurrentGoalArtifact(artifacts)
    const currentStatus = artifact ? toGoalSnapshot(artifact).status : null
    if (!artifact || (currentStatus !== 'active' && currentStatus !== 'paused')) {
      throw new AppError('VALIDATION', 'No active goal exists. Use goal:create first.')
    }

    const hasStatus = !!input.status
    const hasSteps = !!input.steps?.length
    const hasComplete = isPresent(input.complete_step)
    const hasObjective = !!input.objective
    const hasConstraints = !!input.constraints?.length

    // 空调用 = 无操作:回带当前目标状态,不报错(宽容)。
    if (!hasStatus && !hasSteps && !hasComplete && !hasObjective && !hasConstraints) {
      const goal = toGoalSnapshot(artifact)
      return {
        status: goal.status,
        goal,
        steps: describeGoalStepRefsForModel(goal.steps),
        noop: true,
      }
    }

    // 基线步骤:传了 steps 就用它重建,否则沿用当前;complete_step 可与 steps 组合(先重建再完成)。
    const baseSteps = hasSteps ? input.steps! : toGoalSnapshot(artifact).steps
    const stepCompletion = hasComplete ? completeGoalStep(baseSteps, input.complete_step!) : null
    let nextSteps = stepCompletion ? stepCompletion.steps : hasSteps ? baseSteps : undefined

    // status=complete 时把还没收尾的 pending/in_progress 步骤自动标 completed:模型宣布目标完成
    // 即隐含这些步骤已做,不该因为没逐个 complete_step 就被拦(failed 步骤仍保留、由下面的门禁判定)。
    if (input.status === 'complete') {
      const source = nextSteps ?? toGoalSnapshot(artifact).steps
      nextSteps = source.map((step) =>
        step.status === 'pending' || step.status === 'in_progress'
          ? { ...step, status: 'completed' as const }
          : step
      )
    }

    let currentArtifact = artifact
    if (hasObjective || nextSteps || hasConstraints) {
      currentArtifact = await ctx.activeContext.upsertActiveContextArtifact(
        buildGoalStateUpsertInput({
          artifact,
          objective: input.objective,
          steps: nextSteps,
          constraints: input.constraints,
        })
      )
    }

    const current = toGoalSnapshot(currentArtifact)
    if (input.status === 'complete') {
      assertGoalCanComplete(current)
    }
    const updatedArtifact = input.status
      ? await ctx.activeContext.upsertActiveContextArtifact(
          buildGoalLifecycleUpsertInput({
            artifact: currentArtifact,
            status: input.status,
            now: Date.now(),
          })
        )
      : currentArtifact
    const goal = toGoalSnapshot(updatedArtifact)

    return {
      status: goal.status,
      goal,
      steps: describeGoalStepRefsForModel(goal.steps),
      completedStep: toNullable(stepCompletion?.completedStep),
      promotedStep: toNullable(stepCompletion?.promotedStep),
      allStepsResolved: toNullable(stepCompletion?.allStepsResolved),
      nextAction: stepCompletion
        ? stepCompletion.allStepsResolved
          ? 'All goal steps are resolved. If the objective is truly complete, call goal:update({status:"complete"}).'
          : 'Continue with the active goal step.'
        : null,
      finalTokenUsage: null,
    }
  },
})

const goalTools = {
  'goal:get': getGoal,
  'goal:create': createGoal,
  'goal:update': updateGoal,
}

export { goalTools }
