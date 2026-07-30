import { isFiniteNumber, isString, isTrue } from '../typeGuards'
import type { ActiveContextArtifact, ActiveContextUpsertInput } from '../types'

import { toNullable } from './nullish'

const GoalArtifactId = 'active-goal'

type GoalLifecycleStatus = 'active' | 'paused' | 'complete' | 'blocked' | 'cancelled' | 'removed'
type GoalLifecycleAction = 'resume' | 'pause' | 'block' | 'complete' | 'cancel' | 'remove'
type GoalDockTone = 'active' | 'paused' | 'blocked' | 'complete' | 'cancelled'
type GoalDockPrimaryAction = 'pause' | 'continue'
type GoalDockAction = GoalDockPrimaryAction | 'remove'

interface GoalDockViewModel {
  id: string
  objective: string
  status: GoalLifecycleStatus
  tone: GoalDockTone
  primaryAction: GoalDockPrimaryAction
  actions: readonly GoalDockAction[]
  blockedAuditTurns: number
  updatedAt: number
}

function isGoalArtifact(artifact: ActiveContextArtifact): boolean {
  return artifact.kind === 'requirement' && isTrue(artifact.metadata?.goal)
}

/**
 * 目标生命周期状态闭集。
 *
 * `satisfies` 与联合类型咬合：往 {@link GoalLifecycleStatus} 加一档而忘了加进本表即编译红，
 * 不会像旧的逐值 `===` 链那样静默把新状态判成 `active`。
 */
const GoalLifecycleStatusValues = [
  'active',
  'paused',
  'complete',
  'blocked',
  'cancelled',
  'removed',
] as const satisfies readonly GoalLifecycleStatus[]

const GoalLifecycleStatusSet = new Set<string>(GoalLifecycleStatusValues)

function isGoalLifecycleStatus(value: unknown): value is GoalLifecycleStatus {
  return isString(value) && GoalLifecycleStatusSet.has(value)
}

function normalizeGoalLifecycleStatus(
  value: unknown,
  artifactStatus: ActiveContextArtifact['status']
): GoalLifecycleStatus {
  if (isGoalLifecycleStatus(value)) return value
  if (artifactStatus === 'archived') return 'removed'

  return artifactStatus === 'completed' ? 'complete' : 'active'
}

function readGoalBlockedAuditTurns(value: unknown): number {
  return isFiniteNumber(value) ? Math.max(0, Math.floor(value)) : 1
}

function getGoalLifecycleStatus(artifact: ActiveContextArtifact): GoalLifecycleStatus {
  return normalizeGoalLifecycleStatus(artifact.metadata?.goalStatus, artifact.status)
}

function isCurrentGoalStatus(status: GoalLifecycleStatus): boolean {
  return status === 'active' || status === 'paused'
}

function findCurrentGoalArtifact(
  artifacts: readonly ActiveContextArtifact[]
): Nullable<ActiveContextArtifact> {
  const goals = artifacts
    .filter(isGoalArtifact)
    .filter((artifact) => artifact.status !== 'archived')
    .sort((left, right) => right.updatedAt - left.updatedAt)

  return toNullable(
    goals.find((artifact) => isCurrentGoalStatus(getGoalLifecycleStatus(artifact))) ?? goals[0]
  )
}

function buildGoalMetadataForAction(
  artifact: ActiveContextArtifact,
  action: GoalLifecycleAction,
  now: number
): Record<string, unknown> {
  const previous = artifact.metadata ?? {}
  const blockedAuditTurns = readGoalBlockedAuditTurns(previous.blockedAuditTurns)
  const base = {
    ...previous,
    goal: true,
    blockedAuditTurns,
  }

  switch (action) {
    case 'resume':
      return {
        ...base,
        goalStatus: 'active',
        terminalAt: null,
        pausedAt: null,
        resumedAt: now,
      }
    case 'pause':
      return {
        ...base,
        goalStatus: 'paused',
        terminalAt: null,
        pausedAt: now,
      }
    case 'block':
      return {
        ...base,
        goalStatus: 'blocked',
        terminalAt: now,
        blockedAt: now,
      }
    case 'complete':
      return {
        ...base,
        goalStatus: 'complete',
        terminalAt: now,
      }
    case 'cancel':
      return {
        ...base,
        goalStatus: 'cancelled',
        terminalAt: now,
        cancelledAt: now,
      }
    case 'remove':
      return {
        ...base,
        goalStatus: 'removed',
        terminalAt: now,
        removedAt: now,
      }
  }
}

function getArtifactStatusForGoalAction(
  action: GoalLifecycleAction
): ActiveContextArtifact['status'] {
  switch (action) {
    case 'resume':
    case 'pause':
      return 'active'
    case 'remove':
      return 'archived'
    case 'block':
    case 'complete':
    case 'cancel':
      return 'completed'
  }
}

function goalLifecycleToUpsertInput(
  artifact: ActiveContextArtifact,
  action: GoalLifecycleAction,
  now = Date.now()
): ActiveContextUpsertInput {
  return {
    id: artifact.id,
    kind: 'requirement',
    scope: artifact.scope,
    status: getArtifactStatusForGoalAction(action),
    resourceId: artifact.resourceId,
    title: artifact.title,
    content: artifact.content,
    sourceMessageId: artifact.sourceMessageId,
    metadata: buildGoalMetadataForAction(artifact, action, now),
  }
}

function getGoalDockTone(status: GoalLifecycleStatus): GoalDockTone {
  switch (status) {
    case 'blocked':
    case 'removed':
      return 'blocked'
    case 'paused':
      return 'paused'
    case 'complete':
      return 'complete'
    case 'cancelled':
      return 'cancelled'
    case 'active':
      return 'active'
  }
}

function buildGoalDockViewModel(artifact: ActiveContextArtifact): Nullable<GoalDockViewModel> {
  const status = getGoalLifecycleStatus(artifact)
  if (status !== 'active' && status !== 'paused' && status !== 'blocked') return null

  const primaryAction: GoalDockPrimaryAction = status === 'active' ? 'pause' : 'continue'
  return {
    id: artifact.id,
    objective: artifact.content,
    status,
    tone: getGoalDockTone(status),
    primaryAction,
    actions: [primaryAction, 'remove'],
    blockedAuditTurns: readGoalBlockedAuditTurns(artifact.metadata?.blockedAuditTurns),
    updatedAt: artifact.updatedAt,
  }
}

export {
  buildGoalDockViewModel,
  findCurrentGoalArtifact,
  getGoalLifecycleStatus,
  GoalArtifactId,
  goalLifecycleToUpsertInput,
  isGoalArtifact,
}
export type {
  GoalDockAction,
  GoalDockPrimaryAction,
  GoalDockTone,
  GoalDockViewModel,
  GoalLifecycleAction,
  GoalLifecycleStatus,
}
