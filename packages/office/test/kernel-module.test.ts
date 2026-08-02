import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'
import JSZip from 'jszip'

import type {
  CapabilityToken,
  KernelModuleActivateContext,
} from '@velaros-ai/core/kernel/abi'

import {
  createOfficeKernelModule,
  OfficeCapability,
  type OfficeCapabilityService,
  type OfficeToolContext,
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
    let service: OfficeCapabilityService | undefined
    const module = createOfficeKernelModule()

    await module.activate(
      createCaptureContext((tokenId, registered) => {
        expect(tokenId).toBe(OfficeCapability.id)
        service = registered as OfficeCapabilityService
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
    let service: OfficeCapabilityService | undefined
    let resolverCalls = 0
    const module = createOfficeKernelModule({
      resolveContext: async (_scope, signal) => {
        resolverCalls += 1
        return {
          abortSignal: signal,
          office: {
            hasProjectRoot: () => true,
            project: {
              getRootPath: () => root,
              runInDirectory: async <T>(
                _cwd: string,
                action: () => Promise<T>,
              ) => action(),
              prepareMutation: async () => ({
                approved: true,
                rootPath: root,
                switched: false,
                alreadyAuthorized: true,
                rejectionMessage: null,
                message: 'approved',
              }),
            },
            system: {} as OfficeToolContext['office']['system'],
          },
        }
      },
    })

    try {
      await module.activate(
        createCaptureContext((_tokenId, registered) => {
          service = registered as OfficeCapabilityService
        }),
      )
      expect(
        service?.getOperationMetadata('office:create_spreadsheet')?.permissions,
      ).toEqual(['fs:read', 'fs:write'])
      const declaredPermissions = new Set(module.manifest.permissions)
      expect(
        Object.values(service?.tools ?? {}).flatMap((tool) =>
          (service?.getOperationMetadata(tool.name ?? '')?.permissions ?? [])
            .filter((permission) => !declaredPermissions.has(permission))),
      ).toEqual([])
      expect(await service?.invoke(
        'office:create_spreadsheet',
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
        'office:create_spreadsheet',
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

  test('renders standard document subtitle and date into the generated docx', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-office-standard-word-'))
    let service: OfficeCapabilityService | undefined
    const module = createOfficeKernelModule({
      resolveContext: async (_scope, signal) => ({
        abortSignal: signal,
        office: {
          hasProjectRoot: () => true,
          project: {
            getRootPath: () => root,
            runInDirectory: async <T>(_cwd: string, action: () => Promise<T>) => action(),
            prepareMutation: async () => ({
              approved: true,
              rootPath: root,
              switched: false,
              alreadyAuthorized: true,
              rejectionMessage: null,
              message: 'approved',
            }),
          },
          system: {} as OfficeToolContext['office']['system'],
        },
      }),
    })

    try {
      await module.activate(
        createCaptureContext((_tokenId, registered) => {
          service = registered as OfficeCapabilityService
        }),
      )
      await service?.invoke(
        'office:create_word_document',
        undefined,
        {
          outputPath: 'weekly.docx',
          title: '产品与工程周报',
          profile: 'standard',
          metadata: { subtitle: 'Host 网页链路实测', date: '2026-08-01' },
          blocks: [{ kind: 'paragraph', text: '正文' }],
          overwrite: true,
        },
        new AbortController().signal,
      )
      const archive = await JSZip.loadAsync(await readFile(join(root, 'weekly.docx')))
      const documentXml = await archive.file('word/document.xml')?.async('text')
      expect(documentXml).toContain('Host 网页链路实测')
      expect(documentXml).toContain('2026-08-01')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
