import { isFiniteNumber, isString, isTrue } from '@velaros-ai/core'
import { toNullable } from '@velaros-ai/core/utils/nullish'

import type { ActiveContextArtifact, ActiveContextUpsertInput } from '../../types/agent.js'
import type { GoalDockPrimaryAction, GoalDockTone, GoalDockViewModel,GoalLifecycleAction, GoalLifecycleStatus } from '../../types/runner.js'


const GoalArtifactId = 'active-goal'

/**
 * 认出「目标」这类活动上下文制品：`kind === 'requirement'` 且 metadata 上打了 `goal: true` 标记。
 * 光看 kind 不够——需求类制品不止目标一种，必须靠这个标记把目标挑出来。
 */
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

/**
 * 判断任意值是不是合法的目标生命周期状态（是字符串且在上面那张闭集表里），兼作类型收窄。
 * metadata 来自持久化数据，可能是旧版本写的或被手改过，所以进来一律先过这道校验。
 */
function isGoalLifecycleStatus(value: unknown): value is GoalLifecycleStatus {
  return isString(value) && GoalLifecycleStatusSet.has(value)
}

/**
 * 把 metadata 里记的生命周期状态归一成合法值；它本身合法就直接用。
 * 不合法（旧数据没写、或写了个不认识的值）时按制品自身的 status 反推：archived → `removed`、
 * completed → `complete`、其余 → `active`。这条回落保证老会话里的目标不会因为缺字段而消失。
 */
function normalizeGoalLifecycleStatus(
  value: unknown,
  artifactStatus: ActiveContextArtifact['status']
): GoalLifecycleStatus {
  if (isGoalLifecycleStatus(value)) return value
  if (artifactStatus === 'archived') return 'removed'

  return artifactStatus === 'completed' ? 'complete' : 'active'
}

/**
 * 读「目标受阻后每隔多少轮复核一次」的计数：有限数字才采信，向下取整并夹到 ≥ 0；
 * 缺席或不是数字时取 1（每轮都复核）。取 1 而不是 0 是因为 0 会退化成"从不复核"，
 * 受阻的目标就此静悄悄躺死。
 */
function readGoalBlockedAuditTurns(value: unknown): number {
  return isFiniteNumber(value) ? Math.max(0, Math.floor(value)) : 1
}

/** 读一个目标制品当前的生命周期状态（metadata.goalStatus 过一遍归一，脏值与缺席都有回落）。 */
function getGoalLifecycleStatus(artifact: ActiveContextArtifact): GoalLifecycleStatus {
  return normalizeGoalLifecycleStatus(artifact.metadata?.goalStatus, artifact.status)
}

/**
 * 这个状态算不算"还在手上的目标"：只有 `active` 与 `paused` 为真。
 * paused 也算——暂停的目标随时可以继续，它仍占着"当前目标"这个位置；
 * blocked/complete/cancelled/removed 都已到终态，不再是当前目标。
 */
function isCurrentGoalStatus(status: GoalLifecycleStatus): boolean {
  return status === 'active' || status === 'paused'
}

/**
 * 从一堆活动上下文制品里挑出"当前目标"：先滤出未归档的目标制品并按 updatedAt 倒序，
 * 优先取最近一个仍处于 active/paused 的；一个都没有时退而取最近更新的那个（哪怕已到终态），
 * 好让界面还能显示"上一个目标是什么"。完全没有目标制品时返回 null。
 */
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

/**
 * 算出执行某个生命周期动作之后，目标制品该写回的完整 metadata（在原 metadata 上叠加，不丢未知字段）。
 *
 * 每个动作各自定 goalStatus 与时间戳：resume/pause 会把 `terminalAt` 显式清成 null（从终态回到在途，
 * 残留的终止时刻会让后续判定出错），block/complete/cancel/remove 则把 `terminalAt` 打上 `now`，
 * 并各自再记一个专属时刻（blockedAt / cancelledAt / removedAt）。`blockedAuditTurns` 每次都重新归一后带上，
 * 避免脏值一直传下去。
 */
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

/**
 * 把目标动作映射到制品自身的 status：resume/pause → `active`（暂停的目标仍在列表里，不归档），
 * remove → `archived`（从列表里消失），block/complete/cancel → `completed`。
 * 注意 block 与 cancel 也落 `completed`：制品层只区分"还在/已了结/已归档"三态，
 * "因何了结"由 metadata.goalStatus 记。
 */
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

/**
 * 把「对某个目标执行某个动作」翻译成一条活动上下文 upsert 入参：id/scope/标题/正文/来源消息原样保留，
 * 只改 status 与 metadata。`now` 可注入（默认 `Date.now()`），便于测试定死时间戳。
 */
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

/**
 * 生命周期状态 → 目标停靠条的视觉色调。除了 `removed` 与 `blocked` 同归 `blocked` 色调外一一对应；
 * 这里写成穷举 switch 而非查表，往 GoalLifecycleStatus 加一档却忘了配色调会直接编译红。
 */
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

/**
 * 把目标制品投影成停靠条视图模型；**只有 active / paused / blocked 才出条**，
 * 已完成、已取消、已移除的返回 null（了结的目标不该继续占着界面）。
 * 主按钮按状态定：active 给「暂停」，paused/blocked 给「继续」；次要动作固定是「移除」。
 */
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
