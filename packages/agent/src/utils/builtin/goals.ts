import { isArray, isEmpty,isFiniteNumber, isObject, isString, isTrue, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { ActiveContextArtifact, ActiveContextUpsertInput } from '../../types/agent.js'
import type { GoalConstraint, GoalMetadata, GoalSnapshot, GoalStatus, GoalStep, GoalStepCompletionResult,StepEngineOptions } from '../../types/builtin.js'

import { completeSteps } from './step-refs'

const GoalArtifactId = 'active-goal'

/**
 * 判断一条活动上下文产物是不是「目标」：`kind === 'requirement'` **且** `metadata.goal === true`。
 * 目标复用 requirement 这一类产物，靠 metadata 上这面旗子跟普通 requirement 区分开。
 */
function isGoalArtifact(artifact: ActiveContextArtifact): boolean {
  return artifact.kind === 'requirement' && isTrue(artifact.metadata?.goal)
}

const GoalStatusValues = [
  'active',
  'paused',
  'complete',
  'blocked',
  'cancelled',
  'removed',
] as const satisfies readonly GoalStatus[]
const GoalStatusSet = new Set<unknown>(GoalStatusValues)

/** metadata 里的目标状态优先；缺席/坏值时从 artifact 生命周期回落（归档→removed）。 */
function normalizeGoalStatus(value: unknown, artifactStatus: ActiveContextArtifact['status']): GoalStatus {
  if (GoalStatusSet.has(value)) return value as GoalStatus
  if (artifactStatus === 'archived') return 'removed'
  return artifactStatus === 'completed' ? 'complete' : 'active'
}

/** 缺席回落 1 而不是 0：第一次进入受阻审计的那一轮本身就该计数。 */
function readBlockedAuditTurns(value: unknown): number {
  return isFiniteNumber(value) ? Math.max(0, Math.floor(value)) : 1
}

/**
 * 判断一个来路不明的值是否是合法目标步骤：必须是对象、`step` 是字符串、
 * `status` 在 pending/in_progress/completed/failed/skipped 五种之内。
 * metadata 是自由 JSON，读回来时得逐条验形，坏条目由调用方直接滤掉而不是让整个目标读失败。
 */
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

/**
 * 判断一个值是否是合法目标约束：必须是对象、`title` 与 `content` 都是字符串、
 * `directiveType` 在 prohibition/preference/process/requirement/other 之内。同样用于读回时逐条验形。
 */
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

/**
 * 从 metadata 里读目标步骤数组：非数组返回空数组，是数组则**逐条过滤掉不合形状的项**。
 * 坏条目静默丢弃而不是抛错——目标 artifact 一旦读不出来，整条会话就失去目标状态，
 * 丢几条坏步骤远好过整个目标不可用。
 */
function readGoalSteps(value: unknown): GoalStep[] {
  return isArray(value) ? value.filter(isGoalStep) : []
}

/** 从 metadata 里读目标约束数组：非数组返回空数组，是数组则逐条过滤掉不合形状的项（同步骤的取舍）。 */
function readGoalConstraints(value: unknown): GoalConstraint[] {
  return isArray(value) ? value.filter(isGoalConstraint) : []
}

/**
 * 把一条 artifact 读成结构化的目标快照：`content` 即 objective；状态由 `normalizeGoalStatus`
 * 在 metadata 与 artifact 生命周期之间定夺；步骤与约束逐条验形后过滤。
 * 两个数值字段都取整并夹下界，坏值或缺席一律为 null 而不是 0——`tokenBudget` 夹到至少 1
 * （0 预算等于目标一开始就爆了），`terminalAt` 夹到至少 0。本函数只读不写，任何坏 metadata 都不抛错。
 */
function toGoalSnapshot(artifact: ActiveContextArtifact): GoalSnapshot {
  const metadata = artifact.metadata ?? {}
  const tokenBudget = isFiniteNumber(metadata.tokenBudget)
    ? Math.max(1, Math.floor(metadata.tokenBudget))
    : null
  const terminalAt = isFiniteNumber(metadata.terminalAt)
    ? Math.max(0, Math.floor(metadata.terminalAt))
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

/**
 * 从一堆活动上下文产物里挑出「当前目标」：先筛出目标类且未归档的，按 `updatedAt` 从新到旧排，
 * 优先返回第一条 `active` 或 `paused` 的；一条都没有就退回最近更新的那条目标（终态目标也认，
 * 这样刚 complete 的目标还能被读到并展示），全无则返回 null。
 */
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

/**
 * 拼「新建目标」的 upsert 入参：id 固定为 `active-goal`（同一会话只有一个当前目标，重复建即覆盖），
 * kind `requirement`、scope `session`、status `active`，标题固定「当前目标」，objective 写进 content。
 * metadata 打上 `goal: true` 旗子、状态 `active`、`blockedAuditTurns` 起于 1
 * （第一次进入受阻审计的那一轮本身就该计数），步骤与约束缺省为空数组。
 */
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

/**
 * 拼「改目标内容」的 upsert 入参（改描述 / 步骤 / 约束）：objective、steps、constraints 三项
 * 缺席就沿用原值（objective 还要 trim 后非空才算给了），其余 artifact 字段原样带回。
 * 关键取舍：**改内容不等于恢复执行**——原状态是 `paused` 就保持 paused，只有非暂停态才写 active；
 * 生命周期迁移只能走 `buildGoalLifecycleUpsertInput`。`blockedAuditTurns` 也原样沿用不重置。
 */
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
      // 修改暂停目标的描述/步骤/约束不等于恢复执行；生命周期只能由显式 status 迁移。
      goalStatus: previous.status === 'paused' ? 'paused' : 'active',
      blockedAuditTurns: previous.blockedAuditTurns,
      steps: input.steps ?? previous.steps,
      constraints: input.constraints ?? previous.constraints,
    },
  }
}

