// SoloGoalLifecycle 用到的纯函数（不碰实例状态）。
import type { ActiveContextArtifact } from '../../types/agent.js'
import type { SoloGoalFinishingState, SoloGoalLifecycleStatus } from '../../types/loop.js'
import { toGoalSnapshot } from '../../utils/builtin/goals'

/** 读目标产物上的生命周期状态。 */
export function readSoloGoalStatus(artifact: ActiveContextArtifact): SoloGoalLifecycleStatus {
  return toGoalSnapshot(artifact).status
}

/** 读目标产物上「受阻已审计几轮」的计数。 */
export function readSoloGoalBlockedAuditTurns(artifact: ActiveContextArtifact): number {
  return toGoalSnapshot(artifact).blockedAuditTurns
}

/** 把目标产物投影成收尾闸门要的三件事：在不在、是不是终态、当前状态。 */
export function toSoloGoalFinishingState(goal: Nullable<ActiveContextArtifact>): SoloGoalFinishingState {
  if (!goal)
    return {
      exists: false,
      terminal: false,
      status: 'missing',
    }

  const snapshot = toGoalSnapshot(goal)
  const status = snapshot.status
  return {
    exists: true,
    terminal:
      status === 'complete' ||
      status === 'blocked' ||
      status === 'paused' ||
      status === 'cancelled' ||
      status === 'removed',
    status:
      status === 'paused' || status === 'cancelled' || status === 'removed' ? 'blocked' : status,
    objective: goal.content,
    blockedAuditTurns: readSoloGoalBlockedAuditTurns(goal),
  }
}
