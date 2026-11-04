// 从完整调用事实统计工作流，不从回答文案推断成功。
function body(record) {
  if (!record || record.truncated || typeof record.body !== 'string') return null
  try {
    return JSON.parse(record.body)
  } catch {
    return null
  }
}

export function workflowMetrics(traces, summary) {
  const calls = new Map()
  let complete = true
  for (const trace of traces) {
    if (!Array.isArray(trace.invocations)) {
      complete = false
      continue
    }
    for (const record of trace.invocations) {
      const value = body(record)
      const id = value?.prepared?.id
      if (!id || !value.prepared.binding?.moduleId || !value.prepared.operation) {
        complete = false
        continue
      }
      calls.set(id, value)
    }
  }
  const values = [...calls.values()]
  const waitCalls = values.filter(
    ({ prepared }) =>
      prepared.binding.moduleId === 'velaros:agents' &&
      ['wait', 'waitAny'].includes(prepared.operation)
  ).length
  return {
    schema: 'workflow-metrics@1',
    scope: 'main-kernel-invocations',
    complete,
    toolCalls: complete ? values.length : null,
    knownToolCalls: values.length,
    agentWaitCalls: complete ? waitCalls : null,
    // 等待调用不等于空转，缺少因果证据就不计算浪费。
    redundantWaits: null,
    completedWithoutVerification:
      summary.exitReason === 'completed' && typeof summary.passed === 'boolean'
        ? !summary.passed
        : null,
    modelCalls: summary.modelCalls ?? null,
    wallClockMs: summary.wallClockMs ?? null,
    totalTokens: summary.totalUsage?.totalTokens ?? null,
  }
}
