import { describe, expect, test } from 'bun:test'

import type {
  CapabilityToken,
  KernelModuleActivateContext,
  KernelModuleHealth,
  ScopeRef,
} from '@velaros-ai/kernel/contracts/abi'

import {
  AgentCapability,
  type AgentCapabilityRuntime,
  type AgentCapabilityService,
  createAgentKernelModule,
} from '../src'

function createCaptureContext(
  signal: AbortSignal,
  capture: (tokenId: string, service: object) => void,
  publish: (type: string, payload: unknown) => Promise<void> =
    async () => undefined,
): KernelModuleActivateContext {
  return {
    signal,
    events: {
      publish,
    },
    registerService<TService extends object>(
      token: CapabilityToken<TService>,
      service: TService,
    ) {
      capture(token.id, service)
      return { dispose() {} }
    },
  } as unknown as KernelModuleActivateContext
}

describe('agent kernel module', () => {
  test('adapts an injected runtime without owning Agent request semantics', async () => {
    const lifecycleEvents: string[] = []
    const executionInput = {
      session: { productDefined: true },
      toolPolicy: ['host-owned'],
    }
    const scope = { kind: 'session', id: 'session-1' } as ScopeRef
    let receivedScope: ScopeRef | undefined
    let receivedInput: unknown
    let receivedSignal: AbortSignal | undefined
    let service: AgentCapabilityService | undefined
    const publishedEvents: Array<{ type: string; payload: unknown }> = []

    const runtime: AgentCapabilityRuntime = {
      start: () => {
        lifecycleEvents.push('start')
      },
      execute: async (runtimeScope, input, execution) => {
        execution.signal.throwIfAborted()
        receivedScope = runtimeScope
        receivedInput = input
        receivedSignal = execution.signal
        await execution.publish('agent.progress', { phase: 'running' })
        return { accepted: true }
      },
      health: (): KernelModuleHealth => ({
        status: 'healthy',
        details: { runtime: 'injected' },
      }),
      suspend: () => {
        lifecycleEvents.push('suspend')
      },
      dispose: () => {
        lifecycleEvents.push('dispose')
      },
    }
    const module = createAgentKernelModule({ runtime })
    const controller = new AbortController()
    const lifecycle = await module.activate(
      createCaptureContext(
        controller.signal,
        (tokenId, registered) => {
          expect(tokenId).toBe(AgentCapability.id)
          service = registered as AgentCapabilityService
        },
        async (type, payload) => {
          publishedEvents.push({ type, payload })
        },
      ),
    )

    expect(module.manifest.provides).toEqual([AgentCapability])
    expect(module.manifest.requires).toEqual([])
    expect(module.manifest.permissions).toEqual(['agent:execute'])
    expect(service?.isReady()).toBe(false)
    expect(await service?.health()).toMatchObject({ status: 'unknown' })
    await expect(service?.execute(
      scope,
      executionInput,
      controller.signal,
    )).rejects.toThrow('Agent capability is not ready')

    await lifecycle?.ready?.()
    expect(service?.isReady()).toBe(true)
    expect(lifecycleEvents).toEqual(['start'])
    expect(service?.getOperationMetadata('health')?.permissions).toEqual([])
    expect(service?.getOperationMetadata('execute')?.permissions).toEqual([
      'agent:execute',
    ])
    expect(await service?.invoke(
      'execute',
      scope,
      executionInput,
      controller.signal,
    )).toEqual({ accepted: true })
    expect(receivedScope).toBe(scope)
    expect(receivedInput).toBe(executionInput)
    expect(receivedSignal).toBe(controller.signal)
    expect(publishedEvents).toEqual([
      { type: 'agent.progress', payload: { phase: 'running' } },
    ])
    expect(await lifecycle?.health?.()).toEqual({
      status: 'healthy',
      details: { runtime: 'injected' },
    })
    await expect(service?.invoke(
      'health',
      undefined,
      { includeSecrets: true },
      controller.signal,
    )).rejects.toThrow('Agent health input is invalid')

    await lifecycle?.suspend?.()
    expect(service?.isReady()).toBe(false)
    await lifecycle?.dispose?.()
    expect(lifecycleEvents).toEqual(['start', 'suspend', 'dispose'])
  })

  test('does not execute when the invocation signal is already aborted', async () => {
    let executed = false
    let service: AgentCapabilityService | undefined
    const runtime: AgentCapabilityRuntime = {
      execute: async () => {
        executed = true
      },
    }
    const module = createAgentKernelModule({ runtime })
    const moduleController = new AbortController()
    const lifecycle = await module.activate(
      createCaptureContext(moduleController.signal, (_tokenId, registered) => {
        service = registered as AgentCapabilityService
      }),
    )
    await lifecycle?.ready?.()

    const invocationController = new AbortController()
    invocationController.abort()
    expect(() =>
      service?.invoke(
        'execute',
        undefined,
        {},
        invocationController.signal,
      )
    ).toThrow('Capability invocation aborted')
    expect(executed).toBe(false)
  })
})
