// 域：主 Agent 执行的**目标生命周期**（宿主限制下的墙钟判定 + 自主目标探测）。
import { isTrue } from '@velaros-ai/core'
import { findCurrentGoalArtifact, getGoalLifecycleStatus } from '@velaros-ai/core/utils/goalLifecycle'

import type { AgentExecutionLimits } from '../ExecutionLimits'
import type { AgentExecutionConfig } from '../RuntimeConfiguration'

import type { RunnerToolContext } from './host-ports'

/** 本次执行的墙钟上限：Goal 模式使用宿主注入的长任务上限，否则使用普通上限。 */
export function resolveExecutionWallClockDeadlineMs(
  goalMode: AgentExecutionConfig['goalMode'],
  limits: AgentExecutionLimits
): number {
  return isTrue(goalMode)
    ? limits.goalExecutionWallClockTimeoutMs
    : limits.standardExecutionWallClockTimeoutMs
}

/** 是否存在模型自主创建的活动目标（用于把普通执行的墙钟上限延长到 goal 上限）。 */
export async function hasActiveExecutionGoal(
  toolContext: Pick<RunnerToolContext, 'activeContext'>
): Promise<boolean> {
  const artifacts = await toolContext.activeContext.listActiveContextArtifacts({
    status: 'all',
    kinds: ['requirement'],
  })
  const goal = findCurrentGoalArtifact(artifacts)
  return !!goal && getGoalLifecycleStatus(goal) === 'active'
}
