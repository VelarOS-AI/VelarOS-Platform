import { isArray, isEmpty,isObject, isString, isTrue, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type {
  ActiveContextArtifact,
  ActiveContextUpsertInput,
} from '@velaros-ai/core/types'

import type { ActiveDirectiveType } from './ActiveDirectives'
import type { UserPlanStatus } from './Plans'
import type { StepEngineOptions } from './StepRefs'
import { completeSteps } from './StepRefs'

const GoalArtifactId = 'active-goal'
const MinBlockedAuditTurns = 3

type GoalStatus = 'active' | 'paused' | 'complete' | 'blocked' | 'cancelled' | 'removed'

interface GoalStep {
  id?: string
  step: string
  objective?: string
  status: UserPlanStatus
}

interface GoalConstraint {
  id?: string
  title: string
  content: string
  directiveType: ActiveDirectiveType
  sourceMessageId?: string
}

interface GoalMetadata extends Record<string, unknown> {
  goal: true
  goalStatus: GoalStatus
  tokenBudget?: number
  blockedAuditTurns: number
  createdAt: number
  terminalAt?: number
  steps?: GoalStep[]
  constraints?: GoalConstraint[]
}

interface GoalSnapshot {
  id: string
  objective: string
  status: GoalStatus
  steps: GoalStep[]
  constraints: GoalConstraint[]
  tokenBudget: Nullable<number>
  blockedAuditTurns: number
  createdAt: number
  updatedAt: number
  terminalAt: Nullable<number>
}

interface GoalStepCompletionResult {
  steps: GoalStep[]
  completedStep: GoalStep
  promotedStep: Nullable<GoalStep>
  allStepsResolved: boolean
}
function isGoalArtifact(artifact: ActiveContextArtifact): boolean {
  return artifact.kind === 'requirement' && isTrue(artifact.metadata?.goal)
}

function normalizeGoalStatus(value: unknown, artifactStatus: ActiveContextArtifact['status']): GoalStatus {
  if (
    value === 'complete' ||
    value === 'blocked' ||
    value === 'active' ||
    value === 'paused' ||
    value === 'cancelled' ||
    value === 'removed'
  ) return value
  if (artifactStatus === 'archived') return 'removed'
  return artifactStatus === 'completed' ? 'complete' : 'active'
}

function readBlockedAuditTurns(value: unknown): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(Number(value))) : 1
}

function isGoalStep(value: unknown): value is GoalStep {
  if (!isObject(value)) return false
  const candidate = value as Partial<GoalStep>
  return (
    isString(candidate.step) &&
    ['pending', 'in_progress', 'completed', 'failed', 'skipped'].includes(
      String(candidate.status)
    )
  )
}

function isGoalConstraint(value: unknown): value is GoalConstraint {
  if (!isObject(value)) return false
  const candidate = value as Partial<GoalConstraint>
  return (
    isString(candidate.title) &&
    isString(candidate.content) &&
    ['prohibition', 'preference', 'process', 'requirement', 'other'].includes(
      String(candidate.directiveType)
    )
  )
}

function readGoalSteps(value: unknown): GoalStep[] {
  return isArray(value) ? value.filter(isGoalStep) : []
}

function readGoalConstraints(value: unknown): GoalConstraint[] {
  return isArray(value) ? value.filter(isGoalConstraint) : []
}

function toGoalSnapshot(artifact: ActiveContextArtifact): GoalSnapshot {
  const metadata = artifact.metadata ?? {}
  const tokenBudget = Number.isFinite(metadata.tokenBudget)
    ? Math.max(1, Math.floor(Number(metadata.tokenBudget)))
    : null
  const terminalAt = Number.isFinite(metadata.terminalAt)
    ? Math.max(0, Math.floor(Number(metadata.terminalAt)))
    : null

  return {
    id: artifact.id,
    objective: artifact.content,
    status: normalizeGoalStatus(metadata.goalStatus, artifact.status),
    steps: readGoalSteps(metadata.steps),
    constraints: readGoalConstraints(metadata.constraints),
    tokenBudget,
    blockedAuditTurns: readBlockedAuditTurns(metadata.blockedAuditTurns),
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
    terminalAt,
  }
}

function findCurrentGoalArtifact(
  artifacts: readonly ActiveContextArtifact[]
): Nullable<ActiveContextArtifact> {
  const goals = artifacts
    .filter(isGoalArtifact)
    .filter((artifact) => artifact.status !== 'archived')
    .sort((left, right) => right.updatedAt - left.updatedAt)

  return toNullable(
    goals.find((artifact) => {
      const status = toGoalSnapshot(artifact).status
      return status === 'active' || status === 'paused'
    }) ?? goals[0]
  )
}

function buildGoalUpsertInput(input: {
  objective: string
  tokenBudget?: number
  steps?: GoalStep[]
  constraints?: GoalConstraint[]
  now: number
}): ActiveContextUpsertInput {
  const metadata: GoalMetadata = {
    goal: true,
    goalStatus: 'active',
    tokenBudget: input.tokenBudget,
    blockedAuditTurns: 1,
    createdAt: input.now,
    steps: input.steps ?? [],
    constraints: input.constraints ?? [],
  }

  return {
    id: GoalArtifactId,
    kind: 'requirement',
    scope: 'session',
    status: 'active',
    title: '当前目标',
    content: input.objective,
    metadata,
  }
}

