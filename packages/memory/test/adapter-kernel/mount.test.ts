import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import { KernelModuleApiVersion } from '@velaros-ai/kernel/contracts/abi'
import { KernelModuleHost } from '@velaros-ai/kernel/runtime'

import type { MemoryDomain } from '../../src'
import { createMemoryStoreKernelModule } from '../../src/adapter-kernel/MemoryStoreCapability'
import { mountMemoryAdapter, type MountMemoryAdapterInput } from '../../src/adapter-kernel/mount'
import { createMemoryFilesBackend } from '../../src/files'
import { createInMemoryMemoryFilesIo } from '../../src/files/Io'

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
    const host = new KernelModuleHost({ apiVersion: KernelModuleApiVersion })
    host.registerModule(createMemoryStoreKernelModule({ backend }))
    await host.start()
    try {
      const adapter = mountMemoryAdapter({
        ...hostPorts(),
        store: { registry: host, preference: ['files'] },
      })
      assert.equal(adapter.store, backend)
      assert.equal(adapter.service, null)
    } finally {
      await host.dispose()
    }
  })

  test('rejects missing authority and ambiguous selection instead of inventing a tree', () => {
    assert.throws(() => mountMemoryAdapter(hostPorts()), /no authority backend/u)
    const store = { registry: { getOptionalService: () => undefined }, preference: ['files'] }
    assert.throws(() => mountMemoryAdapter({ ...hostPorts(), store }), /no authority backend/u)
    assert.throws(
      () => mountMemoryAdapter({ ...hostPorts(), backend: filesBackend(), store }),
      /one backend selection source/u
    )
  })

  test('direct injection preserves authority-role and required-verb validation', () => {
    const derived = filesBackend()
    Object.defineProperty(derived, 'descriptor', {
      value: { ...derived.descriptor, role: 'derived-index' },
    })
    assert.throws(
      () => mountMemoryAdapter({ ...hostPorts(), backend: derived }),
      /complete authority backend/u
    )
    const incomplete = filesBackend()
    Object.defineProperty(incomplete, 'archive', { value: undefined })
    assert.throws(
      () => mountMemoryAdapter({ ...hostPorts(), backend: incomplete }),
      /complete authority backend/u
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
