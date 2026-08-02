import { describe, expect, test } from 'bun:test'

import type {
  CapabilityToken,
  KernelModuleActivateContext,
} from '@velaros-ai/core/kernel/abi'
import { defaultDenyApprovalPort } from '@velaros-ai/core/tool-contract'

import type { ProjectToolContext } from '../src/agent/Types'
import {
  createProjectKernelModule,
  ProjectCapability,
  type ProjectCapabilityService,
} from '../src/index'

function captureService(
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

function projectContext(signal: AbortSignal): ProjectToolContext {
  return {
    abortSignal: signal,
    project: {
      getRootPath: () => '/project',
      runInDirectory: async (_path, action) => action(),
      kernel: async () => ({
        listFiles: async () => [],
      }) as never,
      runWithApproval: async (action) => action(),
      prepareMutation: async () => ({
        approved: false,
        rootPath: '/project',
        switched: false,
        alreadyAuthorized: false,
        rejectionMessage: 'denied',
        message: 'denied',
        authorizationScope: 'project',
      }),
      runCommand: async () => ({}) as never,
    },
    system: { canStartBackgroundCommands: () => false },
    approval: defaultDenyApprovalPort,
  }
}

describe('Project Kernel module', () => {
  test('registers only the six canonical project operations', async () => {
    let service: ProjectCapabilityService | undefined
    const module = createProjectKernelModule({
      resolveContext: (_scope, signal) => projectContext(signal),
    })
    await module.activate(captureService((tokenId, registered) => {
      expect(tokenId).toBe(ProjectCapability.id)
      service = registered as ProjectCapabilityService
    }))

    expect(module.manifest.id).toBe('velaros.project')
    expect(Object.keys(service?.tools ?? {})).toEqual([
      'project:read',
      'project:list',
      'project:search',
      'project:edit',
      'project:rollback',
      'project:run',
    ])
    expect(service?.getOperationMetadata('project:read')?.permissions)
      .toEqual(['fs:read'])
    expect(service?.getOperationMetadata('project:edit')?.permissions)
      .toEqual(['fs:read', 'fs:write'])
    await expect(service?.invoke(
      'project:list',
      undefined,
      { unexpected: true },
      new AbortController().signal,
    )).rejects.toThrow('Project capability input is invalid')
  })
})
