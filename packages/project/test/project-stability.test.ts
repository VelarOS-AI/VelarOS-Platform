import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { defaultDenyApprovalPort } from '@velaros-ai/agent/tool-contract'
import { AppError } from '@velaros-ai/core/error'
import type {
  CapabilityToken,
  KernelModuleActivateContext,
} from '@velaros-ai/kernel/contracts/abi'

import type { ProjectToolContext } from '../src/agent/Types'
import {
  createProjectKernel,
  createProjectKernelModule,
  ProjectCapability,
  type ProjectCapabilityService,
  ProjectEditOperationSchema,
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

function projectContext(root: string, signal: AbortSignal): ProjectToolContext {
  return {
    abortSignal: signal,
    project: {
      getRootPath: () => root,
      runInDirectory: async (_path, action) => action(),
      kernel: async () => createProjectKernel({ root }),
      runWithApproval: async (action) => action(),
      prepareMutation: async () => ({
        approved: true,
        rootPath: root,
        switched: false,
        alreadyAuthorized: true,
        rejectionMessage: null,
        message: 'approved',
        authorizationScope: 'project',
      }),
      runCommand: async () => ({}) as never,
      queryCode: async () => ({}),
    },
    system: { canStartBackgroundCommands: () => false },
    approval: defaultDenyApprovalPort,
  }
}

describe('Project stability contracts', () => {
  test('serializes duplicate apply commands for the same transaction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-project-transaction-queue-'))
    try {
      const file = join(root, 'note.txt')
      await writeFile(file, 'before\n')
      const project = await createProjectKernel({ root })
      const transaction = await project.prepareEdit({
        operations: [{
          operation: {
            type: 'append_text',
            path: 'note.txt',
            text: 'after\n',
          },
        }],
      })

      const results = await Promise.allSettled([
        project.applyEdit({ transactionId: transaction.transactionId }),
        project.applyEdit({ transactionId: transaction.transactionId }),
      ])

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
      expect(await readFile(file, 'utf8')).toBe('before\nafter\n')
      expect((await project.status()).locks).toHaveLength(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('refuses rollback after an external edit without changing the file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-project-rollback-conflict-'))
    try {
      const file = join(root, 'note.txt')
      await writeFile(file, 'before\n')
      const project = await createProjectKernel({ root })
      const transaction = await project.prepareEdit({
        operations: [{
          operation: {
            type: 'replace_text',
            path: 'note.txt',
            oldText: 'before',
            newText: 'after',
          },
        }],
      })
      await project.applyEdit({ transactionId: transaction.transactionId })
      await writeFile(file, 'external\n')

      await expect(project.rollback({ transactionId: transaction.transactionId })).rejects.toMatchObject({
        reason: 'CONFLICT_WITH_EXTERNAL_EDIT',
        details: { path: 'note.txt' },
      })
      expect(await readFile(file, 'utf8')).toBe('external\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('checks path-specific base revisions before preparing patches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-project-base-revisions-'))
    try {
      const file = join(root, 'note.txt')
      await writeFile(file, 'before\n')
      const project = await createProjectKernel({ root })
      const read = await project.read({ path: 'note.txt' })
      await writeFile(file, 'external\n')

      await expect(project.prepareEdit({
        baseRevisions: { 'note.txt': read.snapshot.revision! },
        operations: [{
          operation: {
            type: 'replace_text',
            path: 'note.txt',
            oldText: 'external',
            newText: 'agent',
          },
        }],
      })).rejects.toMatchObject({
        reason: 'BASE_REVISION_MISMATCH',
        details: { path: 'note.txt', expected: read.snapshot.revision },
      })
      expect(await readFile(file, 'utf8')).toBe('external\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects ambiguous import mutations while keeping valid forms', () => {
    expect(ProjectEditOperationSchema.safeParse({
      type: 'add_import',
      path: 'src/a.ts',
    }).success).toBe(false)
    expect(ProjectEditOperationSchema.safeParse({
      type: 'add_import',
      path: 'src/a.ts',
      importStatement: "import { join } from 'node:path'",
      module: 'node:path',
    }).success).toBe(false)
    expect(ProjectEditOperationSchema.safeParse({
      type: 'add_import',
      path: 'src/a.ts',
      module: 'node:path',
      namespaceImport: 'path',
      named: ['join'],
    }).success).toBe(false)
    expect(ProjectEditOperationSchema.safeParse({
      type: 'remove_import',
      path: 'src/a.ts',
    }).success).toBe(false)
    expect(ProjectEditOperationSchema.safeParse({
      type: 'add_import',
      path: 'src/a.ts',
      module: 'node:path',
      named: ['join'],
    }).success).toBe(true)
    expect(ProjectEditOperationSchema.safeParse({
      type: 'remove_import',
      path: 'src/a.ts',
      module: 'node:path',
      name: 'join',
    }).success).toBe(true)
  })

  test('keeps validate, amend, apply, rollback, and re-apply lifecycle states consistent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-project-lifecycle-'))
    try {
      const file = join(root, 'note.txt')
      await writeFile(file, 'before\n')
      const project = await createProjectKernel({ root })
      const transaction = await project.prepareEdit({
        operations: [{
          operation: {
            type: 'replace_text',
            path: 'note.txt',
            oldText: 'before',
            newText: 'after',
          },
        }],
      })

      expect(project.getTransaction(transaction.transactionId)?.status).toBe('prepared')
      expect((await project.validate({ transactionId: transaction.transactionId })).ok).toBe(true)
      expect(project.getTransaction(transaction.transactionId)?.status).toBe('validated')

      await project.amendEdit({
        transactionId: transaction.transactionId,
        operations: [{
          operation: {
            type: 'append_text',
            path: 'note.txt',
            text: 'amended\n',
          },
        }],
      })
      expect(project.getTransaction(transaction.transactionId)?.status).toBe('prepared')

      await project.applyEdit({ transactionId: transaction.transactionId })
      expect(project.getTransaction(transaction.transactionId)?.status).toBe('applied')
      expect(await readFile(file, 'utf8')).toBe('after\namended\n')

      await project.rollback({ transactionId: transaction.transactionId })
      expect(project.getTransaction(transaction.transactionId)?.status).toBe('rolled_back')
      expect(await readFile(file, 'utf8')).toBe('before\n')

      await project.applyEdit({ transactionId: transaction.transactionId })
      expect(project.getTransaction(transaction.transactionId)?.status).toBe('applied')
      expect(await readFile(file, 'utf8')).toBe('after\namended\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('projects a stable Project error envelope through the Kernel capability', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-project-kernel-error-'))
    try {
      let service: ProjectCapabilityService | undefined
      const module = createProjectKernelModule({
        resolveContext: (_scope, signal) => projectContext(root, signal),
      })
      await module.activate(captureService((tokenId, registered) => {
        expect(tokenId).toBe(ProjectCapability.id)
        service = registered as ProjectCapabilityService
      }))

      let failure: unknown
      try {
        await service?.invoke(
          'project:edit',
          undefined,
          {
            operations: [{
              operation: {
                type: 'remove_import',
                path: 'src/a.ts',
              },
            }],
          },
          new AbortController().signal,
        )
      } catch (error) {
        failure = error
      }

      expect(failure).toBeInstanceOf(AppError)
      expect(failure).toMatchObject({
        code: 'INVALID_INPUT',
        context: {
          projectError: {
            name: 'ProjectError',
            reason: 'INVALID_INPUT',
            details: { detail: expect.any(String) },
            suggestedNextAction: '请根据工具 schema 修正参数后重试。',
          },
        },
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
