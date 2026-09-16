import { toNullable } from '@velaros-ai/core'

import type { ExecutionTaskPlanStep, ExecutionTaskRecord, ToolExecutionPlanItemStatus } from '../../types/agent.js'

/** 把步骤标题压成可读的 id：全小写、非字母数字一律换成 `-`、去掉首尾的 `-`，再截到 48 字符。同名步骤重提时能落回同一个 id。 */
export function slugifyPlanStepTitle(title: string): string {
  const replaced = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
  let start = 0
  let end = replaced.length
  while (replaced[start] === '-') start += 1
  while (end > start && replaced[end - 1] === '-') end -= 1
  return replaced.slice(start, end).slice(0, 48)
}

/** 把步骤标题归一成比对用的形态（去首尾空白、连续空白压成一个空格、转小写），用来判断模型这次写的步骤是不是上次那一条。 */
export function normalizePlanTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** 把工具侧的步骤状态词翻成账本用的状态：只有 `in_progress` 要改写成 `running`，其余同名直通。 */
export function toExecutionPlanStepStatus(status: ToolExecutionPlanItemStatus): ExecutionTaskPlanStep['status'] {
  return status === 'in_progress' ? 'running' : status
}

/** 找这个任务当前该由本角色亲自推进的那一步：本角色的自执行步骤里，正在跑的优先，其次是已经可动手（actionable）的待办。都没有时返回 null。 */
export function findCurrentSelfStep(task: ExecutionTaskRecord): Nullable<ExecutionTaskPlanStep> {
  return toNullable(task.executionPlan.find((item) =>
    item.mode === 'self'
    && item.roleId === task.roleId
    && (item.status === 'running' || (item.status === 'pending' && item.actionable))
  ))
}
