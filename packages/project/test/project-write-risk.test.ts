import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { createProjectKernel, type EditIntent, type ProjectKernel } from '../src/index'
import type { ApprovalRequest } from '../src/types/policy'

// 风险按「能否恢复」划线：能完整回滚的覆盖、删除、重命名不打扰用户；
// 只有回滚恢复不了原文的写入（二进制或超限文件）才请宿主审批。
const Original = 'original\n'
const PngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])

interface RecordingKernel {
  project: ProjectKernel
  approvals: ApprovalRequest[]
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'velaros-project-write-risk-'))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** 装了审批通道的内核：记下每次审批请求，按 `approved` 作答。 */
async function recordingKernel(
  root: string,
  options: { approved?: boolean, maxFileSizeToReadBytes?: number } = {},
): Promise<RecordingKernel> {
  const approvals: ApprovalRequest[] = []
  const project = await createProjectKernel({
    root,
    ...(options.maxFileSizeToReadBytes ? { corePolicy: { maxFileSizeToReadBytes: options.maxFileSizeToReadBytes } } : {}),
    providers: {
      approval: {
        approve: (request) => {
          approvals.push(request)
          return options.approved ?? true
        },
      },
    },
  })
  return { project, approvals }
}

async function applyOperations(project: ProjectKernel, ...operations: Array<EditIntent['operation']>) {
  const transaction = await project.prepareEdit({ operations: operations.map((operation) => ({ operation })) })
  await project.applyEdit({ transactionId: transaction.transactionId })
  return transaction
}

async function exists(path: string): Promise<boolean> {
  return readFile(path).then(() => true, () => false)
}

describe('可完整回滚的写入不请求审批', () => {
  test('覆盖文本文件：medium，不审批，回滚写回原文', async () => {
    await withRoot(async (root) => {
      await writeFile(join(root, 'notes.md'), Original)
      const { project, approvals } = await recordingKernel(root)

      const transaction = await applyOperations(project, { type: 'create_file', path: 'notes.md', content: 'new\n', overwrite: true })

      expect(transaction.risk).toBe('medium')
      expect(approvals).toEqual([])
      await project.rollback({ transactionId: transaction.transactionId })
      expect(await readFile(join(root, 'notes.md'), 'utf8')).toBe(Original)
      expect(approvals).toEqual([])
    })
  })

  test('删除文本文件：low，不审批，回滚恢复原文', async () => {
    await withRoot(async (root) => {
      await writeFile(join(root, 'obsolete.ts'), Original)
      const { project, approvals } = await recordingKernel(root)

      const transaction = await applyOperations(project, { type: 'delete_file', path: 'obsolete.ts' })

      expect(transaction.risk).toBe('low')
      expect(approvals).toEqual([])
      expect(await exists(join(root, 'obsolete.ts'))).toBe(false)
      await project.rollback({ transactionId: transaction.transactionId })
      expect(await readFile(join(root, 'obsolete.ts'), 'utf8')).toBe(Original)
      expect(approvals).toEqual([])
    })
  })

  test('重命名文本文件：low，不审批，回滚搬回原路径', async () => {
    await withRoot(async (root) => {
      await writeFile(join(root, 'draft.md'), Original)
      const { project, approvals } = await recordingKernel(root)

      const transaction = await applyOperations(project, { type: 'rename_file', from: 'draft.md', to: 'final.md' })

      expect(transaction.risk).toBe('low')
      expect(approvals).toEqual([])
      expect(await readFile(join(root, 'final.md'), 'utf8')).toBe(Original)
      await project.rollback({ transactionId: transaction.transactionId })
      expect(await readFile(join(root, 'draft.md'), 'utf8')).toBe(Original)
      expect(await exists(join(root, 'final.md'))).toBe(false)
      expect(approvals).toEqual([])
    })
  })
})

