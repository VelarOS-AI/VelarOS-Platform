import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadImage } from '@napi-rs/canvas'
import { describe, expect, test } from 'bun:test'
import JSZip from 'jszip'
import { PDFDocument, StandardFonts } from 'pdf-lib'

import type {
  CapabilityToken,
  KernelModuleActivateContext,
} from '@velaros-ai/kernel/contracts/abi'

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
      expect(
        service?.getOperationMetadata('office:extract_pdf_text')?.permissions,
      ).toEqual(['fs:read'])
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

  test('extracts only requested PDF pages with bounded read-only metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-office-pdf-text-'))
    let service: OfficeCapabilityService | undefined
    const module = createOfficeKernelModule({
      resolveContext: async (_scope, signal) => ({
        abortSignal: signal,
        office: {
          hasProjectRoot: () => true,
          project: {
            getRootPath: () => root,
            runInDirectory: async <T>(_cwd: string, action: () => Promise<T>) => action(),
            prepareMutation: async () => {
              throw new Error('read-only PDF extraction must not request mutation approval')
            },
          },
          system: {} as OfficeToolContext['office']['system'],
        },
      }),
    })

    try {
      const document = await PDFDocument.create()
      const font = await document.embedFont(StandardFonts.Helvetica)
      for (const marker of ['PAGE_ONE_MARKER', 'PAGE_TWO_MARKER', 'PAGE_THREE_MARKER']) {
        const page = document.addPage([400, 300])
        page.drawText(marker, { x: 40, y: 240, size: 18, font })
      }
      await writeFile(join(root, 'source.pdf'), await document.save())

      await module.activate(
        createCaptureContext((_tokenId, registered) => {
          service = registered as OfficeCapabilityService
        }),
      )
      const result = await service?.invoke(
        'office:extract_pdf_text',
        undefined,
        { inputPath: 'source.pdf', pages: [2, 2] },
        new AbortController().signal,
      ) as {
        pageCount?: number
        pages?: Array<{ page: number; text: string }>
        hasMore?: boolean
      }

      expect(result.pageCount).toBe(3)
      expect(result.pages).toEqual([{ page: 2, text: 'PAGE_TWO_MARKER' }])
      expect(result.hasMore).toBe(true)
      await expect(service?.invoke(
        'office:extract_pdf_text',
        undefined,
        { inputPath: 'source.pdf', pages: [4] },
        new AbortController().signal,
      )).rejects.toThrow('超出有效范围 1-3')
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

  test('returns bounded preview content so callers can verify document body text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-office-preview-content-'))
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
          outputPath: 'preview-source.docx',
          title: 'Preview source',
          content: 'VELAR_OFFICE_PREVIEW_BODY_MARKER',
        },
        new AbortController().signal,
      )
      const preview = await service?.invoke(
        'office:preview_document',
        undefined,
        { inputPath: 'preview-source.docx' },
        new AbortController().signal,
      ) as { preview?: { contentHtml?: string; contentTruncated?: boolean } }

      expect(preview.preview?.contentHtml).toContain('VELAR_OFFICE_PREVIEW_BODY_MARKER')
      expect(preview.preview?.contentTruncated).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('renders a spreadsheet preview directly to a portable PNG artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-office-preview-png-'))
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
        'office:create_spreadsheet',
        undefined,
        {
          outputPath: 'kpi.xlsx',
          sheets: [{ name: 'KPI', rows: [['指标', '本月'], ['可用率', '99.9%'], ['缺陷数', 3]] }],
        },
        new AbortController().signal,
      )
      const preview = await service?.invoke(
        'office:preview_document',
        undefined,
        { inputPath: 'kpi.xlsx', outputPath: 'preview.png' },
        new AbortController().signal,
      ) as { previewArtifact?: { kind?: string; width?: number; height?: number } }

      expect(preview.previewArtifact).toMatchObject({
        kind: 'png',
        width: 1200,
      })
      expect(preview.previewArtifact?.height).toBeGreaterThanOrEqual(420)
      const image = await loadImage(await readFile(join(root, 'preview.png')))
      expect(image.width).toBe(1200)
      expect(image.height).toBe(preview.previewArtifact?.height)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
