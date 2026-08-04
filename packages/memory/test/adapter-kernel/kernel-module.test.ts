import { describe, expect, test } from 'bun:test'

import type { KernelModuleActivateContext } from '@velaros-ai/kernel/contracts/abi'

import {
  createMemoryKernelModule,
  MemoryCapability,
  type MemoryCapabilityService,
} from '../../src/adapter-kernel'

describe('memory kernel module', () => {
  test('exposes a bounded read-only callable surface', async () => {
    let registered: MemoryCapabilityService | undefined
    const recallOptions: unknown[] = []
    const module = createMemoryKernelModule({
      domain: {
        recall: (query, options) => {
          recallOptions.push(options)
          return [{ claimId: query }] as never
        },
        getClaim: (claimId) => ({
          claimId,
          scopeType: 'workspace',
          scopeId: 'workspace-1',
        }) as never,
        getDiagnostics: () => ({ pendingEvidence: 0 }) as never,
        verifyTreeIntegrity: () => ({ valid: true }) as never,
      },
    })
    const context = {
      moduleId: 'test.memory',
      generation: 1,
      signal: new AbortController().signal,
      services: {},
      events: {},
      permissions: {},
      state: {},
      registerService(token: { id: string }, service: typeof registered) {
        expect(token.id).toBe(MemoryCapability.id)
        registered = service
        return { dispose() {} }
      },
    } as unknown as KernelModuleActivateContext

    await module.activate(context)
    expect(registered?.getOperationMetadata('capture')).toBeUndefined()
    expect(
      await registered?.invoke(
        'recall',
        {
          id: 'workspace-1',
          ownerModuleId: 'desktop.workspace-registry',
          kind: 'project',
        },
        {
          query: ' project ',
          options: {
            categories: ['project'],
          },
        },
        new AbortController().signal,
      ),
    ).toEqual([{ claimId: 'project' }])
    expect(recallOptions).toEqual([
      { categories: ['project'], scopeId: 'workspace-1' },
    ])
    expect(registered?.getOperationMetadata('recall')).toEqual({
      permissions: ['memory:read'],
      reason: 'Recall memory through the active product scope.',
    })
    expect(() =>
      registered?.invoke(
        'recall',
        undefined,
        {
          query: 'project',
          options: { categories: ['not-a-memory-category'] },
        },
        new AbortController().signal,
      )).toThrow('Memory capability input is invalid')
    expect(() =>
      registered?.invoke(
        'recall',
        {
          id: 'workspace-1',
          ownerModuleId: 'desktop.workspace-registry',
          kind: 'project',
        },
        {
          query: 'project',
          options: { workspaceRoot: '/another/workspace' },
        },
        new AbortController().signal,
      )).toThrow('Memory capability input is invalid')
    expect(() =>
      registered?.invoke(
        'recall',
        {
          id: 'workspace-1',
          ownerModuleId: 'desktop.workspace-registry',
          kind: 'project',
        },
        {
          query: 'project',
          options: { scopeId: 'workspace-2' },
        },
        new AbortController().signal,
      )).toThrow('Memory capability input is invalid')
    expect(await registered?.invoke(
      'get_claim',
      {
        id: 'workspace-2',
        ownerModuleId: 'desktop.workspace-registry',
        kind: 'project',
      },
      { claimId: 'claim-1' },
      new AbortController().signal,
    )).toBeNull()
    expect(module.manifest.permissions).toEqual(['memory:read'])
  })
})
