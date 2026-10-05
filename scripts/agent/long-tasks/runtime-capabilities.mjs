import assert from 'node:assert/strict'

// 只改变可选业务能力；执行、上下文整理、模型限制与评分流程共用同一候选。
export function runtimeCapabilityOptions(mode = 'on-demand') {
  assert(['on-demand', 'shell-node'].includes(mode), 'Unknown ScriptAct capability mode')
  const enabled = mode === 'on-demand'
  return { project: enabled ? { code: true } : false, agents: enabled, search: enabled }
}
