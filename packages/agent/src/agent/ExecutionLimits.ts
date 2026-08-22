import { isNull, isUndefined } from '@velaros-ai/core'
// 域：Agent 执行的**收尾闸门**（什么时候必须停下来）。
//
// ## 为什么轮数上限默认是 null（不是漏配）
// 轮数是**代价的坏代理**：一轮可能是一次三秒的读文件，也可能是一次十分钟的构建。按轮数砍会
// 在长任务的正常推进中途腰斩，而对空转循环又砍得太晚。真正的兜底是**墙钟**与**模型流判死**：
//  - 空转（模型不再产出）由 `modelStreamIdleTimeoutMs`（5 分钟）在秒级判死；
//  - 失控（一直有产出但不收敛）由墙钟硬上限兜住；
//  - 子 agent 另有软期限，到点后进入收尾而非硬杀（半成品副作用比超时更贵）。
// 产品形态是过夜马拉松任务，因此墙钟给到 standard 24h / goal 7d——**这是有意的**，
// 谁要收紧必须先回答「怎么区分长任务与失控」，光把数字调小只会腰斩正常任务。
//
// ## 改这些会破什么
//  - 把 `primaryMaxTurns` 设成有限值：长任务在无预警处停止，且停止点与任务语义无关。
//  - 把 `modelStreamIdleTimeoutMs` 调大：真正的挂死要更久才暴露（这是唯一的"没反应"闸）。
//  - 把墙钟调小：goal 模式的多日任务失去存在意义。
// 所有值都可经 `overrides` 由宿主注入；默认值只定义未配置时的保守行为。
const MaxNativeTimerDelayMs = 2_147_483_647

interface AgentExecutionLimits {
  /** 普通主 Agent 单次执行的墙钟硬上限。 */
  standardExecutionWallClockTimeoutMs: number
  /** Goal 模式或已建立活动目标的主 Agent 墙钟硬上限。 */
  goalExecutionWallClockTimeoutMs: number
  /** 主 Agent 轮次上限；null 表示不按轮次收尾。 */
  primaryMaxTurns: Nullable<number>
  /** 单个子 Agent 到点后的软收尾时间。 */
  subAgentSoftDeadlineMs: number
  /** 子 Agent 轮次上限；null 表示不按轮次收尾。 */
  subAgentMaxTurns: Nullable<number>
  /** 单次模型流连续没有任何新数据时的判死时间。 */
  modelStreamIdleTimeoutMs: number
}

type AgentExecutionLimitOverrides = Partial<AgentExecutionLimits>

const DefaultAgentExecutionLimits = Object.freeze({
  standardExecutionWallClockTimeoutMs: 24 * 60 * 60_000,
  goalExecutionWallClockTimeoutMs: 7 * 24 * 60 * 60_000,
  primaryMaxTurns: null,
  subAgentSoftDeadlineMs: 4 * 60 * 60_000,
  subAgentMaxTurns: null,
  modelStreamIdleTimeoutMs: 5 * 60_000,
}) satisfies Readonly<AgentExecutionLimits>

function assertPositiveTimerDelay(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MaxNativeTimerDelayMs) {
    throw new RangeError(`${field} 必须是正安全整数，且不大于 ${MaxNativeTimerDelayMs}。`)
  }
  return value
}

function assertOptionalMaxTurns(value: Nullable<number>, field: string): Nullable<number> {
  if (isNull(value)) return null
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} 必须为 null 或正安全整数。`)
  }
  return value
}

function resolveAgentExecutionLimits(
  overrides: AgentExecutionLimitOverrides = {}
): AgentExecutionLimits {
  const primaryMaxTurns = isUndefined(overrides.primaryMaxTurns)
    ? DefaultAgentExecutionLimits.primaryMaxTurns
    : overrides.primaryMaxTurns
  const subAgentMaxTurns = isUndefined(overrides.subAgentMaxTurns)
    ? DefaultAgentExecutionLimits.subAgentMaxTurns
    : overrides.subAgentMaxTurns
  const standardExecutionWallClockTimeoutMs = assertPositiveTimerDelay(
    overrides.standardExecutionWallClockTimeoutMs ??
      DefaultAgentExecutionLimits.standardExecutionWallClockTimeoutMs,
    'standardExecutionWallClockTimeoutMs'
  )
  const goalExecutionWallClockTimeoutMs = assertPositiveTimerDelay(
    overrides.goalExecutionWallClockTimeoutMs ??
      DefaultAgentExecutionLimits.goalExecutionWallClockTimeoutMs,
    'goalExecutionWallClockTimeoutMs'
  )
  if (goalExecutionWallClockTimeoutMs < standardExecutionWallClockTimeoutMs) {
    throw new RangeError(
      'goalExecutionWallClockTimeoutMs 不得小于 standardExecutionWallClockTimeoutMs。'
    )
  }
  return {
    standardExecutionWallClockTimeoutMs,
    goalExecutionWallClockTimeoutMs,
    primaryMaxTurns: assertOptionalMaxTurns(primaryMaxTurns, 'primaryMaxTurns'),
    subAgentSoftDeadlineMs: assertPositiveTimerDelay(
      overrides.subAgentSoftDeadlineMs ?? DefaultAgentExecutionLimits.subAgentSoftDeadlineMs,
      'subAgentSoftDeadlineMs'
    ),
    subAgentMaxTurns: assertOptionalMaxTurns(subAgentMaxTurns, 'subAgentMaxTurns'),
    modelStreamIdleTimeoutMs: assertPositiveTimerDelay(
      overrides.modelStreamIdleTimeoutMs ?? DefaultAgentExecutionLimits.modelStreamIdleTimeoutMs,
      'modelStreamIdleTimeoutMs'
    ),
  }
}

export { DefaultAgentExecutionLimits, MaxNativeTimerDelayMs, resolveAgentExecutionLimits }
export type { AgentExecutionLimitOverrides, AgentExecutionLimits }