describe('回滚恢复不了原文的写入仍是高风险', () => {
  test('覆盖二进制文件：high，请求审批；拒绝则不写盘', async () => {
    await withRoot(async (root) => {
      await writeFile(join(root, 'logo.png'), PngBytes)
      const { project, approvals } = await recordingKernel(root, { approved: false })
      const transaction = await project.prepareEdit({
        operations: [{ operation: { type: 'create_file', path: 'logo.png', content: 'text\n', overwrite: true } }],
      })

      expect(transaction.risk).toBe('high')
      expect(transaction.patches[0]?.oldContent).toBeUndefined()
      await expect(project.applyEdit({ transactionId: transaction.transactionId })).rejects.toMatchObject({
        reason: 'PERMISSION_DENIED',
      })
      expect(approvals).toMatchObject([{ action: 'apply_edit', risk: 'high', paths: ['logo.png'] }])
      expect(await readFile(join(root, 'logo.png'))).toEqual(PngBytes)
    })
  })

  test('删除二进制文件：high，审批后才删；回滚拒绝而不是写回空文件', async () => {
    await withRoot(async (root) => {
      await writeFile(join(root, 'logo.png'), PngBytes)
      const { project, approvals } = await recordingKernel(root)

      const transaction = await applyOperations(project, { type: 'delete_file', path: 'logo.png' })

      expect(transaction.risk).toBe('high')
      expect(transaction.patches[0]?.oldContent).toBeUndefined()
      expect(approvals).toMatchObject([{ action: 'apply_edit', risk: 'high', paths: ['logo.png'] }])
      expect(await exists(join(root, 'logo.png'))).toBe(false)
      await expect(project.rollback({ transactionId: transaction.transactionId })).rejects.toMatchObject({
        reason: 'PATCH_APPLY_ERROR',
      })
      expect(await exists(join(root, 'logo.png'))).toBe(false)
    })
  })

  test('覆盖或删除超出读取上限的文本文件：high，请求审批', async () => {
    await withRoot(async (root) => {
      await writeFile(join(root, 'big.log'), 'x'.repeat(64))
      await writeFile(join(root, 'huge.log'), 'y'.repeat(64))
      const { project, approvals } = await recordingKernel(root, { maxFileSizeToReadBytes: 16 })

      const overwritten = await applyOperations(project, { type: 'create_file', path: 'big.log', content: 'small\n', overwrite: true })
      const deleted = await applyOperations(project, { type: 'delete_file', path: 'huge.log' })

      expect([overwritten.risk, deleted.risk]).toEqual(['high', 'high'])
      expect(approvals.map((request) => request.paths)).toEqual([['big.log'], ['huge.log']])
    })
  })

  test('混入一个不可恢复补丁的事务整体是 high', async () => {
    await withRoot(async (root) => {
      await writeFile(join(root, 'notes.md'), Original)
      await writeFile(join(root, 'logo.png'), PngBytes)
      const { project, approvals } = await recordingKernel(root)

      const transaction = await applyOperations(
        project,
        { type: 'delete_file', path: 'notes.md' },
        { type: 'delete_file', path: 'logo.png' },
      )

      expect(transaction.risk).toBe('high')
      expect(approvals).toHaveLength(1)
    })
  })
})

describe('text patch 不做会丢数据的删除与重命名', () => {
  test('重命名二进制文件直接拒绝，原文件不动', async () => {
    await withRoot(async (root) => {
      await writeFile(join(root, 'logo.png'), PngBytes)
      const { project, approvals } = await recordingKernel(root)

      await expect(project.prepareEdit({
        operations: [{ operation: { type: 'rename_file', from: 'logo.png', to: 'brand.png' } }],
      })).rejects.toMatchObject({ reason: 'NOT_SUPPORTED', details: { path: 'logo.png', to: 'brand.png' } })
      expect(await readFile(join(root, 'logo.png'))).toEqual(PngBytes)
      expect(await exists(join(root, 'brand.png'))).toBe(false)
      expect(approvals).toEqual([])
    })
  })

  test('delete_file 作用于目录时直接拒绝，引导改用命令', async () => {
    await withRoot(async (root) => {
      await mkdir(join(root, 'dist'))
      await writeFile(join(root, 'dist', 'bundle.js'), Original)
      const { project, approvals } = await recordingKernel(root)

      await expect(project.prepareEdit({
        operations: [{ operation: { type: 'delete_file', path: 'dist' } }],
      })).rejects.toMatchObject({ reason: 'NOT_SUPPORTED', details: { path: 'dist' } })
      expect(await readFile(join(root, 'dist', 'bundle.js'), 'utf8')).toBe(Original)
      expect(approvals).toEqual([])
    })
  })
})
