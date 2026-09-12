import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { createProjectKernel, type EditIntent, type ProjectKernel } from '../src/index'
import { createNodeCommandProvider } from '../src/providers/index'
import type { CommandRunResult } from '../src/types/provider'

type Operation = EditIntent['operation']

let repository = ''

beforeEach(async () => {
  repository = await mkdtemp(join(tmpdir(), 'velaros-git-intent-to-add-'))
})

afterEach(async () => {
  await rm(repository, { recursive: true, force: true })
})

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repository, encoding: 'utf8' })
}

/** 建仓并按需提交一份基线；测试进程的全局 git 配置（签名、钩子）不参与。 */
async function initRepository(options: { committed?: Record<string, string> } = {}): Promise<void> {
  git('-c', 'init.defaultBranch=main', 'init', '-q')
  const committed = Object.entries(options.committed ?? {})
  for (const [relative, content] of committed) await writeFile(join(repository, relative), content)
  if (committed.length > 0) {
    git('add', '--', ...committed.map(([relative]) => relative))
    git(
      '-c', 'user.name=VelarOS',
      '-c', 'user.email=velaros@example.com',
      '-c', 'commit.gpgsign=false',
      '-c', 'core.hooksPath=/dev/null',
      'commit', '-q', '-m', 'baseline',
    )
  }
}

/** porcelain v1 状态行（稳定格式，路径相对仓库根）；关掉改名配对，逐路径断言。 */
function statusLines(): string[] {
  return git('status', '--porcelain', '--no-renames', '--untracked-files=all')
    .split('\n')
    .filter(Boolean)
    .sort()
}

function indexEntry(path: string): string {
  return git('ls-files', '--stage', '--', path).trim()
}

interface RecordingKernel {
  project: ProjectKernel
  gitCalls: string[][]
}

// 删除、重命名文本文件都能完整回滚，不需要宿主审批，所以不装审批通道；只记下每次 git 调用。
async function kernelAt(root: string): Promise<RecordingKernel> {
  const gitCalls: string[][] = []
  const node = createNodeCommandProvider()
  const project = await createProjectKernel({
    root,
    providers: {
      command: {
        async run(input): Promise<CommandRunResult> {
          if (input.command === 'git') gitCalls.push([...(input.args ?? [])])
          return node.run(input)
        },
      },
    },
  })
  return { project, gitCalls }
}

async function applyOperations(project: ProjectKernel, ...operations: Operation[]) {
  const transaction = await project.prepareEdit({ operations: operations.map((operation) => ({ operation })) })
  return project.applyEdit({ transactionId: transaction.transactionId })
}

const layouts = [
  { name: '已有提交的仓库', committed: { 'README.md': '# fixture\n' }, workspace: '' },
  { name: '尚无提交的仓库', committed: {}, workspace: '' },
  { name: '内核根是仓库子目录', committed: { 'README.md': '# fixture\n' }, workspace: 'packages/app' },
]

