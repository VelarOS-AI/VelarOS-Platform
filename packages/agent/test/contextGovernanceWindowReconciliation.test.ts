/** 自动治理按完整请求容量触发，预算、投影与最终发送门使用同一请求口径。 */
import assert from 'node:assert/strict'

import type { ModelMessage } from 'ai'
import { test } from 'bun:test'

import { estimateContextUsage, resolveContextUsageWindow } from '../src/agent/context/contextUsage'
import type { CompileProviderRequestInput } from '../src/agent/context/ProviderRequestCompiler'
import { ProviderRequestCompiler } from '../src/agent/context/ProviderRequestCompiler'
import { ContextGovernanceSessionRegistry } from '../src/agent/context/residency/ContextGovernanceSession'
import { resolveContextGovernanceConfig } from '../src/agent/context/residency/governanceConfig'
import { resolveGovernanceWindow } from '../src/agent/context/residency/governanceWindow'

function createHistory(turns = 8, resultRepeats = 200): ModelMessage[] {
  const messages: ModelMessage[] = []
  for (let index = 0; index < turns; index += 1) {
    const toolCallId = `call-${index}`
    messages.push(
      { role: 'user', content: `Read file ${index}` },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId, toolName: 'read_file', input: { path: `/repo/f${index}.ts` } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId, toolName: 'read_file', output: { type: 'text', value: 'file content value '.repeat(resultRepeats) } }] }
    )
  }
  return messages
}

function createCompiler(config = {}) {
  const registry = new ContextGovernanceSessionRegistry({
    config: { dashboard: false, ...config }, classifier: { isRefetchable: () => true },
  })
  return { registry, compiler: new ProviderRequestCompiler(registry) }
}

void test('治理窗口完整使用输入容量：扣输出和余量，旧cap不让大窗口提前压缩', () => {
  const input = { modelWindowTokens: 1_000_000, reservedOutputTokens: 32_000, safetyMarginPercent: 4, fixedOverheadTokens: 15_000 }
  const window = resolveGovernanceWindow(resolveContextGovernanceConfig({ cap: 90_000, epochTriggerPercent: 5 }), input)
  const usage = resolveContextUsageWindow({ contextWindow: input.modelWindowTokens, reservedOutputTokens: 32_000, safetyMarginPercent: 4 })
  assert.equal(window.usableContextWindow, usage.usableContextWindow)
  assert.equal(window.sendGateLimitTokens, 928_000)
  assert.equal(window.windowTokens, 913_000)
  assert.equal(window.source, 'send-gate')
})

void test('完整请求占可用输入约89%仍可发送，旧低水位和cap不回收历史', () => {
  const { compiler } = createCompiler({ cap: 1_000, epochTriggerPercent: 1, epochTargetPercent: 1 })
  const messages = createHistory()
  const compiled = compiler.compile({
    sessionId: 'fits-at-eighty', model: 'gpt-test', systemPrompt: 'Follow the task.', messages,
    contextWindow: 32_000,
    pinnedEvidence: [{ id: 'large-constraint', content: '约束条件'.repeat(5_000) }],
  })
  assert.ok(compiled.estimate.percent > 80 && compiled.estimate.percent < 100)
  assert.equal(compiled.decision.okToSend, true)
  assert.equal(compiled.governanceEpoch?.applied, false)
  assert.equal(compiled.governanceEpoch?.trigger, null)
  assert.deepEqual(compiled.messages.slice(0, messages.length), messages)
})

void test('完整请求加上稳定前缀、活动尾、schema和输出预留超限后才自动回收', () => {
  const messages: ModelMessage[] = [{ role: 'system', content: '稳定前缀规则' }, ...createHistory()]
  const common: CompileProviderRequestInput = {
    sessionId: 'full-request-pressure', model: 'gpt-test', systemPrompt: 'Follow the task.', messages,
    contextWindow: 40_000, reservedOutputTokens: 4_000, safetyMarginPercent: 5,
    toolSchemaChars: { read_file: 4_000, context_recall: 200 },
    availableToolNames: ['read_file', 'context_recall'], toolNameAliases: { 'context:recall': 'context_recall' },
    tailBlocks: [{ role: 'user', content: '当轮事实'.repeat(200) }],
    pinnedEvidence: [{ id: 'large-constraint', content: '约束条件'.repeat(7_000) }],
  }
  const compiled = createCompiler().compiler.compile(common)
  assert.equal(compiled.estimate.usableContextWindow, 34_000)
  assert.equal(compiled.governanceEpoch?.source, 'capacity')
  assert.equal(compiled.governanceEpoch?.trigger, 'capacity')
  assert.equal(compiled.governanceEpoch?.applied, true)
  assert.equal(compiled.decision.okToSend, true)
  assert.deepEqual(compiled.messages[0], messages[0])
  assert.ok(JSON.stringify(compiled.messages).includes(common.pinnedEvidence![0]!.content))
  assert.deepEqual(compiled.messages.at(-1), common.tailBlocks![0])
})

void test('可用输入容量边界使用整数token而非四舍五入百分比：等于容量可发，超过1 token阻止', () => {
  const messages: ModelMessage[] = [{ role: 'user', content: '中文正文'.repeat(500) }]
  const common = { sessionId: 'exact-boundary', model: 'gpt-test', systemPrompt: '规则', messages }
  const tokens = estimateContextUsage(common.model, common.systemPrompt, messages).estimatedTokens
  const exact = createCompiler().compiler.compile({ ...common, contextWindow: tokens })
  const overflow = createCompiler().compiler.compile({ ...common, contextWindow: tokens - 1 })
  assert.equal(exact.decision.okToSend, true)
  assert.equal(exact.governanceEpoch?.trigger, null)
  assert.equal(overflow.decision.okToSend, false)
  assert.equal(overflow.governanceEpoch?.trigger, 'capacity')
})

