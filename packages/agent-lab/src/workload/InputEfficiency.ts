export interface ToolInputEfficiency {
  attempts: number
  completed: number
  notApplied: number
  unknown: number
  reusedAttempts: number
  completedReusedAttempts: number
  requestedChars: number
  effectiveChars: number
  avoidedRepeatChars: number
  corruptReceipts: number
}

/** 消费实际执行回执，计算模型重复输入减少量；字符数不是 token 估算，内部尝试仍计入分母。 */
export function summarizeToolInputEfficiency(
  records: ReadonlyArray<{
    sessionId?: string
    toolName: string
    toolCallId: string
    serializedResult: string
  }>
): ToolInputEfficiency {
  const result: ToolInputEfficiency = {
    attempts: 0,
    completed: 0,
    notApplied: 0,
    unknown: 0,
    reusedAttempts: 0,
    completedReusedAttempts: 0,
    requestedChars: 0,
    effectiveChars: 0,
    avoidedRepeatChars: 0,
    corruptReceipts: 0,
  }
  const seen = new Set<string>()
  for (const record of records) {
    const identity = JSON.stringify([record.sessionId, record.toolCallId])
    if (record.toolName !== '__tool_attempt_outcome__' || seen.has(identity)) continue
    seen.add(identity)
    try {
      const value = JSON.parse(record.serializedResult)
      if (
        value?.kind !== 'tool-attempt-outcome' ||
        !['completed', 'not-applied', 'unknown'].includes(value.outcome)
      )
        throw new Error('Invalid receipt')
      const metrics = value.metrics
      if (
        metrics &&
        (!Number.isSafeInteger(metrics.requestedChars) ||
          metrics.requestedChars < 0 ||
          !Number.isSafeInteger(metrics.effectiveChars) ||
          metrics.effectiveChars < 0 ||
          typeof metrics.reused !== 'boolean')
      )
        throw new Error('Invalid metrics')
      result.attempts++
      if (value.outcome === 'completed') result.completed++
      else if (value.outcome === 'not-applied') result.notApplied++
      else result.unknown++
      if (!metrics) continue
      result.requestedChars += metrics.requestedChars
      result.effectiveChars += metrics.effectiveChars
      if (metrics.reused) {
        result.reusedAttempts++
        if (value.outcome === 'completed') result.completedReusedAttempts++
        result.avoidedRepeatChars += Math.max(0, metrics.effectiveChars - metrics.requestedChars)
      }
    } catch {
      result.corruptReceipts++
    }
  }
  return result
}
