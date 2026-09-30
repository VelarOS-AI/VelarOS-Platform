// ATIF 保留模型原文、完整请求和真实 Kernel 回执；持续观察按真实发生顺序置于请求之前。
export function recordBody(record) {
  if (!record || record.truncated || record.body == null) return null
  return JSON.parse(record.body)
}

function callEvidence(calls) {
  if (!calls.length) return {}
  return {
    tool_calls: calls.map(({ item, value }) => ({
      tool_call_id: item.id,
      function_name: `${item.summary.moduleId}.${item.summary.operation}`,
      arguments: value?.prepared?.input ?? { raw: item.summary.input },
    })),
    observation: {
      results: calls.map(({ item, value }) => ({
        source_call_id: item.id,
        content: JSON.stringify(value?.receipt ?? item.summary),
      })),
    },
  }
}

export function toTrajectory({ sessionId, instruction, traces, branches = [], identity, model }) {
  const steps = [{ step_id: 1, source: 'user', message: instruction }]
  const usages = []
  const seen = new Set()
  for (const trace of traces) {
    const decision = recordBody(trace.decision)
    const calls = trace.invocations
      .filter((item) => {
        if (seen.has(item.id)) return false
        seen.add(item.id)
        return true
      })
      .map((item) => ({ item, value: recordBody(item) }))
    const observe = trace.observation?.run
    if (observe) {
      steps.push({
        step_id: steps.length + 1,
        source: 'agent',
        llm_call_count: 0,
        message: observe.source,
        ...callEvidence(calls.filter(({ item }) => item.executionId === observe.executionId)),
        extra: { turnId: trace.turnId, phase: 'observation-before-request', run: observe },
      })
    }
    const usage = decision?.usage
    if (usage) usages.push(usage)
    const evidence = callEvidence(
      calls.filter(({ item }) => item.executionId !== observe?.executionId)
    )
    const childRefs = (trace.agents ?? []).filter((child) =>
      branches.some((branch) => branch.sessionId === child.sessionId)
    )
    if (childRefs.length) {
      evidence.observation ??= { results: [] }
      evidence.observation.results.push({
        content: JSON.stringify(trace.agents),
        subagent_trajectory_ref: [...new Set(childRefs.map((child) => child.sessionId))].map(
          (id) => ({ trajectory_id: id })
        ),
      })
    }
    steps.push({
      step_id: steps.length + 1,
      source: 'agent',
      message: trace.response?.body ?? '',
      model_name: model,
      reasoning_effort: 'high',
      ...(usage
        ? {
            metrics: {
              prompt_tokens: usage.inputTokens,
              completion_tokens: usage.outputTokens,
              ...(usage.cacheReadTokens === undefined
                ? {}
                : { cached_tokens: usage.cacheReadTokens }),
            },
          }
        : {}),
      ...evidence,
      extra: {
        turnId: trace.turnId,
        request: recordBody(trace.request),
        executions: trace.executions,
        observation: trace.observation,
        decision,
        gaps: trace.gaps,
      },
    })
  }
  return {
    schema_version: 'ATIF-v1.8',
    session_id: sessionId,
    trajectory_id: sessionId,
    agent: {
      name: 'velaros-scriptact',
      version: `${identity.sourceCommit.slice(0, 12)}:${(identity.bundleFingerprint ?? 'development').slice(0, 12)}`,
      model_name: model,
    },
    steps,
    ...(branches.length
      ? {
          subagent_trajectories: branches.map((branch) => {
            const task = traces
              .flatMap((trace) => trace.agents ?? [])
              .find((child) => child.sessionId === branch.sessionId)?.task
            return toTrajectory({
              sessionId: branch.sessionId,
              instruction:
                task ?? `Runtime ${branch.kind} branch; exact input is recorded in each request.`,
              traces: branch.turns,
              identity,
              model,
            })
          }),
        }
      : {}),
    extra: {
      identity,
      usageComplete: usages.length === traces.length,
      branches: branches.map(({ turns, ...binding }) => binding),
    },
  }
}
