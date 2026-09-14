import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { defaultDenyApprovalPort } from '@velaros-ai/agent/tool-contract'
import type {
  CapabilityToken,
  KernelModuleActivateContext,
} from '@velaros-ai/kernel/contracts/abi'

import { finalizeProjectModelResult } from '../src/agent/presentation/source-window'
import type { ProjectToolContext } from '../src/agent/Types'
import {
  createProjectKernel,
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
      queryCode: async (input) => ({ action: input.action, source: 'built-in-test' }),
    },
    system: { canStartBackgroundCommands: () => false },
    approval: defaultDenyApprovalPort,
  }
}

describe('Project Kernel module', () => {
  test('registers the canonical Project operations including built-in code understanding', async () => {
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
      'project:file',
      'project:edit',
      'project:code',
      'project:change',
      'project:run',
    ])
    expect(service?.getOperationMetadata('project:read')?.permissions)
      .toEqual(['fs:read'])
    expect(service?.getOperationMetadata('project:edit')?.permissions)
      .toEqual(['fs:read', 'fs:write'])
    expect(service?.getOperationMetadata('project:file')?.permissions)
      .toEqual(['fs:read', 'fs:write'])
    await expect(service?.invoke(
      'project:code',
      undefined,
      { action: 'symbols', query: 'UserService' },
      new AbortController().signal,
    )).resolves.toMatchObject({ action: 'symbols', source: 'built-in-test' })
    await expect(service?.invoke(
      'project:list',
      undefined,
      { unexpected: true },
      new AbortController().signal,
    )).rejects.toThrow('Project capability input is invalid')
  })

  test('creates and edits through the governed Project capability boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-project-write-tool-'))
    try {
      const kernel = await createProjectKernel({ root })
      const context = projectContext(new AbortController().signal)
      context.codingSession = {}
      context.project.getRootPath = () => root
      context.project.kernel = async () => kernel
      context.project.prepareMutation = async () => ({
        approved: true,
        rootPath: root,
        switched: false,
        alreadyAuthorized: true,
        rejectionMessage: null,
        message: 'approved',
        authorizationScope: 'project',
      })

      let service: ProjectCapabilityService | undefined
      const module = createProjectKernelModule({ resolveContext: () => context })
      await module.activate(captureService((_tokenId, registered) => {
        service = registered as ProjectCapabilityService
      }))

      await service?.invoke('project:file', undefined, {
        actions: [{ op: 'create', path: 'reports/review.md', text: '# Review\n\nPassed.\n' }],
      }, new AbortController().signal)
      const observed = await service?.invoke('project:read', undefined, { path: 'reports/review.md' }, new AbortController().signal)
      const presented: any = await finalizeProjectModelResult(context, observed)
      await service?.invoke('project:edit', undefined, {
        files: [{ fileRef: presented.files[0].fileRef, edits: [{ op: 'insert', at: 'end', text: 'VELAR-WRITE-MARKER' }] }],
      }, new AbortController().signal)

      expect(await readFile(join(root, 'reports/review.md'), 'utf8')).toBe(
        '# Review\n\nPassed.\nVELAR-WRITE-MARKER\n'
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