function buildGoalStateUpsertInput(input: {
  artifact: ActiveContextArtifact
  objective?: string
  steps?: GoalStep[]
  constraints?: GoalConstraint[]
}): ActiveContextUpsertInput {
  const previous = toGoalSnapshot(input.artifact)
  return {
    id: input.artifact.id,
    kind: 'requirement',
    scope: input.artifact.scope,
    status: 'active',
    resourceId: input.artifact.resourceId,
    title: input.artifact.title,
    content: input.objective?.trim() || input.artifact.content,
    sourceMessageId: input.artifact.sourceMessageId,
    metadata: {
      ...(input.artifact.metadata ?? {}),
      goal: true,
      goalStatus: 'active',
      blockedAuditTurns: previous.blockedAuditTurns,
      steps: input.steps ?? previous.steps,
      constraints: input.constraints ?? previous.constraints,
    },
  }
}

/**
 * goal 侧步骤引擎参数:failed 不计入已解决(failed 步骤挡目标收尾,由 assertGoalCanComplete 把关);
 * 无 in_progress 时晋升可回退到任意位置的第一个 pending。
 * 匹配器与 plan 共享(NFKC/全角冒号归一/唯一子串命中,比旧 goal 匹配器更宽容)。
 */
const GoalStepEngineOptions: StepEngineOptions = {
  kindLabel: 'goal',
  listLabel: '当前目标步骤',
  emptyMessage: 'Active goal has no steps to complete.',
  resolvedStatuses: ['completed', 'skipped'],
  promoteFallbackAnywhere: true,
}

function completeGoalStep(
  steps: readonly GoalStep[],
  stepRef: string | number
): GoalStepCompletionResult {
  const completion = completeSteps(steps, stepRef, GoalStepEngineOptions)
  return {
    steps: completion.steps,
    completedStep: completion.completedStep,
    promotedStep: completion.promotedStep,
    allStepsResolved: completion.allStepsResolved,
  }
}

function isResolvedGoalStep(step: GoalStep): boolean {
  return step.status === 'completed' || step.status === 'skipped'
}

function buildGoalTerminalUpsertInput(input: {
  artifact: ActiveContextArtifact
  status: Exclude<GoalStatus, 'active'>
  now: number
}): ActiveContextUpsertInput {
  const previous = toGoalSnapshot(input.artifact)
  return {
    id: input.artifact.id,
    kind: 'requirement',
    scope: input.artifact.scope,
    status: 'completed',
    resourceId: input.artifact.resourceId,
    title: input.artifact.title,
    content: input.artifact.content,
    sourceMessageId: input.artifact.sourceMessageId,
    metadata: {
      ...(input.artifact.metadata ?? {}),
      goal: true,
      goalStatus: input.status,
      blockedAuditTurns: previous.blockedAuditTurns,
      terminalAt: input.now,
    },
  }
}

function buildGoalCompletionAttemptUpsertInput(
  artifact: ActiveContextArtifact
): ActiveContextUpsertInput {
  const previous = toGoalSnapshot(artifact)
  return {
    id: artifact.id,
    kind: 'requirement',
    scope: artifact.scope,
    status: 'active',
    resourceId: artifact.resourceId,
    title: artifact.title,
    content: artifact.content,
    sourceMessageId: artifact.sourceMessageId,
    metadata: {
      ...(artifact.metadata ?? {}),
      goal: true,
      goalStatus: 'active',
      blockedAuditTurns: previous.blockedAuditTurns + 1,
    },
  }
}

function assertCanBlockGoal(goal: GoalSnapshot): void {
  if (goal.blockedAuditTurns >= MinBlockedAuditTurns) return

  throw new AppError(
    'VALIDATION',
    `Blocked audit requires at least ${MinBlockedAuditTurns} consecutive goal turns before marking blocked. Current audit count: ${goal.blockedAuditTurns}.`
  )
}

function assertGoalCanComplete(goal: GoalSnapshot): void {
  const unresolvedSteps = goal.steps.filter((step) => !isResolvedGoalStep(step))
  if (isEmpty(unresolvedSteps)) return

  const labels = unresolvedSteps
    .slice(0, 4)
    .map((step) => `${step.id || step.step}: ${step.status}`)
    .join(', ')
  throw new AppError(
    'VALIDATION',
    `Cannot complete goal with unresolved goal steps. Use complete_step, skip, or update failed steps first: ${labels}.`
  )
}

export {
  assertCanBlockGoal,
  assertGoalCanComplete,
  buildGoalCompletionAttemptUpsertInput,
  buildGoalStateUpsertInput,
  buildGoalTerminalUpsertInput,
  buildGoalUpsertInput,
  completeGoalStep,
  findCurrentGoalArtifact,
  GoalArtifactId,
  isGoalArtifact,
  MinBlockedAuditTurns,
  toGoalSnapshot,
}
export type {
  GoalConstraint,
  GoalSnapshot,
  GoalStatus,
  GoalStep,
}
