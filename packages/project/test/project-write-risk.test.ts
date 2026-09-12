import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { createProjectKernel, type EditIntent, type ProjectKernel, type ProjectPlugin } from '../src/index'
import { FileProjectTransactionStateStore, type ProjectTransactionPendingOperation } from '../src/transaction-state'
import type { ApprovalRequest } from '../src/types/policy'
import { encodeProjectTextBuffer } from '../src/utils/text'

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
  options: { approved?: boolean, maxFileSizeToReadBytes?: number, plugins?: ProjectPlugin[] } = {},
): Promise<RecordingKernel> {
  const approvals: ApprovalRequest[] = []
  const project = await createProjectKernel({
    root,
    ...(options.maxFileSizeToReadBytes ? { corePolicy: { maxFileSizeToReadBytes: options.maxFileSizeToReadBytes } } : {}),
    ...(options.plugins ? { plugins: options.plugins } : {}),
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

describe('读不到正文的文件上不做局部编辑', () => {
  test('超出读取上限的文本文件：append/prepend 直接拒绝，文件不被截断', async () => {
    await withRoot(async (root) => {
      const original = 'x'.repeat(64)
      await writeFile(join(root, 'big.log'), original)
      const { project, approvals } = await recordingKernel(root, { maxFileSizeToReadBytes: 16 })

      for (const operation of [
        { type: 'append_text', path: 'big.log', text: 'tail\n' },
        { type: 'prepend_text', path: 'big.log', text: 'head\n' },
        { type: 'replace_text', path: 'big.log', oldText: 'x', newText: 'y' },
      ] as const) {
        await expect(project.prepareEdit({ operations: [{ operation }] })).rejects.toMatchObject({
          reason: 'NOT_SUPPORTED',
          details: { path: 'big.log', size: 64, maxFileSizeToReadBytes: 16 },
        })
      }
      expect(await readFile(join(root, 'big.log'), 'utf8')).toBe(original)
      expect(approvals).toEqual([])
    })
  })

  test('内核兜底：插件策略凭空把原文当空串，编辑补丁同样被拒绝', async () => {
    await withRoot(async (root) => {
      const original = 'x'.repeat(64)
      await writeFile(join(root, 'big.log'), original)
      // 模拟一个不自觉的第三方策略：没有正文也照样按空串生成补丁。
      const blindAppend: ProjectPlugin = {
        name: 'blind-append',
        version: '0.0.0',
        setup: (context) => context.registerPatchStrategy({
          id: 'test.blind-append',
          priority: 100,
          canHandle: (input) => input.intent.operation.type === 'append_text',
          prepare: (input) => [{
            patchId: 'blind',
            strategyId: 'test.blind-append',
            path: input.snapshot!.path,
            baseRevision: input.snapshot!.revision,
            oldContent: '',
            newContent: 'tail\n',
            diff: '',
            changedLines: 1,
            risk: 'low',
            metadata: { op: 'append_text' },
          }],
        }),
      }
      const { project } = await recordingKernel(root, { maxFileSizeToReadBytes: 16, plugins: [blindAppend] })

      await expect(project.prepareEdit({
        operations: [{ operation: { type: 'append_text', path: 'big.log', text: 'tail\n' } }],
      })).rejects.toMatchObject({ reason: 'NOT_SUPPORTED', details: { path: 'big.log', strategyId: 'test.blind-append' } })
      expect(await readFile(join(root, 'big.log'), 'utf8')).toBe(original)
    })
  })
})

describe('删除与重命名按原样重建文件', () => {
  const Utf16Bytes = encodeProjectTextBuffer('hello\nworld\n', 'utf16le')
  const Gb18030Bytes = encodeProjectTextBuffer('中文注释\n第二行\n', 'gb18030')

  test('删除 UTF-16 文件：low，不审批，回滚按原编码逐字节恢复', async () => {
    await withRoot(async (root) => {
      await writeFile(join(root, 'legacy.txt'), Utf16Bytes)
      const { project, approvals } = await recordingKernel(root)

      const transaction = await applyOperations(project, { type: 'delete_file', path: 'legacy.txt' })
      expect(transaction.risk).toBe('low')
      await project.rollback({ transactionId: transaction.transactionId })

      expect(await readFile(join(root, 'legacy.txt'))).toEqual(Utf16Bytes)
      expect(approvals).toEqual([])
    })
  })

  test('重命名 GB18030 / UTF-16 文件：新路径保持原编码，回滚后原路径逐字节恢复', async () => {
    await withRoot(async (root) => {
      await writeFile(join(root, 'gbk.c'), Gb18030Bytes)
      await writeFile(join(root, 'wide.txt'), Utf16Bytes)
      const { project, approvals } = await recordingKernel(root)

      const transaction = await applyOperations(
        project,
        { type: 'rename_file', from: 'gbk.c', to: 'src/gbk.c' },
        { type: 'rename_file', from: 'wide.txt', to: 'wide-renamed.txt' },
      )
      expect(await readFile(join(root, 'src', 'gbk.c'))).toEqual(Gb18030Bytes)
      expect(await readFile(join(root, 'wide-renamed.txt'))).toEqual(Utf16Bytes)

      await project.rollback({ transactionId: transaction.transactionId })
      expect(await readFile(join(root, 'gbk.c'))).toEqual(Gb18030Bytes)
      expect(await readFile(join(root, 'wide.txt'))).toEqual(Utf16Bytes)
      expect(approvals).toEqual([])
    })
  })

  test('中断恢复：删除 UTF-16 文件的 apply 停在半路，下次启动按原编码重建', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'velaros-project-write-risk-durable-'))
    const root = join(directory, 'project')
    const statePath = join(directory, 'host-state', 'transactions.json')
    await mkdir(root)
    await writeFile(join(root, 'legacy.txt'), Utf16Bytes)
    const plans: ProjectTransactionPendingOperation[] = []
    const originalCommit = FileProjectTransactionStateStore.prototype.commit
    FileProjectTransactionStateStore.prototype.commit = function (input) {
      if (input.pending) plans.push(structuredClone(input.pending))
      return originalCommit.call(this, input)
    }
    try {
      const project = await createProjectKernel({ root, transactionStatePath: statePath })
      await applyOperations(project, { type: 'delete_file', path: 'legacy.txt' })
      const applyPlan = plans.find((plan) => plan.kind === 'apply')
      expect(applyPlan?.restore).toMatchObject([{ path: 'legacy.txt', exists: true, encoding: 'utf16le' }])

      // 磁盘上文件已删、事务状态仍停在 apply 的待恢复计划：下一次 owner 启动必须把文件原样还回来。
      // apply 落定前持久化的是 apply 之前的状态，那时还没有 appliedAt。
      const store = new FileProjectTransactionStateStore({ path: statePath, root })
      const snapshot = store.snapshot()
      store.commit({
        transactions: snapshot.transactions.map(({ appliedAt: _appliedAt, ...transaction }) => ({
          ...transaction,
          status: applyPlan!.previousStatus,
        })),
        projections: snapshot.projections,
        pending: applyPlan,
      })
      await createProjectKernel({ root, transactionStatePath: statePath })
      expect(await readFile(join(root, 'legacy.txt'))).toEqual(Utf16Bytes)
    } finally {
      FileProjectTransactionStateStore.prototype.commit = originalCommit
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('符号链接：删除链接是 high 并请求审批，回滚拒绝而不是把链接写成普通文件；重命名直接拒绝', async () => {
    await withRoot(async (root) => {
      await writeFile(join(root, 'target.md'), Original)
      await symlink('target.md', join(root, 'link.md'))
      const { project, approvals } = await recordingKernel(root)

      await expect(project.prepareEdit({
        operations: [{ operation: { type: 'rename_file', from: 'link.md', to: 'moved.md' } }],
      })).rejects.toMatchObject({ reason: 'NOT_SUPPORTED', details: { path: 'link.md', isSymbolicLink: true } })

      const transaction = await applyOperations(project, { type: 'delete_file', path: 'link.md' })
      expect(transaction.risk).toBe('high')
      expect(approvals).toMatchObject([{ action: 'apply_edit', risk: 'high', paths: ['link.md'] }])
      expect(await exists(join(root, 'link.md'))).toBe(false)
      await expect(project.rollback({ transactionId: transaction.transactionId })).rejects.toMatchObject({
        reason: 'PATCH_APPLY_ERROR',
      })
      expect(await readFile(join(root, 'target.md'), 'utf8')).toBe(Original)
    })
  })

  test('透过符号链接覆盖目标文件仍可完整回滚：不审批，链接保留', async () => {
    await withRoot(async (root) => {
      await writeFile(join(root, 'target.md'), Original)
      await symlink('target.md', join(root, 'link.md'))
      const { project, approvals } = await recordingKernel(root)

      const transaction = await applyOperations(project, { type: 'create_file', path: 'link.md', content: 'new\n', overwrite: true })
      expect(transaction.risk).toBe('medium')
      await project.rollback({ transactionId: transaction.transactionId })

      expect((await lstat(join(root, 'link.md'))).isSymbolicLink()).toBe(true)
      expect(await readFile(join(root, 'target.md'), 'utf8')).toBe(Original)
      expect(approvals).toEqual([])
    })
  })
})
