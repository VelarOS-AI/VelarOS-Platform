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
  const domain = {
    captureEvidenceBatch(inputs) {
      captured.push(...inputs)
      return { insertedCount: inputs.length }
    },
    runDream() {},
    setSessionEvidenceEligibility() {},
  }
  const bridge = new MemoryEvidenceBridge(domain, {
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
