// 验证工作流指标保留未知与失败分母。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workflowMetrics } from './workflow-metrics.mjs'
const call = (id, operation = 'wait') => ({
  truncated: false,
  body: JSON.stringify({ prepared: { id, binding: { moduleId: 'velaros:agents' }, operation } }),
})
test('workflow metrics deduplicate receipts and separate waits from wasted waits', () => {
  const result = workflowMetrics([{ invocations: [call('a'), call('a'), call('b', 'start')] }], {
    exitReason: 'completed',
    passed: false,
  })
  assert.equal(result.toolCalls, 2)
  assert.equal(result.agentWaitCalls, 1)
  assert.equal(result.redundantWaits, null)
  assert.equal(result.completedWithoutVerification, true)
  assert.equal(result.totalTokens, null)
})
test('workflow metrics do not turn incomplete evidence into zero', () => {
  const result = workflowMetrics(
    [{ invocations: [call('a'), { truncated: true, body: '{}' }] }],
    {}
  )
  assert.equal(result.complete, false)
  assert.equal(result.toolCalls, null)
  assert.equal(result.knownToolCalls, 1)
  assert.equal(result.completedWithoutVerification, null)
})
test('workflow metrics preserve measured zero and verified completion', () => {
  const result = workflowMetrics([{ invocations: [] }], {
    exitReason: 'completed',
    passed: true,
    totalUsage: { totalTokens: 0 },
  })
  assert.equal(result.toolCalls, 0)
  assert.equal(result.totalTokens, 0)
  assert.equal(result.completedWithoutVerification, false)
})
