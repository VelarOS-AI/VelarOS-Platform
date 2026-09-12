import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { defaultDenyApprovalPort } from '@velaros-ai/agent/tool-contract'

import { projectTools } from '../src/agent/Project.tool'
import type { ProjectToolContext } from '../src/agent/Types'
import { createProjectKernel, type EditIntent } from '../src/index'
import { ProjectToolNames } from '../src/project-tool-names'
import { FileProjectTransactionStateStore } from '../src/transaction-state'

const Precious = 'precious\n'

async function withRoot(files: Record<string, string>, run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'velaros-project-create-safety-'))
  try {
    for (const [relative, content] of Object.entries(files)) await writeFile(join(root, relative), content)
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function createFile(path: string, content: string, overwrite?: boolean): EditIntent {
  return { operation: { type: 'create_file', path, content, ...(overwrite ? { overwrite } : {}) } }
}

async function exists(path: string): Promise<boolean> {
  return readFile(path).then(() => true, () => false)
}

// 覆盖、删除文本文件都能完整回滚，不是高风险事务：这里的内核都不装审批通道，一旦误判成高风险就会被拒。
describe('create_file 不静默覆盖、回滚不丢原文', () => {
  test('未开启 overwrite 时拒绝覆盖既有文件，且不写盘', async () => {
    await withRoot({ 'keep.txt': Precious }, async (root) => {
      const project = await createProjectKernel({ root })

      await expect(project.prepareEdit({ operations: [createFile('keep.txt', 'new\n')] })).rejects.toMatchObject({
        reason: 'CONFLICT_WITH_EXTERNAL_EDIT',
        details: { path: 'keep.txt' },
        suggestedNextAction: expect.stringContaining('overwrite'),
      })
      expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe(Precious)
    })
  })

  test('overwrite 覆盖既有文件记下原文，回滚写回原文而不是删除', async () => {
    await withRoot({ 'keep.txt': Precious }, async (root) => {
      const project = await createProjectKernel({ root })
      const transaction = await project.prepareEdit({ operations: [createFile('keep.txt', 'new\n', true)] })

      expect(transaction.risk).toBe('medium')
      expect(transaction.patches[0]).toMatchObject({ oldContent: Precious, metadata: { replacesExisting: true } })
      await project.applyEdit({ transactionId: transaction.transactionId })
      expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('new\n')

      await project.rollback({ transactionId: transaction.transactionId })
      expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe(Precious)
    })
  })

  test('新建文件回滚时删除', async () => {
    await withRoot({}, async (root) => {
      const project = await createProjectKernel({ root })
      const transaction = await project.prepareEdit({ operations: [createFile('fresh.txt', 'fresh\n')] })

      expect(transaction.risk).toBe('medium')
      expect(transaction.patches[0]?.metadata?.replacesExisting).toBe(false)
      await project.applyEdit({ transactionId: transaction.transactionId })
      expect(await readFile(join(root, 'fresh.txt'), 'utf8')).toBe('fresh\n')

      await project.rollback({ transactionId: transaction.transactionId })
      expect(await exists(join(root, 'fresh.txt'))).toBe(false)
    })
  })

  test('同事务先删除再创建同一路径视为新建，回滚恢复原文件', async () => {
    await withRoot({ 'keep.txt': Precious }, async (root) => {
      const project = await createProjectKernel({ root })
      const transaction = await project.prepareEdit({
        operations: [{ operation: { type: 'delete_file', path: 'keep.txt' } }, createFile('keep.txt', 'reborn\n')],
      })

      expect(transaction.patches[1]?.metadata?.replacesExisting).toBe(false)
      await project.applyEdit({ transactionId: transaction.transactionId })
      expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('reborn\n')

      await project.rollback({ transactionId: transaction.transactionId })
      expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe(Precious)
    })
  })

  test('同事务刚创建的文件视为已存在：可继续追加，再次 create 需 overwrite', async () => {
    await withRoot({}, async (root) => {
      const project = await createProjectKernel({ root })
      await expect(project.prepareEdit({
        operations: [createFile('notes.md', '# A\n'), createFile('notes.md', '# B\n')],
      })).rejects.toMatchObject({ reason: 'CONFLICT_WITH_EXTERNAL_EDIT', details: { path: 'notes.md' } })

      const transaction = await project.prepareEdit({
        operations: [
          createFile('notes.md', '# A\n'),
          { operation: { type: 'append_text', path: 'notes.md', text: 'body\n' } },
          createFile('notes.md', '# B\n', true),
          { operation: { type: 'append_text', path: 'notes.md', text: 'tail\n' } },
        ],
      })
      await project.applyEdit({ transactionId: transaction.transactionId })
      expect(await readFile(join(root, 'notes.md'), 'utf8')).toBe('# B\ntail\n')

      await project.rollback({ transactionId: transaction.transactionId })
      expect(await exists(join(root, 'notes.md'))).toBe(false)
    })
  })

  test('apply 前目标存在性或原文被外部改变时按 revision 冲突拒绝，不覆盖外部内容', async () => {
    await withRoot({ 'keep.txt': Precious }, async (root) => {
      const project = await createProjectKernel({ root })
      const creating = await project.prepareEdit({ operations: [createFile('late.txt', 'mine\n')] })
      const overwriting = await project.prepareEdit({ operations: [createFile('keep.txt', 'mine\n', true)] })
      await writeFile(join(root, 'late.txt'), 'external\n')
      await writeFile(join(root, 'keep.txt'), 'external edit\n')

      for (const transaction of [creating, overwriting]) {
        await expect(project.applyEdit({ transactionId: transaction.transactionId })).rejects.toMatchObject({
          reason: 'BASE_REVISION_MISMATCH',
        })
      }
      expect(await readFile(join(root, 'late.txt'), 'utf8')).toBe('external\n')
      expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('external edit\n')
    })
  })

  test('可恢复事务的回滚计划归属原文，中断的回滚在下次启动时还原', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'velaros-project-create-safety-durable-'))
    const root = join(directory, 'project')
    const statePath = join(directory, 'host-state', 'transactions.json')
    await mkdir(root)
    await writeFile(join(root, 'keep.txt'), Precious)

    // 记下回滚写盘前提交的那份状态：它就是回滚中途进程被杀时磁盘上留下的事务状态。
    let rollbackCommit: Parameters<FileProjectTransactionStateStore['commit']>[0] | undefined
    const originalCommit = FileProjectTransactionStateStore.prototype.commit
    FileProjectTransactionStateStore.prototype.commit = function (input) {
      if (input.pending?.kind === 'rollback') rollbackCommit = structuredClone(input)
      return originalCommit.call(this, input)
    }
    try {
      const project = await createProjectKernel({ root, transactionStatePath: statePath })
      const transaction = await project.prepareEdit({ operations: [createFile('keep.txt', 'new\n', true)] })
      await project.applyEdit({ transactionId: transaction.transactionId })
      await project.rollback({ transactionId: transaction.transactionId })
      expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe(Precious)
      expect(rollbackCommit?.pending?.restore).toEqual([
        { path: 'keep.txt', exists: true, content: 'new\n', ownedStates: [{ exists: true, content: Precious }] },
      ])

      // 模拟回滚已写回原文、但状态尚未提交就中断：下次 owner 启动把文件恢复到回滚前，而不是判成外部冲突。
      new FileProjectTransactionStateStore({ path: statePath, root }).commit(rollbackCommit!)
      const reopened = await createProjectKernel({ root, transactionStatePath: statePath })
      expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('new\n')

      await reopened.rollback({ transactionId: transaction.transactionId })
      expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe(Precious)
    } finally {
      FileProjectTransactionStateStore.prototype.commit = originalCommit
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('project:write 工具层', () => {
  function toolContext(root: string): ProjectToolContext {
    return {
      abortSignal: new AbortController().signal,
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

  test('mode=create 对已存在文件返回失败，原文不变', async () => {
    await withRoot({ 'keep.txt': Precious }, async (root) => {
      await expect(projectTools[ProjectToolNames.write].execute(
        { path: 'keep.txt', content: 'new\n', mode: 'create' },
        toolContext(root),
      )).rejects.toMatchObject({ reason: 'CONFLICT_WITH_EXTERNAL_EDIT', details: { path: 'keep.txt' } })
      expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe(Precious)
    })
  })
})
