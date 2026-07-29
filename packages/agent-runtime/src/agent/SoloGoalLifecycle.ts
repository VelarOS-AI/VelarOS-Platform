import { isTrue, toNullable } from '@velaros-ai/core'
import type {
  ActiveContextArtifact,
  ActiveContextArtifactKind,
  ActiveContextArtifactStatus,
  ActiveContextUpsertInput,
} from '@velaros-ai/core/types'

import type { SoloGoalFinishingState } from './SoloFinishingGate'

type SoloGoalLifecycleStatus =
  | 'active'
  | 'paused'
  | 'complete'
  | 'blocked'
  | 'cancelled'
  | 'removed'

/** goal 生命周期所需的最小 activeContext 端口（读全量 requirement + upsert 单条目标）。 */
interface SoloGoalLifecycleActiveContext {
  listActiveContextArtifacts(options?: {
    status?: ActiveContextArtifactStatus | 'all'
    kinds?: ActiveContextArtifactKind[]
  }): Promise<ActiveContextArtifact[]>
  upsertActiveContextArtifact(input: ActiveContextUpsertInput): Promise<ActiveContextArtifact>
}

function isSoloGoalArtifact(artifact: ActiveContextArtifact): boolean {
  return artifact.kind === 'requirement' && isTrue(artifact.metadata?.goal)
}

function readSoloGoalStatus(artifact: ActiveContextArtifact): SoloGoalLifecycleStatus {
  const status = artifact.metadata?.goalStatus
  if (
    status === 'complete' ||
    status === 'blocked' ||
    status === 'active' ||
    status === 'paused' ||
    status === 'cancelled' ||
    status === 'removed'
  )
    return status
  if (artifact.status === 'archived') return 'removed'
  return artifact.status === 'completed' ? 'complete' : 'active'
}

function readSoloGoalBlockedAuditTurns(artifact: ActiveContextArtifact): number {
  const turns = artifact.metadata?.blockedAuditTurns
  return Number.isFinite(turns) ? Math.max(0, Math.floor(Number(turns))) : 1
}

function findSoloCurrentGoalArtifact(
  artifacts: readonly ActiveContextArtifact[]
): Nullable<ActiveContextArtifact> {
  const goals = artifacts
    .filter(isSoloGoalArtifact)
    .filter((artifact) => artifact.status !== 'archived')
    .sort((left, right) => right.updatedAt - left.updatedAt)

  return toNullable(
    goals.find((artifact) => {
      const status = readSoloGoalStatus(artifact)
      return status === 'active' || status === 'paused'
    }) ?? goals[0]
  )
}

function toSoloGoalFinishingState(goal: Nullable<ActiveContextArtifact>): SoloGoalFinishingState {
  if (!goal)
    return {
      exists: false,
      terminal: false,
      status: 'missing',
    }

  const status = readSoloGoalStatus(goal)
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

/**
 * 主 Agent 目标（create_goal 建立的 requirement 制品）生命周期。
 *
 * 单次取数复用：收尾门在同一轮里先 `inspect()` 再（未终结时）`recordCompletionAttempt()`，
 * 两步之间无任何写入，故 inspect 解析出的目标 artifact 被缓存供 record 直接复用，
 * 消除原先"一轮两次串行全量拉取"的重复 IO；写入后缓存失效。终结路径 `recordBlockedTerminal()`
 * 始终重新拉取最新（其上游可能刚发生过写入），避免读到写前快照。
 */
class SoloGoalLifecycle {
  private cachedGoal: Nullable<ActiveContextArtifact> = null

  constructor(private readonly activeContext: SoloGoalLifecycleActiveContext) {}

  private async fetchCurrentGoal(): Promise<Nullable<ActiveContextArtifact>> {
    const artifacts = await this.activeContext.listActiveContextArtifacts({
      status: 'all',
      kinds: ['requirement'],
    })
    return findSoloCurrentGoalArtifact(artifacts)
  }

  /** 收尾门读取目标状态；缓存本次解析出的目标 artifact 供同轮 record 复用。 */
  public async inspect(): Promise<SoloGoalFinishingState> {
    const goal = await this.fetchCurrentGoal()
    this.cachedGoal = goal
    return toSoloGoalFinishingState(goal)
  }

  /** 收尾门未终结时记一次完成尝试（blockedAuditTurns +1）；复用同轮 inspect 缓存，不重复拉取。 */
  public async recordCompletionAttempt(): Promise<void> {
    const goal = this.cachedGoal ?? (await this.fetchCurrentGoal())
    if (!goal || readSoloGoalStatus(goal) !== 'active') return

    await this.activeContext.upsertActiveContextArtifact({
      id: goal.id,
      kind: 'requirement',
      scope: goal.scope,
      status: 'active',
      resourceId: goal.resourceId,
      title: goal.title,
      content: goal.content,
      sourceMessageId: goal.sourceMessageId,
      metadata: {
        ...(goal.metadata ?? {}),
        goal: true,
        goalStatus: 'active',
        blockedAuditTurns: readSoloGoalBlockedAuditTurns(goal) + 1,
      },
    })
    // 写入后缓存失效，避免后续读到陈旧计数。
    this.cachedGoal = null
  }

  /** 终结路径：把仍处于 active 的目标标记为 blocked（始终拉取最新，不用缓存）。 */
  public async recordBlockedTerminal(): Promise<void> {
    const goal = await this.fetchCurrentGoal()
    if (!goal || readSoloGoalStatus(goal) !== 'active') return

    await this.activeContext.upsertActiveContextArtifact({
      id: goal.id,
      kind: 'requirement',
      scope: goal.scope,
      status: 'completed',
      resourceId: goal.resourceId,
      title: goal.title,
      content: goal.content,
      sourceMessageId: goal.sourceMessageId,
      metadata: {
        ...(goal.metadata ?? {}),
        goal: true,
        goalStatus: 'blocked',
        blockedAuditTurns: Math.max(3, readSoloGoalBlockedAuditTurns(goal)),
        terminalAt: Date.now(),
        blockedAt: Date.now(),
      },
    })
    this.cachedGoal = null
  }
}

export { SoloGoalLifecycle }
export type { SoloGoalLifecycleActiveContext, SoloGoalLifecycleStatus }
