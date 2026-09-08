import assert from 'node:assert/strict'

import type { ModelMessage } from 'ai'
import { test } from 'bun:test'

import { createContextPayloadRef } from '../src/agent/context/ContextPayloadStore'
import { ProviderRequestCompiler } from '../src/agent/context/ProviderRequestCompiler'
import { ContextGovernanceSessionRegistry } from '../src/agent/context/residency/ContextGovernanceSession'
import { ChatContextRetrievalService } from '../src/agent/context/retrieval/ContextRetrievalService'
import type { ChatSessionToolResultPayload } from '../src/protocol'

/** 可回收的旧文件读取，保留最近用户轮，避免把固定证据超限误当不可恢复压力。 */
function createHistory(): ModelMessage[] {
  const messages: ModelMessage[] = []
  for (let index = 0; index < 8; index += 1) {
    const toolCallId = `read-${index}`
    messages.push(
      { role: 'user', content: `Read file ${index}` },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId, toolName: 'read_file', input: { path: `/repo/f${index}.ts` } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId, toolName: 'read_file', output: { type: 'text', value: 'file content value '.repeat(200) } }] }
    )
  }
  return messages
}

function createCompiler(): ProviderRequestCompiler {
  return new ProviderRequestCompiler(new ContextGovernanceSessionRegistry({
    config: { dashboard: false },
    classifier: { isRefetchable: () => true },
  }))
}

for (const retainedKind of ['activeTask', 'pinnedEvidence'] as const) {
  void test(`${retainedKind} 在治理前按实际发送内容预留，中文证据不套用英文历史密度`, () => {
    const compiler = createCompiler()
    const messages = createHistory()
    const historyBefore = JSON.stringify(messages)
    const content = '约束条件'.repeat(6_500)
    const retained = retainedKind === 'activeTask'
      ? { activeTask: { id: 'current-goal', summary: content } }
      : { pinnedEvidence: [{ id: 'constraint', kind: 'user-constraint' as const, content }] }
    const compiled = compiler.compile({
      sessionId: retainedKind,
      model: 'gpt-test',
      systemPrompt: 'Follow the task.',
      messages,
      contextWindow: 32_000,
      ...retained,
    })

    assert.equal(compiled.governanceEpoch?.applied, true)
    assert.ok((compiled.governanceEpoch?.window?.fixedOverheadTokens ?? 0) >= 26_000)
    assert.equal(compiled.decision.okToSend, true)
    assert.ok(String(compiled.messages.at(-1)?.content).includes(content))
    assert.equal(JSON.stringify(messages), historyBefore)
    assert.deepEqual(compiled.messages, compiled.providerRequest.messages)
  })
}

void test('硬保留内容自身超过窗口时维持发送门关闭，并保持完整证据', () => {
  const content = '不可压缩的任务约束。'.repeat(6_000)
  const compiled = createCompiler().compile({
    sessionId: 'oversized-retained',
    model: 'gpt-test',
    systemPrompt: 'Follow the task.',
    messages: [{ role: 'user', content: '继续任务' }],
    contextWindow: 32_000,
    pinnedEvidence: [{ id: 'constraint', content }],
  })
  assert.equal(compiled.decision.okToSend, false)
  assert.equal(compiled.governanceEpoch?.window?.source, 'floor')
  assert.ok(String(compiled.messages.at(-1)?.content).includes(content))
})

void test('模型可见的固定证据保留原始来源、文件版本与可实际召回的引用', async () => {
  const sessionId = 'evidence-session'
  const payloadRef = createContextPayloadRef(sessionId, 'original-hash')
  const serializedResult = '原始读取结果：旧版本端口 4040，完整证据仍可分页读取。'
  const payload: ChatSessionToolResultPayload = {
    toolCallId: 'source-read', toolName: 'read_file', payloadRef,
    serializedResult, displayResult: serializedResult,
  }
  const compiler = createCompiler()
  const compiled = compiler.compile({
    sessionId, model: 'gpt-test', systemPrompt: 'Follow the task.',
    messages: [{ role: 'user', content: '核对当前端口配置' }],
    pinnedEvidence: [{
      id: 'config-evidence', content: '旧端口 4040', source: 'active-context:decision',
      payloadRef, filePath: '/repo/config.json', contentHash: 'old-hash',
      resourceRevision: 'revision-1', verified: true,
    }],
    resourceState: { revision: 'revision-2', files: [{ path: '/repo/config.json', hash: 'new-hash' }] },
  })
  const providerText = String(compiled.messages.at(-1)?.content)
  const blocks = JSON.parse(providerText.slice(providerText.indexOf('[\n'))) as Array<{
    source: string; payloadRef: string; filePath: string; contentHash: string;
    resourceRevision: string; verified: boolean; stale: boolean;
  }>
  const block = blocks[0]!
  assert.equal(block.source, 'active-context:decision')
  assert.equal(block.payloadRef, payloadRef)
  assert.equal(block.filePath, '/repo/config.json')
  assert.equal(block.contentHash, 'old-hash')
  assert.equal(block.resourceRevision, 'revision-1')
  assert.equal(block.verified, true)
  assert.equal(block.stale, true)

  const service = new ChatContextRetrievalService(
    {
      loadSessionPayloads: async (requestedSessionId) => ({
        sessionId: requestedSessionId, userMessages: {}, assistantMessages: {},
        toolResults: requestedSessionId === sessionId ? { [payloadRef]: payload } : {},
      }),
      loadToolPayload: async (requestedSessionId, key) => requestedSessionId === sessionId && key === payloadRef ? payload : null,
    },
    { loadSessionMessages: async () => [], loadSessionMessage: async () => null },
    new ContextGovernanceSessionRegistry(),
    { loadFresh: async () => null, save: async () => undefined }
  )
  const recalled = await service.retrieveContextPayload({ sessionId, handleId: block.payloadRef })
  assert.equal(recalled.found, true)
  assert.ok(recalled.content?.endsWith(serializedResult))
  assert.equal((await service.retrieveContextPayload({ sessionId: 'unrelated', handleId: block.payloadRef })).found, false)
})
