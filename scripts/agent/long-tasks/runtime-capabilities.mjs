import assert from 'node:assert/strict'

// 只改变可选业务能力；执行、上下文整理、模型限制与评分流程共用同一候选。
export function runtimeCapabilityOptions(mode = 'on-demand') {
  assert(['on-demand', 'shell-node'].includes(mode), 'Unknown ScriptAct capability mode')
  const enabled = mode === 'on-demand'
  return { project: enabled ? { code: true } : false, agents: enabled, search: enabled }
}

// 持续目标模式必须在付费前明确冻结；普通请求保持原始生命周期。
export function runtimeSubmissionOptions(mode = 'request', objective) {
  assert(['request', 'goal'].includes(mode), 'Unknown ScriptAct task mode')
  assert.equal(typeof objective, 'string')
  assert(objective.trim(), 'Task objective must not be empty')
  return mode === 'goal' ? { goal: objective } : {}
}
