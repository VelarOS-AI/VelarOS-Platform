const MaxNativeTimerDelayMs = 2_147_483_647

interface AgentExecutionLimits {
  /** 普通主 Agent 单次执行的墙钟硬上限。 */
  standardExecutionWallClockTimeoutMs: number
  /** Goal 模式或已建立活动目标的主 Agent 墙钟硬上限。 */
  goalExecutionWallClockTimeoutMs: number
  /** 主 Agent 轮次上限；null 表示不按轮次收尾。 */
  primaryMaxTurns: number | null
  /** 单个子 Agent 到点后的软收尾时间。 */
  subAgentSoftDeadlineMs: number
  /** 子 Agent 轮次上限；null 表示不按轮次收尾。 */
  subAgentMaxTurns: number | null
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
    throw new RangeError(
      `${field} 必须是正安全整数，且不大于 ${MaxNativeTimerDelayMs}。`
    )
  }
  return value
}

function assertOptionalMaxTurns(value: number | null, field: string): number | null {
  if (value === null) return null
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} 必须为 null 或正安全整数。`)
  }
  return value
}

function resolveAgentExecutionLimits(
  overrides: AgentExecutionLimitOverrides = {}
): AgentExecutionLimits {
  const primaryMaxTurns =
    overrides.primaryMaxTurns === undefined
      ? DefaultAgentExecutionLimits.primaryMaxTurns
      : overrides.primaryMaxTurns
  const subAgentMaxTurns =
    overrides.subAgentMaxTurns === undefined
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
    primaryMaxTurns: assertOptionalMaxTurns(
      primaryMaxTurns,
      'primaryMaxTurns'
    ),
    subAgentSoftDeadlineMs: assertPositiveTimerDelay(
      overrides.subAgentSoftDeadlineMs ?? DefaultAgentExecutionLimits.subAgentSoftDeadlineMs,
      'subAgentSoftDeadlineMs'
    ),
    subAgentMaxTurns: assertOptionalMaxTurns(
      subAgentMaxTurns,
      'subAgentMaxTurns'
    ),
    modelStreamIdleTimeoutMs: assertPositiveTimerDelay(
      overrides.modelStreamIdleTimeoutMs ??
        DefaultAgentExecutionLimits.modelStreamIdleTimeoutMs,
      'modelStreamIdleTimeoutMs'
    ),
  }
}

export {
  DefaultAgentExecutionLimits,
  MaxNativeTimerDelayMs,
  resolveAgentExecutionLimits,
}
export type { AgentExecutionLimitOverrides, AgentExecutionLimits }
