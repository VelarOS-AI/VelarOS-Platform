import type { ActiveContextArtifact } from '#contracts'

export type GoalLifecycleStatus =
  | 'active'
  | 'paused'
  | 'complete'
  | 'blocked'
  | 'cancelled'
  | 'removed'
export type GoalDockTone = 'active' | 'paused' | 'blocked' | 'complete' | 'cancelled'
export type GoalDockPrimaryAction = 'pause' | 'continue'
export type GoalDockAction = GoalDockPrimaryAction | 'remove'

export interface GoalDockViewModel {
  id: string
  objective: string
  status: GoalLifecycleStatus
  tone: GoalDockTone
  primaryAction: GoalDockPrimaryAction
  actions: readonly GoalDockAction[]
  blockedAuditTurns: number
  updatedAt: number
}

function resolveStatus(artifact: ActiveContextArtifact): GoalLifecycleStatus {
  const status = artifact.metadata?.goalStatus
  if (
    status === 'active' ||
    status === 'paused' ||
    status === 'complete' ||
    status === 'blocked' ||
    status === 'cancelled' ||
    status === 'removed'
  ) return status
  if (artifact.status === 'archived') return 'removed'
  return artifact.status === 'completed' ? 'complete' : 'active'
}

export function buildGoalDockViewModel(
  artifact: ActiveContextArtifact
): Nullable<GoalDockViewModel> {
  const status = resolveStatus(artifact)
  if (status !== 'active' && status !== 'paused' && status !== 'blocked') return null
  const primaryAction = status === 'active' ? 'pause' : 'continue'
  const blockedAuditTurns = artifact.metadata?.blockedAuditTurns
  return {
    id: artifact.id,
    objective: artifact.content,
    status,
    tone: status,
    primaryAction,
    actions: [primaryAction, 'remove'],
    blockedAuditTurns: Number.isFinite(blockedAuditTurns)
      ? Math.max(0, Math.floor(Number(blockedAuditTurns)))
      : 1,
    updatedAt: artifact.updatedAt,
  }
}