/**
 * 目标侧步骤引擎参数：失败步骤不计入已解决，由 `assertGoalCanComplete` 阻止目标收尾；
 * 没有进行中步骤时，可回退并晋升任意位置的第一个待办步骤。
 * 匹配器与计划共享规则：统一为 `NFKC`、归一化全角冒号、支持唯一子串命中，因而比旧目标匹配器宽容。
 */
const GoalStepEngineOptions: StepEngineOptions = {
  kindLabel: 'goal',
  listLabel: '当前目标步骤',
  emptyMessage: 'Active goal has no steps to complete.',
  resolvedStatuses: ['completed', 'skipped'],
  promoteFallbackAnywhere: true,
}

/**
 * 按 goal 语义收尾一个目标步骤：走共用步骤引擎，配 `GoalStepEngineOptions`——
 * 只有 completed / skipped 算「已解决」（**failed 不算**，好让 `assertGoalCanComplete` 拦住整体收尾），
 * 且没有进行中步骤时允许**回头晋升全表第一个 pending**（目标步骤不像计划那样有严格先后）。
 * 返回新步骤数组、被收尾的步骤、被晋升的步骤与是否全部解决；引用匹配不上会抛带可引用清单的错误。
 */
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

/**
 * 判断一个目标步骤是否已解决：只有 `completed` 与 `skipped` 为真。
 * `failed` **刻意不算**——失败步骤要么改状态要么显式跳过，不能让目标带着失败步骤悄悄收尾。
 */
function isResolvedGoalStep(step: GoalStep): boolean {
  return step.status === 'completed' || step.status === 'skipped'
}

/**
 * 拼「目标生命周期迁移」的 upsert 入参，按目标状态分别写时间戳：
 * `active` 清掉 terminalAt/pausedAt 并记 resumedAt；`paused` 清 terminalAt 并记 pausedAt；
 * `blocked` / `cancelled` 记 terminalAt 外再各记一个 blockedAt / cancelledAt；`complete` 只记 terminalAt。
 * 三种终态（complete/blocked/cancelled）把 artifact 的 status 落成 `completed`，其余落 `active`。
 * 目标内容与 `blockedAuditTurns` 原样保留，本函数只动状态与时间戳。`removed` 不走这里。
 */
function buildGoalLifecycleUpsertInput(input: {
  artifact: ActiveContextArtifact
  status: Exclude<GoalStatus, 'removed'>
  now: number
}): ActiveContextUpsertInput {
  const previous = toGoalSnapshot(input.artifact)
  const terminal =
    input.status === 'complete' || input.status === 'blocked' || input.status === 'cancelled'
  const transitionMetadata =
    input.status === 'active'
      ? { terminalAt: null, pausedAt: null, resumedAt: input.now }
      : input.status === 'paused'
        ? { terminalAt: null, pausedAt: input.now }
        : input.status === 'blocked'
          ? { terminalAt: input.now, blockedAt: input.now }
          : input.status === 'cancelled'
            ? { terminalAt: input.now, cancelledAt: input.now }
            : { terminalAt: input.now }
  return {
    id: input.artifact.id,
    kind: 'requirement',
    scope: input.artifact.scope,
    status: terminal ? 'completed' : 'active',
    resourceId: input.artifact.resourceId,
    title: input.artifact.title,
    content: input.artifact.content,
    sourceMessageId: input.artifact.sourceMessageId,
    metadata: {
      ...(input.artifact.metadata ?? {}),
      goal: true,
      goalStatus: input.status,
      blockedAuditTurns: previous.blockedAuditTurns,
      ...transitionMetadata,
    },
  }
}

/**
 * 拼目标进入**终态**（complete / blocked / cancelled）的 upsert 入参。
 * 实现上直接转交 `buildGoalLifecycleUpsertInput`，存在的意义是把入参状态收窄到三种终态，
 * 让收尾路径在类型上就传不进 active/paused。
 */
function buildGoalTerminalUpsertInput(input: {
  artifact: ActiveContextArtifact
  status: 'complete' | 'blocked' | 'cancelled'
  now: number
}): ActiveContextUpsertInput {
  return buildGoalLifecycleUpsertInput(input)
}

/**
 * 目标收尾前的闸门：还有未解决步骤（非 completed / skipped，含 failed 与 pending）就抛 `VALIDATION`，
 * 错误里**最多列前 4 条**未解决步骤的 `<id 或标题>: <状态>` 并给出三条出路
 * （complete_step / 跳过 / 先更新失败步骤）。只列 4 条是为了把错误压在模型一眼能读完的长度内。
 * 步骤全解决或压根没有步骤时静默通过。
 */
function assertGoalCanComplete(goal: GoalSnapshot): void {
  const unresolvedSteps = goal.steps.filter((step) => !isResolvedGoalStep(step))
  if (isEmpty(unresolvedSteps)) return

  const labels = unresolvedSteps
    .slice(0, 4)
    .map((step) => `${step.id || step.step}: ${step.status}`)
    .join(', ')
  throw new AppError(
    'VALIDATION',
    `还有未解决的目标步骤，不能收尾这个目标。请先用 complete_step 完成、跳过，或更新失败的步骤：${labels}。`
  )
}

export {
  assertGoalCanComplete,
  buildGoalLifecycleUpsertInput,
  buildGoalStateUpsertInput,
  buildGoalTerminalUpsertInput,
  buildGoalUpsertInput,
  completeGoalStep,
  findCurrentGoalArtifact,
  GoalArtifactId,
  isGoalArtifact,
  toGoalSnapshot,
}
