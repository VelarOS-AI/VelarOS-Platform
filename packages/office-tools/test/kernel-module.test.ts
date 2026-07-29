import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import type {
  CapabilityToken,
  KernelModuleActivateContext,
} from '@velaros-ai/kernel-sdk'

import {
  createOfficeToolsKernelModule,
  type OfficeToolContext,
  OfficeToolsCapability,
  type OfficeToolsCapabilityService,
} from '../src'

function createCaptureContext(
  capture: (tokenId: string, service: object) => void,
): KernelModuleActivateContext {
  return {
    registerService<TService extends object>(
      token: CapabilityToken<TService>,
      service: TService,
    ) {
      capture(token.id, service)
      return { dispose() {} }
    },
  } as unknown as KernelModuleActivateContext
}

describe('office tools kernel module', () => {
  test('registers an immutable office tool collection', async () => {
    let service: OfficeToolsCapabilityService | undefined
    const module = createOfficeToolsKernelModule()

    await module.activate(
      createCaptureContext((tokenId, registered) => {
        expect(tokenId).toBe(OfficeToolsCapability.id)
        service = registered as OfficeToolsCapabilityService
      }),
    )

    expect(Object.isFrozen(service)).toBe(true)
    expect(Object.isFrozen(service?.tools)).toBe(true)
    expect(Object.keys(service?.tools ?? {})).not.toHaveLength(0)
    expect(module.manifest.permissions).toEqual([
      'fs:read',
      'fs:write',
      'process:exec',
    ])
  })

  test('executes injected office contexts with tool-level permissions and strict input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-office-callable-'))
    let service: OfficeToolsCapabilityService | undefined
    let resolverCalls = 0
    const module = createOfficeToolsKernelModule({
      resolveContext: async (_scope, signal) => {
        resolverCalls += 1
        return {
          abortSignal: signal,
          hasWorkspaceRoot: () => true,
          workspace: {
            getRootPath: () => root,
            runInDirectory: async <T>(
              _cwd: string,
              action: () => Promise<T>,
            ) => action(),
            prepareMutationWorkspace: async () => ({
              approved: true,
              rootPath: root,
            }),
          },
          system: {},
        } as unknown as OfficeToolContext
      },
    })

    try {
      await module.activate(
        createCaptureContext((_tokenId, registered) => {
          service = registered as OfficeToolsCapabilityService
        }),
      )
      expect(
        service?.getOperationMetadata('create_spreadsheet')?.permissions,
      ).toEqual(['fs:read', 'fs:write'])
      const declaredPermissions = new Set(module.manifest.permissions)
      expect(
        Object.values(service?.tools ?? {}).flatMap((tool) =>
          (service?.getOperationMetadata(tool.name ?? '')?.permissions ?? [])
            .filter((permission) => !declaredPermissions.has(permission))),
      ).toEqual([])
      expect(await service?.invoke(
        'create_spreadsheet',
        undefined,
        {
          outputPath: 'callable.xlsx',
          content: 'name,value\nA,1',
        },
        new AbortController().signal,
      )).toMatchObject({
        created: true,
        kind: 'xlsx',
      })
      expect(resolverCalls).toBe(1)
      await expect(service?.invoke(
        'create_spreadsheet',
        undefined,
        {
          outputPath: 'invalid.xlsx',
          content: 'a,b',
          unexpected: true,
        },
        new AbortController().signal,
      )).rejects.toThrow('Office capability input is invalid')
      expect(resolverCalls).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
