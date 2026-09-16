// ExecTaskLedger 用到的纯函数（不碰实例状态）。
import type { ExecutionTaskPlanStep } from '../../types/agent.js'

/** 这份计划里该角色是否还有自己在跑的 self 步；有就不许再派一次。 */
export function hasRunningOwnSelfStep(
  plan: readonly ExecutionTaskPlanStep[],
  roleId: string
): boolean {
  return plan.some(
    (step) => step.mode === 'self' && step.roleId === roleId && step.status === 'running'
  )
}
