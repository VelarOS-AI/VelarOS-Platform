import type {
  ActiveContextArtifact,
  ActiveContextArtifactKind,
  ActiveContextArtifactStatus,
  ActiveContextUpsertInput,
} from '@velaros-ai/agent/protocol'

import {
  assertGoalCanComplete,
  buildGoalStateUpsertInput,
  buildGoalTerminalUpsertInput,
  buildGoalUpsertInput,
  findCurrentGoalArtifact,
  type GoalStatus,
  toGoalSnapshot,
} from '../tool-library/builtin/Goals'

import type { SoloGoalFinishingState } from './SoloFinishingGate'

type SoloGoalLifecycleStatus = GoalStatus

/** goal 生命周期所需的最小 activeContext 端口（读全量 requirement + upsert 单条目标）。 */
interface SoloGoalLifecycleActiveContext {
  listActiveContextArtifacts(options?: {
    status?: ActiveContextArtifactStatus | 'all'
    kinds?: ActiveContextArtifactKind[]
  }): Promise<ActiveContextArtifact[]>
  upsertActiveContextArtifact(input: ActiveContextUpsertInput): Promise<ActiveContextArtifact>
}

function readSoloGoalStatus(artifact: ActiveContextArtifact): SoloGoalLifecycleStatus {
  return toGoalSnapshot(artifact).status
}

function readSoloGoalBlockedAuditTurns(artifact: ActiveContextArtifact): number {
  return toGoalSnapshot(artifact).blockedAuditTurns
}

function toSoloGoalFinishingState(goal: Nullable<ActiveContextArtifact>): SoloGoalFinishingState {
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
    canComplete: status === 'active' && !snapshot.steps.some((step) => step.status === 'failed'),
    objective: goal.content,
    blockedAuditTurns: readSoloGoalBlockedAuditTurns(goal),
  }
}

/**
 * 主 Agent 目标（goal:create 建立的 requirement 制品）生命周期。
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
    return findCurrentGoalArtifact(artifacts)
  }

  /**
   * 显式目标模式由运行控制面在首轮模型请求前建目标。
   *
   * 活动目标代表同一 session 中仍在推进的工作，保留它；已暂停或进入终态的旧目标不应
   * 吞掉新的显式用户目标，因此用统一 goal id 开启一轮新的生命周期。
   */
  public async ensureExplicitGoal(objective: string): Promise<SoloGoalFinishingState> {
    const normalizedObjective = objective.trim()
    const current = await this.fetchCurrentGoal()
    if (current && readSoloGoalStatus(current) === 'active') {
      this.cachedGoal = current
      return toSoloGoalFinishingState(current)
    }

    if (!normalizedObjective) return toSoloGoalFinishingState(current)

    const created = await this.activeContext.upsertActiveContextArtifact(
      buildGoalUpsertInput({ objective: normalizedObjective, now: Date.now() })
    )
    this.cachedGoal = null
    return toSoloGoalFinishingState(created)
  }

  /**
   * 模型正常收尾且其它验证门均已通过时，由控制面收束显式目标。
   * pending/in_progress 步骤随成功收尾一并完成；failed 步骤仍阻止自动终结，留给模型真实处理。
   */
  public async recordSuccessfulCompletion(): Promise<boolean> {
    const goal = await this.fetchCurrentGoal()
    if (!goal || readSoloGoalStatus(goal) !== 'active') return false

    const snapshot = toGoalSnapshot(goal)
    const steps = snapshot.steps.map((step) =>
      step.status === 'pending' || step.status === 'in_progress'
        ? { ...step, status: 'completed' as const }
        : step
    )
    if (steps.some((step) => step.status === 'failed')) return false

    const stateArtifact = steps.some((step, index) => step.status !== snapshot.steps[index]?.status)
      ? await this.activeContext.upsertActiveContextArtifact(
          buildGoalStateUpsertInput({ artifact: goal, steps })
        )
      : goal
    assertGoalCanComplete(toGoalSnapshot(stateArtifact))
    await this.activeContext.upsertActiveContextArtifact(
      buildGoalTerminalUpsertInput({ artifact: stateArtifact, status: 'complete', now: Date.now() })
    )
    this.cachedGoal = null
    return true
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
