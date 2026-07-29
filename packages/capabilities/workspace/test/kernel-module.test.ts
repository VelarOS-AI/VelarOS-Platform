import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import type {
  CapabilityToken,
  KernelModuleActivateContext,
} from '@velaros-ai/core/kernel/abi'

import {
  createWorkspaceKernelModule,
  WorkspaceCapability,
  type WorkspaceCapabilityService,
} from '../src/index'

function createCaptureContext(
  capture: (tokenId: string, service: object) => void,
): KernelModuleActivateContext {
  return {
    moduleId: 'velaros.workspace.default',
    generation: 1,
    signal: new AbortController().signal,
    services: {},
    events: {},
    permissions: {},
    state: {},
    registerService<TService extends object>(
      token: CapabilityToken<TService>,
      service: TService,
    ) {
      capture(token.id, service)
      return { dispose() {} }
    },
  } as unknown as KernelModuleActivateContext
}

describe('workspace kernel module', () => {
  test('registers a callable single workspace with operation permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-workspace-module-'))
    let service: WorkspaceCapabilityService | undefined
    const module = createWorkspaceKernelModule({
      root,
      includeBuiltinPlugins: false,
    })

    try {
      const lifecycle = await module.activate(
        createCaptureContext((tokenId, registered) => {
          expect(tokenId).toBe(WorkspaceCapability.id)
          service = registered as WorkspaceCapabilityService
        }),
      )

      expect(module.manifest.permissions).toEqual([
        'fs:read',
        'fs:write',
        'process:exec',
      ])
      expect(service?.getOperationMetadata('ws_status')).toEqual({
        permissions: ['fs:read'],
        reason: 'Invoke workspace operation "ws_status".',
      })
      expect(service?.getOperationMetadata('ws_apply_edit')?.permissions)
        .toEqual(['fs:write'])
      const status = await service?.invoke(
        'ws_status',
        undefined,
        {},
        new AbortController().signal,
      )
      expect(status).toMatchObject({ root })
      const bridge = await service!.resolveBridge(
        undefined,
        new AbortController().signal,
      )
      const declaredPermissions = new Set(module.manifest.permissions)
      expect(
        bridge.tools.flatMap((tool) =>
          (service?.getOperationMetadata(tool.name)?.permissions ?? [])
            .filter((permission) => !declaredPermissions.has(permission))),
      ).toEqual([])
      await expect(service?.invoke(
        'ws_status',
        undefined,
        { unexpected: true },
        new AbortController().signal,
      )).rejects.toThrow('Workspace capability input is invalid')
      await lifecycle?.dispose?.()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('resolves product-owned workspaces by opaque scope without taking ownership', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-workspace-resolver-'))
    const bridgeModule = createWorkspaceKernelModule({
      root,
      includeBuiltinPlugins: false,
    })
    let bridgeService: WorkspaceCapabilityService | undefined
    const bridgeLifecycle = await bridgeModule.activate(
      createCaptureContext((_tokenId, registered) => {
        bridgeService = registered as WorkspaceCapabilityService
      }),
    )
    const bridge = await bridgeService!.resolveBridge(
      undefined,
      new AbortController().signal,
    )
    const resolvedScopeIds: string[] = []
    let service: WorkspaceCapabilityService | undefined
    const module = createWorkspaceKernelModule({
      resolver: {
        resolveBridge(scope) {
          if (scope !== undefined) resolvedScopeIds.push(scope.id)
          return bridge
        },
      },
    })

    try {
      const lifecycle = await module.activate(
        createCaptureContext((_tokenId, registered) => {
          service = registered as WorkspaceCapabilityService
        }),
      )
      const scope = {
        id: 'workspace-session-1',
        ownerModuleId: 'desktop.workspace-registry',
        kind: 'project',
      }
      expect(await service?.invoke(
        'ws_status',
        scope,
        {},
        new AbortController().signal,
      )).toMatchObject({ root })
      expect(resolvedScopeIds).toEqual(['workspace-session-1'])
      await lifecycle?.dispose?.()
      expect(await bridge.workspace.status()).toMatchObject({ root })
    } finally {
      await bridgeLifecycle?.dispose?.()
      await rm(root, { recursive: true, force: true })
    }
  })
})