void test('大窗口中超过400K字符的完整历史仅作为载荷诊断，不因此压缩或拒绝', () => {
  const messages = createHistory(100, 300)
  const compiled = createCompiler({ cap: 90_000 }).compiler.compile({
    sessionId: 'large-window', model: 'gpt-test', systemPrompt: 'Follow the task.', messages,
    contextWindow: 1_000_000,
  })
  assert.ok(compiled.estimate.estimatedChars > 400_000)
  assert.ok(compiled.estimate.payloadPercent > 80)
  assert.equal(compiled.decision.okToSend, true)
  assert.equal(compiled.governanceEpoch?.trigger, null)
  assert.deepEqual(compiled.messages, messages)
})

void test('真实provider overflow仍可强制内部恢复；历史模型压缩请求不构成主动入口', () => {
  const { registry, compiler } = createCompiler({ tailProtectTurns: 0 })
  const messages = createHistory()
  messages.push(
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'historical-distill', toolName: 'context:distill', input: {} }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'historical-distill', toolName: 'context:distill', output: { type: 'text', value: 'phase done' } }] }
  )
  const compiled = compiler.compile({ sessionId: 'provider-overflow', model: 'gpt-test', systemPrompt: 'Follow the task.', messages, contextWindow: 128_000, toolNameAliases: { 'context:distill': 'context_distill' } })
  assert.equal(compiled.governanceEpoch?.trigger, null)
  assert.deepEqual(compiled.messages.slice(0, -2), messages.slice(0, -2))
  const recovered = registry.requestEpoch('provider-overflow', { source: 'overflow-recovery' })
  assert.equal(recovered?.source, 'overflow-recovery')
  assert.equal(recovered?.applied, true)
  assert.ok((recovered?.savedTokens ?? 0) > 0)
})

void test('仪表盘也计入完整请求容量，预算内连续编译不因自增诊断文本触发治理', () => {
  const { compiler } = createCompiler({ dashboard: true, cap: 1_000 })
  const input = { sessionId: 'dashboard-capacity', model: 'gpt-test', systemPrompt: 'Follow the task.', messages: createHistory(), contextWindow: 12_000 }
  const first = compiler.compile(input)
  const second = compiler.compile(input)
  assert.equal(first.governanceEpoch?.trigger, null)
  assert.equal(second.governanceEpoch?.trigger, null)
  assert.deepEqual(first.messages, second.messages)
  assert.equal(first.decision.okToSend, true)
  assert.ok(!JSON.stringify(second.messages).includes('call context:distill'))
})

void test('仅超出少量token时，净收益不足10%的安全回收仍能恢复发送', () => {
  const messages: ModelMessage[] = [
    { role: 'user', content: '处理当前任务' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'small-read', toolName: 'read_file', input: { path: '/repo/old.txt' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'small-read', toolName: 'read_file', output: { type: 'text', value: 'word data '.repeat(150) } }] },
    { role: 'user', content: '约束'.repeat(5_000) },
  ]
  const base = { sessionId: 'small-overflow', model: 'gpt-test', systemPrompt: 'Follow the task.', messages }
  const estimatedTokens = estimateContextUsage(base.model, base.systemPrompt, messages).estimatedTokens
  const compiled = createCompiler({ tailProtectTurns: 1, minEpochSavingPercent: 10, eviction: { staleRefetchableTurnDistance: 1 } }).compiler.compile({ ...base, contextWindow: estimatedTokens - 80 })
  assert.equal(compiled.governanceEpoch?.applied, true)
  assert.ok((compiled.governanceEpoch?.savingPercent ?? 100) < 10)
  assert.ok((compiled.governanceEpoch?.savedTokens ?? 0) > 0)
  assert.equal(compiled.decision.okToSend, true)
  assert.deepEqual(compiled.messages.at(-1), messages.at(-1))
})

void test('新摄入长user与工具结果在容量内保留全文，超限才使用摘录且后续不重复展开', () => {
  const { registry, compiler } = createCompiler()
  const longUser = '正文约束'.repeat(15_000)
  const longResult = '原始结果'.repeat(8_000)
  const messages: ModelMessage[] = [
    { role: 'user', content: longUser },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'large-read', toolName: 'read_file', input: { path: '/repo/large.txt' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'large-read', toolName: 'read_file', output: { type: 'text', value: longResult } }] },
  ]
  const base = { sessionId: 'deferred-admission', model: 'gpt-test', systemPrompt: 'Follow the task.', messages }
  const first = compiler.compile({ ...base, contextWindow: 128_000 })
  assert.deepEqual(first.messages, messages)
  assert.equal(first.governanceEpoch?.trigger, null)
  assert.ok(registry.peek(base.sessionId)!.ledger.list().every((record) => record.admittedResidency === 'INLINE'))

  const pressure = compiler.compile({ ...base, contextWindow: 85_000 })
  assert.equal(pressure.governanceEpoch?.applied, true)
  assert.equal(pressure.decision.okToSend, true)
  assert.ok(JSON.stringify(pressure.messages).length < JSON.stringify(first.messages).length)
  assert.deepEqual(registry.peek(base.sessionId)!.ledger.list().map((record) => record.message), messages)
  const next = compiler.compile({ ...base, contextWindow: 128_000 })
  assert.deepEqual(next.messages, pressure.messages)
  assert.equal(next.governanceEpoch?.applied, false)
})
