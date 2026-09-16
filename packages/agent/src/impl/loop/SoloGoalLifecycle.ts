import type { ActiveContextArtifact, ActiveContextArtifactKind, ActiveContextArtifactStatus, ActiveContextUpsertInput } from '../../types/agent.js'
import type { SoloGoalFinishingState } from '../../types/loop.js'
import { assertGoalCanComplete, buildGoalTerminalUpsertInput, buildGoalUpsertInput, findCurrentGoalArtifact, toGoalSnapshot } from '../../utils/builtin/goals'
import { readSoloGoalBlockedAuditTurns, readSoloGoalStatus, toSoloGoalFinishingState } from '../../utils/loop/solo-goal-lifecycle'

/** goal 生命周期所需的最小 activeContext 端口（读全量 requirement + upsert 单条目标）。 */
interface SoloGoalLifecycleActiveContext {
  /**
   * 拉制品清单。本类固定用 `status: 'all'` + `kinds: ['requirement']` 全量拉一次再自己挑当前目标：
   * 终态目标也要看得见，否则新目标会被误判成「已有活动目标」。
   */
  listActiveContextArtifacts(options?: {
    /** 按状态过滤，`'all'` 表示连已完成/已归档的一起给。 */
    status?: ActiveContextArtifactStatus | 'all'
    /** 按种类过滤；目标是 `requirement` 这一类。 */
    kinds?: ActiveContextArtifactKind[]
  }): Promise<ActiveContextArtifact[]>
  /** 按 id 写回一条制品（没有就建），返回写入后的最新形态；目标的每次状态流转都走它。 */
  upsertActiveContextArtifact(input: ActiveContextUpsertInput): Promise<ActiveContextArtifact>
}

/**
 * 主 Agent 这次运行的目标状态机：建目标、读目标、记一次未达成、把目标封成终态。
 *
 * 谁建：`SoloStreamLoop.execute()` 开头建一个，整次运行共用；状态只有一格同轮缓存，权威数据在
 * activeContext 制品里。什么时候调：开启目标模式时先 `ensureExplicitGoal`；此后每轮收尾门调
 * `inspect()`，未终结再调 `recordCompletionAttempt()` 记一笔并继续跑；本轮出错或收尾门判 error 时调
 * `recordBlockedTerminal()` 封终态。
 * 失败语义：读写失败直接冒泡给调用轮（收尾门会把它当本轮错误收敛），本类不吞异常也不重试。
 */
export interface SoloGoalLifecycleApi {
  /**
   * 显式目标模式开场：已有仍在推进的目标就原样沿用（不覆盖），否则用这句 objective 起一轮新生命周期。
   * objective 去空白后为空且当前没有目标时，什么都不建，直接返回「缺席」状态。
   */
  ensureExplicitGoal(objective: string): Promise<SoloGoalFinishingState>
  /**
   * 显式提交目标完成：把当前活动目标封成 `complete`，成功返回 true；当前没有活动目标返回 false。
   * 还有步骤没完成也没跳过时抛错（`assertGoalCanComplete`）——收尾回复不走这条路。
   */
  recordSuccessfulCompletion(): Promise<boolean>
  /** 收尾门读一次目标状态（存不存在、是否终结、卡了几轮）；顺手缓存本轮解析出的目标供 record 复用。 */
  inspect(): Promise<SoloGoalFinishingState>
  /** 收尾门判「还没达成」时记一笔：`blockedAuditTurns` +1。复用同轮 inspect 的缓存，写完缓存作废。 */
  recordCompletionAttempt(): Promise<void>
  /** 终结路径：把仍活动的目标封成 `blocked`（本轮出错或收尾门判 error 时调）；已终结则是无操作。 */
  recordBlockedTerminal(): Promise<void>
}

/**
 * 单次取数复用：收尾门在同一轮里先 `inspect()` 再（未终结时）`recordCompletionAttempt()`，
 * 两步之间无任何写入，故 inspect 解析出的目标 artifact 被缓存供 record 直接复用，
 * 消除原先"一轮两次串行全量拉取"的重复 IO；写入后缓存失效。终结路径 `recordBlockedTerminal()`
 * 始终重新拉取最新（其上游可能刚发生过写入），避免读到写前快照。
 */
class SoloGoalLifecycle implements SoloGoalLifecycleApi {
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
   * 显式提交目标完成。每个步骤必须已有独立的完成或跳过记录；回复收尾不调用此方法。
   */
  public async recordSuccessfulCompletion(): Promise<boolean> {
    const goal = await this.fetchCurrentGoal()
    if (!goal || readSoloGoalStatus(goal) !== 'active') return false

    assertGoalCanComplete(toGoalSnapshot(goal))
    await this.activeContext.upsertActiveContextArtifact(
      buildGoalTerminalUpsertInput({ artifact: goal, status: 'complete', now: Date.now() })
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
export type { SoloGoalLifecycleActiveContext }
