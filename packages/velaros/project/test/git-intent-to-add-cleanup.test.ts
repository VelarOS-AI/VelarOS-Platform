import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { NodeCommandProvider } from '../impl/kernel/NodeCommandProvider'
import { createProjectKernel, type EditIntent, type ProjectKernel } from '../index'
import type { CommandRunInput, CommandRunResult, ProjectRuntimeProviders } from '../types/provider'

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
      '-c',
      'user.name=VelarOS',
      '-c',
      'user.email=velaros@example.com',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-q',
      '-m',
      'baseline'
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
async function kernelAt(
  root: string,
  intercept?: (
    input: CommandRunInput
  ) => Promise<CommandRunResult | undefined> | CommandRunResult | undefined,
  logger?: ProjectRuntimeProviders['logger']
): Promise<RecordingKernel> {
  const gitCalls: string[][] = []
  const node = new NodeCommandProvider()
  const project = await createProjectKernel({
    root,
    providers: {
      logger,
      command: {
        async run(input): Promise<CommandRunResult> {
          if (input.command === 'git') gitCalls.push([...(input.args ?? [])])
          return (await intercept?.(input)) ?? node.run(input)
        },
      },
    },
  })
  return { project, gitCalls }
}

async function applyOperations(project: ProjectKernel, ...operations: Operation[]) {
  const transaction = await project.prepareEdit({
    operations: operations.map((operation) => ({ operation })),
  })
  return project.applyEdit({ transactionId: transaction.transactionId })
}

const layouts = [
  { name: '已有提交的仓库', committed: { 'README.md': '# fixture\n' }, workspace: '' },
  { name: '尚无提交的仓库', committed: {}, workspace: '' },
  {
    name: '内核根是仓库子目录',
    committed: { 'README.md': '# fixture\n' },
    workspace: 'packages/app',
  },
]

