import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const adapterEntry = pathToFileURL(resolve(
  import.meta.dirname,
  '../../../../../packages/memory/dist/adapter-kernel/index.js',
)).href
const { MemoryEvidenceBridge } = await import(adapterEntry)

test('host events and scope mapping are injected without Chat or Workspace DTOs', async () => {
  const captured = []
  // 批一「端口收口」后，capture 桥注入的是**记忆后端窄端口**（capability token 解析出的
  // MemoryStoreBackend），不再是记忆树领域服务。断言的行为契约一条未改：宿主事件与作用域
  // 映射经端口注入，桥内不认识任何 Chat / Workspace DTO。
  const backend = {
    descriptor: {
      id: 'probe',
      role: 'authority',
      displayName: 'probe backend',
      verbs: ['capture', 'recall', 'inspect', 'dream', 'govern'],
    },
    captureBatch(inputs) {
      captured.push(...inputs)
      return { evidence: [], insertedCount: inputs.length, treeVersion: 0 }
    },
    capture() {
      throw new Error('unused')
    },
    recall() {
      return []
    },
    getItem() {
      return null
    },
    inspect() {
      return { backendId: 'probe', itemCount: 0, pendingCount: 0, version: 0 }
    },
    dream() {},
    governSourceEligibility() {},
  }
  const bridge = new MemoryEvidenceBridge(backend, {
    isEnabled: () => true,
    isChatCaptureEnabled: () => true,
    environmentContextBlockOpenTag: '<environment-context>',
    resolveScope: ({ contextId }) => ({
      scopeType: 'site',
      scopeId: `host:${contextId}`,
    }),
  })

  bridge.captureUserMessage({
    sessionId: 'session-1',
    contextId: 'context-1',
    messages: [{
      role: 'user',
      messageId: 'message-1',
      timestamp: 42,
      textBlocks: [
        'remember this preference',
        '<environment-context>untrusted page title</environment-context>',
      ],
    }],
  })
  await bridge.flush()

  assert.equal(captured.length, 1)
  assert.equal(captured[0].content, 'remember this preference')
  assert.equal(captured[0].scopeId, 'host:context-1')
  assert.equal(captured[0].scopeType, 'site')
})
