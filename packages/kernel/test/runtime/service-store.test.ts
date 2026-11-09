import { expect, test } from 'bun:test'

import { kernelModules } from '../../src/impl/runtime/KernelModuleKit'
import { KernelServiceStore } from '../../src/impl/runtime/KernelServiceStore'

test('a late old service disposal preserves ownership cleanup of the new generation', () => {
  const store = new KernelServiceStore()
  const token = kernelModules.token<{ read(): string }>('test.late-disposal', '1.0.0')
  const old = store.register('provider', 1, token, { read: () => 'old' })
  const oldHandle = store.getHandle(token)
  store.removeOwner('provider', 1)
  store.register('provider', 2, token, { read: () => 'current' })
  const currentHandle = store.getHandle(token)
  old.dispose()
  old.dispose()

  expect(oldHandle.isActive()).toBe(false)
  expect(store.get(token).read()).toBe('current')
  store.removeOwner('provider', 2)
  expect(store.has(token)).toBe(false)
  expect(store.getActiveToken(token.id)).toBeUndefined()
  expect(currentHandle.isActive()).toBe(false)
  expect(() => currentHandle.get()).toThrow(expect.objectContaining({ code: 'MODULE_STATE' }))
})
