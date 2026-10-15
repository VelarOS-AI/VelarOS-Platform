import assert from 'node:assert/strict'

// 保留比例是预先冻结的独立消融条件；缺省使用候选自身默认值。
export function runtimeContextPolicy(config) {
  const { inputWindowTokens, runtimeRetainedFrameRatio } = config
  assert(Number.isSafeInteger(inputWindowTokens) && inputWindowTokens >= 1024)
  if (runtimeRetainedFrameRatio !== undefined)
    assert(
      Number.isFinite(runtimeRetainedFrameRatio) &&
        runtimeRetainedFrameRatio >= 0 &&
        runtimeRetainedFrameRatio <= 1,
      'Invalid frozen Runtime retained frame ratio'
    )
  return {
    windowTokens: inputWindowTokens,
    ...(runtimeRetainedFrameRatio === undefined
      ? {}
      : { retainedFrameRatio: runtimeRetainedFrameRatio }),
  }
}

// 只改变可选业务能力；执行、上下文整理、模型限制与评分流程共用同一候选。
export function runtimeCapabilityOptions(mode = 'on-demand') {
  assert(['on-demand', 'node', 'project'].includes(mode), 'Unknown ScriptAct capability mode')
  const enabled = mode === 'on-demand'
  return {
    project: enabled ? { code: true } : mode === 'project',
    agents: enabled,
    search: enabled,
  }
}

// 编辑策略是独立实验条件，只改 ScriptAct 的任务正文，保留普通按需能力的默认行为。
export function runtimeEditingPrompt(mode, strategy = 'adaptive', prompt) {
  const capabilities = runtimeCapabilityOptions(mode)
  assert(['adaptive', 'project'].includes(strategy), 'Unknown ScriptAct editing strategy')
  assert.equal(typeof prompt, 'string')
  if (strategy === 'adaptive') return prompt
  assert(capabilities.project, 'Project editing requires the project capability')
  return `${prompt}\n\nImplementation policy for this run: use the available velaros:project capability for deliberate repository source, test, documentation and configuration edits, including creating, replacing, moving or deleting files. Discover its installed interfaces on demand and inspect actual operation results. Reading, computation, running builds/tests and generated build outputs may use standard Node.js and Execa. Do not implement repository source changes through direct filesystem writes or shell commands. If a required edit is unsupported, report the exact limitation instead of silently bypassing this policy.`
}

// 持续目标模式必须在付费前明确冻结；普通请求保持原始生命周期。
export function runtimeSubmissionOptions(mode = 'request', objective) {
  assert(['request', 'goal'].includes(mode), 'Unknown ScriptAct task mode')
  assert.equal(typeof objective, 'string')
  assert(objective.trim(), 'Task objective must not be empty')
  return mode === 'goal' ? { goal: objective } : {}
}