describe('apply 删除本内核新建过的文件后，索引不留 intent-to-add 残留', () => {
  for (const layout of layouts) {
    test(`新建再由另一个事务删除，git status 回到干净：${layout.name}`, async () => {
      await initRepository({ committed: layout.committed })
      const root = join(repository, layout.workspace)
      await mkdir(root, { recursive: true })
      const prefix = layout.workspace ? `${layout.workspace}/` : ''
      const { project } = await kernelAt(root)

      const created = await applyOperations(project, { type: 'create_file', path: 'scratch.txt', content: 'probe\n' })
      expect(created.gitTrackedFiles).toEqual(['scratch.txt'])
      expect(statusLines()).toEqual([` A ${prefix}scratch.txt`])

      const deleted = await applyOperations(project, { type: 'delete_file', path: 'scratch.txt' })
      expect(deleted.gitUntrackedFiles).toEqual(['scratch.txt'])
      expect(statusLines()).toEqual([])
      expect(indexEntry(`${prefix}scratch.txt`)).toBe('')
    })
  }

  test('用户真实暂存过的文件与已提交文件被删，索引项原样保留', async () => {
    await initRepository({ committed: { 'committed.txt': 'baseline\n' } })
    const { project } = await kernelAt(repository)
    await applyOperations(project, { type: 'create_file', path: 'kept.txt', content: 'kept\n' })
    git('add', '--', 'kept.txt')
    const stagedKept = indexEntry('kept.txt')
    const committed = indexEntry('committed.txt')

    const deleted = await applyOperations(
      project,
      { type: 'delete_file', path: 'kept.txt' },
      { type: 'delete_file', path: 'committed.txt' },
    )

    expect(deleted.gitUntrackedFiles).toBeUndefined()
    // 删除只落在工作区：kept.txt 的暂存内容还在（AD），committed.txt 没有被替用户暂存成删除（ D）。
    expect(statusLines()).toEqual([' D committed.txt', 'AD kept.txt'])
    expect(indexEntry('kept.txt')).toBe(stagedKept)
    expect(indexEntry('committed.txt')).toBe(committed)
  })

  test('rename_file：新路径挂上 intent-to-add，旧路径只在是 intent-to-add 时撤掉', async () => {
    await initRepository({ committed: { 'committed.txt': 'baseline\n' } })
    const { project } = await kernelAt(repository)
    await applyOperations(project, { type: 'create_file', path: 'draft.txt', content: 'draft\n' })

    const renamed = await applyOperations(
      project,
      { type: 'rename_file', from: 'draft.txt', to: 'final.txt' },
      { type: 'rename_file', from: 'committed.txt', to: 'moved.txt' },
    )

    expect(renamed.gitTrackedFiles).toEqual(['final.txt', 'moved.txt'])
    expect(renamed.gitUntrackedFiles).toEqual(['draft.txt'])
    expect(statusLines()).toEqual([' A final.txt', ' A moved.txt', ' D committed.txt'])
    expect(indexEntry('draft.txt')).toBe('')
  })

  test('同一事务里建了又删的文件不挂 intent-to-add，也不拖累同批其它新建文件', async () => {
    await initRepository()
    const { project } = await kernelAt(repository)

    const applied = await applyOperations(
      project,
      { type: 'create_file', path: 'transient.txt', content: 'gone\n' },
      { type: 'create_file', path: 'stays.txt', content: 'stays\n' },
      { type: 'delete_file', path: 'transient.txt' },
    )

    expect(applied.gitTrackedFiles).toEqual(['stays.txt'])
    expect(applied.gitUntrackedFiles).toBeUndefined()
    expect(statusLines()).toEqual([' A stays.txt'])
  })

  test('回滚删除事务：文件恢复，撤掉的 intent-to-add 一并挂回', async () => {
    await initRepository()
    const { project } = await kernelAt(repository)
    await applyOperations(project, { type: 'create_file', path: 'note.txt', content: 'note\n' })
    const deleted = await applyOperations(project, { type: 'delete_file', path: 'note.txt' })
    expect(statusLines()).toEqual([])

    const rolledBack = await project.rollback({ transactionId: deleted.transactionId })

    expect(rolledBack.gitTrackedFiles).toEqual(['note.txt'])
    expect(statusLines()).toEqual([' A note.txt'])
  })

  test('路径按字面匹配：名字像 glob 的文件不会连带撤掉用户暂存的文件', async () => {
    await initRepository()
    await writeFile(join(repository, 'staged.txt'), 'user work\n')
    git('add', '--', 'staged.txt')
    const staged = indexEntry('staged.txt')
    const { project } = await kernelAt(repository)

    await applyOperations(project, { type: 'create_file', path: '[s]taged.txt', content: 'probe\n' })
    const deleted = await applyOperations(project, { type: 'delete_file', path: '[s]taged.txt' })
    expect(deleted.gitUntrackedFiles).toEqual(['[s]taged.txt'])
    expect(indexEntry('staged.txt')).toBe(staged)

    // 回滚新建同样走字面路径：撤掉的只是回滚删掉的那个文件。
    const recreated = await applyOperations(project, { type: 'create_file', path: '[s]taged.txt', content: 'again\n' })
    await project.rollback({ transactionId: recreated.transactionId })
    expect(indexEntry('staged.txt')).toBe(staged)
    expect(statusLines()).toEqual(['A  staged.txt'])
  })

  test('非 git 目录：新建与删除都不写 git，也不生成 .git', async () => {
    const { project, gitCalls } = await kernelAt(repository)

    const created = await applyOperations(project, { type: 'create_file', path: 'scratch.txt', content: 'probe\n' })
    const deleted = await applyOperations(project, { type: 'delete_file', path: 'scratch.txt' })

    expect(created.gitTrackedFiles).toBeUndefined()
    expect(deleted.gitUntrackedFiles).toBeUndefined()
    // 针对具体路径的 git 命令都带 --literal-pathspecs；非 git 目录里一条都不该发出。
    expect(gitCalls.filter((args) => args.includes('--literal-pathspecs'))).toEqual([])
    expect(existsSync(join(repository, '.git'))).toBe(false)
  })
})
