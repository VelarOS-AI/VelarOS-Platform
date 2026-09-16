import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import { createKernel } from '@velaros-ai/kernel'

import { createInMemoryMemoryFilesIo } from '../../src/impl/files/InMemoryMemoryFilesIo'
import { createMemoryFilesBackend } from '../../src/impl/files/MemoryFilesBackend'
import { mountMemoryAdapter, type MountMemoryAdapterInput } from '../../src/impl/host/MemoryAdapterRuntime'
import { createMemoryStoreKernelModule } from '../../src/impl/host/MemoryStoreCapabilities'
import type { MemoryTreeDomain as MemoryDomain } from '../../src/impl/tree/MemoryTreeDomain'

function hostPorts(): Pick<MountMemoryAdapterInput, 'config' | 'hostContext'> {
  return {
    config: {
      isEnabled: () => true,
      isBackgroundGrowthEnabled: () => true,
      allowBatteryGrowth: () => false,
      isAutomaticDeepRecallEnabled: () => false,
      isChatCaptureEnabled: () => true,
      isWorkspaceCaptureEnabled: () => true,
      isComputerUseCaptureEnabled: () => true,
      isExecutionCaptureEnabled: () => true,
    },
    hostContext: {
      resolveScope: () => ({ scopeType: 'global', scopeId: 'global' }),
      turnContextScopes: ['system'],
    },
  }
}

function filesBackend(): ReturnType<typeof createMemoryFilesBackend> {
  return createMemoryFilesBackend({
    roots: [{ scopeType: 'global', scopeId: 'global', directory: '/memory' }],
    io: createInMemoryMemoryFilesIo(),
  })
}

describe('Memory adapter optional tree governance', () => {
  test('captures and recalls through a standalone file authority without a tree or idle port', async () => {
    const backend = filesBackend()
    const adapter = mountMemoryAdapter({ ...hostPorts(), backend })
    assert.equal(adapter.store, backend)
    assert.equal(adapter.service, null)
    adapter.evidenceBridge.captureUserMessage({
      sessionId: 'session',
      messages: [{ role: 'user', messageId: 'message', textBlocks: ['记住山间的蓝色房子'] }],
    })
    await adapter.evidenceBridge.flush()
    assert.equal((await adapter.store.recall('蓝色房子')).length, 1)
  })

  test('retains capability-registry selection without requiring a tree fallback', async () => {
    const backend = filesBackend()
    const kernel = createKernel()
    kernel.registerModule(createMemoryStoreKernelModule({ backend }))
    await kernel.start()
    try {
      const adapter = mountMemoryAdapter({
        ...hostPorts(),
        store: {
          registry: { getOptionalService: (token) => kernel.getCapability(token) },
          preference: ['files'],
        },
      })
      assert.equal(adapter.store, backend)
      assert.equal(adapter.service, null)
    } finally {
      await kernel.dispose()
    }
  })

  test('rejects missing authority and ambiguous selection instead of inventing a tree', () => {
    assert.throws(() => mountMemoryAdapter(hostPorts()), /没有权威层后端/u)
    const store = { registry: { getOptionalService: () => undefined }, preference: ['files'] }
    assert.throws(() => mountMemoryAdapter({ ...hostPorts(), store }), /没有权威层后端/u)
    assert.throws(
      () => mountMemoryAdapter({ ...hostPorts(), backend: filesBackend(), store }),
      /backend 与 store 二选一/u
    )
  })

  test('direct injection preserves authority-role and required-verb validation', () => {
    const derived = filesBackend()
    Object.defineProperty(derived, 'descriptor', {
      value: { ...derived.descriptor, role: 'derived-index' },
    })
    assert.throws(
      () => mountMemoryAdapter({ ...hostPorts(), backend: derived }),
      /完整的权威层后端/u
    )
    const incomplete = filesBackend()
    Object.defineProperty(incomplete, 'archive', { value: undefined })
    assert.throws(
      () => mountMemoryAdapter({ ...hostPorts(), backend: incomplete }),
      /完整的权威层后端/u
    )
  })

  test('explicit tree governance can coexist with a file authority and owns its lifecycle', async () => {
    let warmups = 0
    let dreams = 0
    const domain = {
      warmup: () => {
        warmups += 1
        return { state: 'skipped' }
      },
      runDream: () => {
        dreams += 1
        return { state: 'skipped' }
      },
    } as MemoryDomain
    const backend = filesBackend()
    const adapter = mountMemoryAdapter({
      ...hostPorts(),
      backend,
      tree: {
        domain,
        idleSignal: {
          getIdleSeconds: () => 0,
          isOnBatteryPower: () => false,
          isAppFocused: () => true,
        },
      },
    })
    assert.equal(adapter.store, backend)
    assert.ok(adapter.service)
    try {
      await adapter.service.warmup()
      adapter.service.runDreamNow()
      assert.equal(warmups, 1)
      assert.equal(dreams, 1)
    } finally {
      adapter.service.close()
    }
  })
})