describe('apply 删除本内核新建过的文件后，索引不留 intent-to-add 残留', () => {
  for (const layout of layouts) {
    test(`新建再由另一个事务删除，git status 回到干净：${layout.name}`, async () => {
      await initRepository({ committed: layout.committed })
      const root = join(repository, layout.workspace)
      await mkdir(root, { recursive: true })
      const prefix = layout.workspace ? `${layout.workspace}/` : ''
      const { project } = await kernelAt(root)

      const created = await applyOperations(project, {
        type: 'create_file',
        path: 'scratch.txt',
        content: 'probe\n',
      })
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
      { type: 'delete_file', path: 'committed.txt' }
    )

    expect(deleted.gitUntrackedFiles).toBeUndefined()
    // 删除只落在工作区：kept.txt 的暂存内容还在（AD），committed.txt 没有被替用户暂存成删除（ D）。
    expect(statusLines()).toEqual([' D committed.txt', 'AD kept.txt'])
    expect(indexEntry('kept.txt')).toBe(stagedKept)
    expect(indexEntry('committed.txt')).toBe(committed)
  })

  test('回滚新建只撤当前 ITA，保留用户普通暂存、空文件暂存和已提交条目', async () => {
    await initRepository({ committed: { 'README.md': 'baseline\n' } })
    const { project } = await kernelAt(repository)
    const created = await applyOperations(
      project,
      ...[
        ['owned.txt', 'task\n'],
        ['owned-empty.txt', ''],
        ['staged.txt', 'user\n'],
        ['staged-empty.txt', ''],
        ['committed.txt', 'committed\n'],
      ].map(([path, content]): Operation => ({
        type: 'create_file',
        path: path!,
        content: content!,
      }))
    )
    git('add', '--', 'staged.txt', 'staged-empty.txt')
    // 空 ITA 与正常暂存空文件的 blob 相同；撤索引必须核 ITA 身份。
    expect(indexEntry('owned-empty.txt').split(' ')[1]).toBe(
      indexEntry('staged-empty.txt').split(' ')[1]
    )
    git(
      '-c',
      'user.name=VelarOS',
      '-c',
      'user.email=velaros@example.com',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-q',
      '-m',
      'user commit',
      '--only',
      '--',
      'committed.txt'
    )
    const saved = new Map(
      ['staged.txt', 'staged-empty.txt', 'committed.txt'].map((path) => [path, indexEntry(path)])
    )

    const rolledBack = await project.rollback({ transactionId: created.transactionId })
    expect(rolledBack.gitUntrackedFiles).toEqual(['owned.txt', 'owned-empty.txt'])
    expect(indexEntry('owned.txt')).toBe('')
    expect(indexEntry('owned-empty.txt')).toBe('')
    for (const [path, entry] of saved) expect(indexEntry(path)).toBe(entry)
  })

  test('ITA 判定到发布持有 canonical 索引锁，竞争暂存和他人锁都不被覆盖', async () => {
    await initRepository()
    let raced = false
    const lockPath = join(repository, '.git', 'index.lock')
    const { project } = await kernelAt(repository, async (input) => {
      if (!raced && input.args?.includes('--ita-invisible-in-index')) {
        raced = true
        await writeFile(join(repository, 'user-race.txt'), 'user work\n')
        const competing = spawnSync('git', ['add', '--', 'user-race.txt'], {
          cwd: repository,
          encoding: 'utf8',
          timeout: 5_000,
          windowsHide: true,
        })
        expect(competing.error).toBeUndefined()
        expect(competing.status).not.toBe(0)
        expect(competing.stderr).toContain('index.lock')
      }
      return undefined
    })
    const created = await applyOperations(project, {
      type: 'create_file',
      path: 'race.txt',
      content: 'task\n',
    })
    const rolledBack = await project.rollback({ transactionId: created.transactionId })
    expect(raced).toBe(true)
    expect(rolledBack.gitUntrackedFiles).toEqual(['race.txt'])
    expect(existsSync(lockPath)).toBe(false)
    // 释放锁后用户能正常暂存，文件内容仍是自己的原文。
    git('add', '--', 'user-race.txt')
    expect(git('show', ':user-race.txt')).toBe('user work\n')

    const blocked = await applyOperations(project, {
      type: 'create_file',
      path: 'blocked.txt',
      content: 'task\n',
    })
    const before = indexEntry('blocked.txt')
    await writeFile(lockPath, 'another owner', { flag: 'wx' })
    try {
      expect(
        (await project.rollback({ transactionId: blocked.transactionId })).gitUntrackedFiles
      ).toBeUndefined()
      expect(await readFile(lockPath, 'utf8')).toBe('another owner')
      expect(indexEntry('blocked.txt')).toBe(before)
    } finally {
      await unlink(lockPath)
    }
  })

  test('私有 env 被忽略或执行超时都不发布索引，超时私有文件保留诊断', async () => {
    await initRepository()
    for (const mode of ['ignored-env', 'timeout', 'timeout-logger-throws'] as const) {
      let privateIndex = ''
      const warnings: string[] = []
      const { project } = await kernelAt(
        repository,
        (input) => {
          if (input.env?.GIT_INDEX_FILE) {
            privateIndex = input.env.GIT_INDEX_FILE
            if (mode === 'ignored-env') delete input.env
            else return { exitCode: 0, stdout: '', stderr: 'fixture timeout', timedOut: true }
          }
          return undefined
        },
        mode === 'timeout-logger-throws'
          ? {
              warn(event) {
                warnings.push(event)
                throw new Error('fixture logger failure')
              },
            }
          : undefined
      )
      const path = `${mode}.txt`
      const created = await applyOperations(project, {
        type: 'create_file',
        path,
        content: 'task\n',
      })
      const before = indexEntry(path)
      expect(
        (await project.rollback({ transactionId: created.transactionId })).gitUntrackedFiles
      ).toBeUndefined()
      expect(indexEntry(path)).toBe(before)
      expect(existsSync(join(repository, '.git', 'index.lock'))).toBe(false)
      expect(privateIndex).not.toBe('')
      expect(existsSync(privateIndex)).toBe(mode !== 'ignored-env')
      expect(existsSync(`${privateIndex}.diagnostic.json`)).toBe(mode !== 'ignored-env')
      if (mode === 'timeout-logger-throws') {
        expect(warnings).toContain('project.git.untrackCreatedFiles.failed')
        expect(warnings).toContain('project.git.privateIndex.retained')
        const diagnostic = JSON.parse(await readFile(`${privateIndex}.diagnostic.json`, 'utf8'))
        expect(diagnostic.error).toContain('fixture timeout')
      }
    }
  })

  test('rename_file：新路径挂上 intent-to-add，旧路径只在是 intent-to-add 时撤掉', async () => {
    await initRepository({ committed: { 'committed.txt': 'baseline\n' } })
    const { project } = await kernelAt(repository)
    await applyOperations(project, { type: 'create_file', path: 'draft.txt', content: 'draft\n' })

    const renamed = await applyOperations(
      project,
      { type: 'rename_file', from: 'draft.txt', to: 'final.txt' },
      { type: 'rename_file', from: 'committed.txt', to: 'moved.txt' }
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
      { type: 'delete_file', path: 'transient.txt' }
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

    await applyOperations(project, {
      type: 'create_file',
      path: '[s]taged.txt',
      content: 'probe\n',
    })
    const deleted = await applyOperations(project, { type: 'delete_file', path: '[s]taged.txt' })
    expect(deleted.gitUntrackedFiles).toEqual(['[s]taged.txt'])
    expect(indexEntry('staged.txt')).toBe(staged)

    // 回滚新建同样走字面路径：撤掉的只是回滚删掉的那个文件。
    const recreated = await applyOperations(project, {
      type: 'create_file',
      path: '[s]taged.txt',
      content: 'again\n',
    })
    await project.rollback({ transactionId: recreated.transactionId })
    expect(indexEntry('staged.txt')).toBe(staged)
    expect(statusLines()).toEqual(['A  staged.txt'])
  })

  test('非 git 目录：新建与删除都不写 git，也不生成 .git', async () => {
    const { project, gitCalls } = await kernelAt(repository)

    const created = await applyOperations(project, {
      type: 'create_file',
      path: 'scratch.txt',
      content: 'probe\n',
    })
    const deleted = await applyOperations(project, { type: 'delete_file', path: 'scratch.txt' })

    expect(created.gitTrackedFiles).toBeUndefined()
    expect(deleted.gitUntrackedFiles).toBeUndefined()
    // 针对具体路径的 git 命令都带 --literal-pathspecs；非 git 目录里一条都不该发出。
    expect(gitCalls.filter((args) => args.includes('--literal-pathspecs'))).toEqual([])
    expect(existsSync(join(repository, '.git'))).toBe(false)
  })
})
