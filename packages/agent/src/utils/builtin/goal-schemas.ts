// 域：`goal:*` 三个工具的模型面入参形状与步骤投影。
//
// 只放 schema 与纯投影：目标本身怎么建、怎么改在 impl/builtin/GoalOperations.ts 里。
import { z } from 'zod'

import { AgentToolLimits } from '../../contract/constants.js'
import type { GoalConstraint, GoalStep } from '../../types/builtin.js'
import { renderParameterDescription as parameterDescription } from '../toolkit/tool-description'

import { directiveTypeSchema } from './directives'
import { planStatusSchema } from './plans'
import { describeStepRefsForModel } from './step-refs'

/** 目标生命周期的取值。 */
export const goalStatusSchema: z.ZodType<'active' | 'paused' | 'complete' | 'blocked' | 'cancelled'> = z.enum(['active', 'paused', 'complete', 'blocked', 'cancelled'])

/** 一个目标步骤的入参形状：id 可选、标题必填、状态用计划步骤那一套。 */
export const goalStepSchema: z.ZodType<GoalStep> = z.object({
  id: z.string().min(1).max(AgentToolLimits.planning.stepIdChars).optional().describe(
    parameterDescription({
      description: '稳定步骤 ID；已有步骤可复用。',
    })
  ),
  step: z.string().min(1).max(AgentToolLimits.planning.stepTitleChars).describe(
    parameterDescription({
      description: '步骤标题。',
    })
  ),
  objective: z.string().min(1).max(AgentToolLimits.planning.stepObjectiveChars).optional().describe(
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

/** 一条目标约束的入参形状：与长期指令同型，只是作用域限在当前目标。 */
export const goalConstraintSchema: z.ZodType<GoalConstraint> = z.object({
  id: z.string().min(1).max(AgentToolLimits.directives.identifierChars).optional().describe(
    parameterDescription({
      description: '可选稳定 ID；更新同一约束时复用。',
    })
  ),
  title: z.string().min(1).max(AgentToolLimits.directives.titleChars).describe(
    parameterDescription({
      description: '约束标题，简短描述用户固定的规则。',
    })
  ),
  content: z.string().min(1).max(AgentToolLimits.directives.contentChars).describe(
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
  sourceMessageId: z.string().min(1).max(AgentToolLimits.directives.identifierChars).optional().describe(
    parameterDescription({
      description: '触发该约束的用户消息 ID；没有时省略。',
    })
  ),
})

/** 目标步骤 → 模型可引用清单（共享步骤引擎；目标步骤的标题字段是 step）。 */
export function describeGoalStepRefsForModel(
  steps: readonly GoalStep[]
): Array<{ ref: number; title: string; status: string }> {
  return describeStepRefsForModel(steps, (step) => step.step)
}
