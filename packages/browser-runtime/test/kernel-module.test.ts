import { describe, expect, test } from 'bun:test'

import type { KernelModuleActivateContext } from '@velaros-ai/kernel-sdk'

import {
  BrowserRuntimeCapability,
  type BrowserRuntimeCapabilityService,
  createBrowserKernelModule,
} from '../src'

function createContext() {
  let registered: object | undefined
  const context = {
    moduleId: 'test.browser',
    generation: 1,
    signal: new AbortController().signal,
    services: {},
    events: {},
    permissions: {},
    state: {},
    registerService(token: { id: string }, service: object) {
      expect(token.id).toBe(BrowserRuntimeCapability.id)
      registered = service
      return { dispose() {} }
    },
  } as unknown as KernelModuleActivateContext
  return {
    context,
    readService: () => registered as BrowserRuntimeCapabilityService,
  }
}

describe('browser kernel module', () => {
  test('injects the product runtime and exposes closed lifecycle operations', async () => {
    const calls: string[] = []
    const runtime = {
      closeSession: async (sessionId: string) => {
        calls.push(`close:${sessionId}`)
      },
      closeAllSessions: () => {
        calls.push('close-all')
      },
      dispose: () => {
        calls.push('dispose')
      },
    }
    const module = createBrowserKernelModule({
      runtime: runtime as never,
    })
    const { context, readService } = createContext()

    await module.activate(context)
    const service = readService()
    expect(service.getOperationMetadata('missing')).toBeUndefined()
    expect(await service.invoke(
      'close_session',
      undefined,
      { sessionId: 'browser-1' },
      new AbortController().signal,
    )).toEqual({ closed: true, sessionId: 'browser-1' })
    expect(service.getOperationMetadata('close_session')).toEqual({
      permissions: ['browser:control'],
      reason: 'Close one product-owned browser session.',
    })
    await expect(service.invoke(
      'close_session',
      undefined,
      { sessionId: ' browser-1 ' },
      new AbortController().signal,
    )).rejects.toThrow('Browser capability input is invalid')
    expect(await service.invoke(
      'close_all_sessions',
      undefined,
      {},
      new AbortController().signal,
    )).toEqual({ closed: true })

    expect(calls).toEqual(['close:browser-1', 'close-all'])
  })

  test('keeps injected runtime ownership explicit', async () => {
    const calls: string[] = []
    const runtime = {
      closeSession: async () => undefined,
      closeAllSessions: () => undefined,
      dispose: () => calls.push('dispose'),
    }
    const borrowedModule = createBrowserKernelModule({
      runtime: runtime as never,
    })
    const borrowed = createContext()
    const borrowedLifecycle = await borrowedModule.activate(borrowed.context)
    await borrowedLifecycle?.dispose?.()
    expect(calls).toEqual([])

    const ownedModule = createBrowserKernelModule({
      runtime: runtime as never,
      disposeInjectedRuntime: true,
    })
    const owned = createContext()
    const ownedLifecycle = await ownedModule.activate(owned.context)
    await ownedLifecycle?.dispose?.()
    expect(calls).toEqual(['dispose'])
  })
})
