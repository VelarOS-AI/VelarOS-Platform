/**
 * 事务与 git 索引的衔接：`ProjectGitIndex`。接口 `ProjectGitIndexApi` 在本文件的类上方。
 */
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { copyFile, lstat, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import { isEmpty, isPresent, Log } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { CommandRunResult, ProjectRuntimeProviders } from '../../types/provider.js'
import { IntentToAddProbeArgs, selectIntentToAddPaths } from '../../utils/files/git-index.js'
import { ProjectTuning } from '../../utils/tuning.js'

/**
 * 让事务新建、删除的文件在 git 里看得见：应用时给新建文件挂 intent-to-add（`git add -N`，只进 diff 视野、不暂存内容），
 * 回滚时撤掉；被删路径上只剩 intent-to-add 的条目一并撤掉。项目根不在 git 工作区里时什么都不做。
 * git 失败只记告警、返回空，永远不动用户真实暂存的内容。实例归一个内核所有。
 */
export interface ProjectGitIndexApi {
  /** 给还在的新建文件挂 intent-to-add；返回挂上的路径，git 失败或不在 git 工作区里时返回空。 */
  trackCreatedFilesInGit(paths: string[]): Promise<string[]>
  /** 回滚新建时只撤当前仍是 intent-to-add 的条目；用户已暂存或已提交则保留。返回撤掉的路径，失败返回空。 */
  untrackCreatedFilesFromGit(paths: string[]): Promise<string[]>
  /** 被删路径在索引里只剩 intent-to-add 条目时把条目撤掉；带真实内容的索引项不动。返回撤掉的路径，失败返回空。 */
  untrackDeletedIntentToAddFromGit(paths: string[]): Promise<string[]>
}

/** git 索引衔接要内核交进来的东西。 */
export interface ProjectGitIndexDependencies {
  /** 工作区根目录的绝对路径，git 命令在这里跑。 */
  readonly root: string
  /** 宿主提供者：跑 git 用的命令提供者，记告警用的日志。 */
  readonly providers: Pick<ProjectRuntimeProviders, 'command' | 'logger'>
}

export class ProjectGitIndex implements ProjectGitIndexApi {
  private gitWorkTreeCache?: boolean
  constructor(private readonly dependencies: ProjectGitIndexDependencies) {}

  private async runGit(
    args: string[],
    timeoutMs: number = ProjectTuning.files.gitTimeoutMs,
    env?: Record<string, string | undefined>
  ) {
    return this.dependencies.providers.command.run({
      command: 'git',
      args,
      cwd: this.dependencies.root,
      timeoutMs,
      env,
    })
  }

  /** 宿主诊断失败交给 Core 的隔离日志口，原始 Git/IO 事实仍保留，不能中断资源释放。 */
  private warn(event: string, data: Record<string, unknown>): void {
    try {
      this.dependencies.providers.logger?.warn?.(event, data)
    } catch (loggerFailure) {
      Log.tag('ProjectGitIndex').warn(event, { ...data, loggerFailure })
    }
  }

  /**
   * 对内核给出的具体文件路径跑 git 子命令。`--literal-pathspecs` 让路径只按字面匹配：否则名为
   * `[s]taged.txt` 的文件会被当成 glob，连带命中用户真实暂存的 `staged.txt`，`git rm --cached`
   * 就把它一起移出索引。
   */
  private async runGitOnPaths(args: readonly string[], paths: readonly string[]) {
    return this.runGit(['--literal-pathspecs', ...args, '--', ...paths])
  }

  private async isInsideGitWorkTree(): Promise<boolean> {
    // 工作区根目录的 git 仓库归属在会话内是恒定的；缓存结果避免每次 apply/rollback 都新起 git 子进程。
    if (isPresent(this.gitWorkTreeCache)) return this.gitWorkTreeCache
    const result = await this.runGit(
      ['rev-parse', '--is-inside-work-tree'],
      ProjectTuning.files.gitProbeTimeoutMs
    )
    this.gitWorkTreeCache =
      result.exitCode === 0 &&
      !result.truncated &&
      !result.timedOut &&
      result.stdout.trim() === 'true'
    return this.gitWorkTreeCache
  }

  public async trackCreatedFilesInGit(paths: string[]): Promise<string[]> {
    const files = [...new Set(paths)].filter(Boolean)
    if (isEmpty(files) || !(await this.isInsideGitWorkTree())) return []
    // intent-to-add 让新建文件进入 git diff 视野，但不会暂存文件内容。
    const result = await this.runGitOnPaths(['add', '--intent-to-add'], files)
    if (result.exitCode === 0) return files
    this.warn('project.git.trackCreatedFiles.failed', {
      files,
      stderr: result.stderr,
    })
    return []
  }

  public async untrackCreatedFilesFromGit(paths: string[]): Promise<string[]> {
    return this.untrackIntentToAdd(paths, 'project.git.untrackCreatedFiles.failed')
  }

  /**
   * 被删路径在索引里若只剩 intent-to-add 条目，就把条目撤掉，否则 `git status` 会留下一条删除残留。
   * 带真实内容的索引项（用户 `git add` 过的、已提交的）一律不动：索引照旧，删除留在工作区等用户处理。
   */
  public async untrackDeletedIntentToAddFromGit(paths: string[]): Promise<string[]> {
    return this.untrackIntentToAdd(paths, 'project.git.untrackDeletedIntentToAdd.failed')
  }

  /** 在 Git 的索引锁内只删除当前仍为 ITA 的条目；私有索引成功后原子发布，不恢复历史索引。 */
  private async untrackIntentToAdd(paths: string[], event: string): Promise<string[]> {
    const files = [...new Set(paths)].filter(Boolean)
    if (isEmpty(files)) return []
    const token = randomUUID()
    let lock: FileHandle | undefined
    let lockPath = ''
    let privateIndex = ''
    let ownsPrivateIndex = false
    let privateCommandUnsettled = false
    let failure: unknown
    try {
      if (!(await this.isInsideGitWorkTree())) return []
      const located = await this.runGit(
        ['rev-parse', '--path-format=absolute', '--git-path', 'index'],
        ProjectTuning.files.gitProbeTimeoutMs
      )
      if (located.exitCode !== 0 || located.truncated || located.timedOut)
        throw new AppError('UNAVAILABLE', '无法完整解析 Git 索引路径')
      const locatedPath = located.stdout.endsWith('\n')
        ? located.stdout.slice(0, -1)
        : located.stdout
      if (!isAbsolute(locatedPath) || /[\0\r\n]/u.test(locatedPath))
        throw new AppError('VALIDATION', 'Git 索引路径必须是绝对路径')
      const index = resolve(locatedPath)
      const directory = dirname(index)
      const name = basename(index)
      lockPath = join(directory, `${name}.lock`)
      privateIndex = join(directory, `${name}.velaros-${token}`)
      const privateFiles = [privateIndex, `${privateIndex}.lock`, `${privateIndex}.diagnostic.json`]
      if (
        !name ||
        dirname(lockPath) !== directory ||
        basename(lockPath) !== `${name}.lock` ||
        privateFiles.some(
          (file) =>
            dirname(file) !== directory || !basename(file).startsWith(`${name}.velaros-${token}`)
        )
      )
        throw new AppError('INVARIANT', 'Git 索引临时文件越出索引父目录')
      lock = await open(lockPath, 'wx')
      await lock.writeFile(token, 'utf8')
      if (!(await lstat(index)).isFile()) throw new AppError('VALIDATION', 'Git 索引必须是普通文件')
      const existingPrivateLock = await lstat(`${privateIndex}.lock`).catch((error: unknown) => {
        if ((error as { code?: string }).code === 'ENOENT') return undefined
        throw error
      })
      if (existingPrivateLock) throw new AppError('CONFLICT', 'Git 私有索引锁已经存在')
      await copyFile(index, privateIndex, constants.COPYFILE_EXCL)
      ownsPrivateIndex = true

      const runPrivate = async (args: string[]): Promise<CommandRunResult> => {
        // 自定义 provider 超时/抛错不保证进程已退出；不能删除仍可能被它占用的私有索引。
        privateCommandUnsettled = true
        const result = await this.runGit(args, ProjectTuning.files.gitTimeoutMs, {
          GIT_INDEX_FILE: privateIndex,
          GIT_OPTIONAL_LOCKS: '0',
        })
        privateCommandUnsettled = !!result.timedOut
        if (result.exitCode !== 0 || result.truncated || result.timedOut)
          throw new AppError('UNAVAILABLE', `Git 私有索引操作失败：${result.stderr}`)
        return result
      }
      const visible = await runPrivate([
        '--literal-pathspecs',
        ...IntentToAddProbeArgs,
        '--ita-visible-in-index',
        '--',
        ...files,
      ])
      const invisible = await runPrivate([
        '--literal-pathspecs',
        ...IntentToAddProbeArgs,
        '--ita-invisible-in-index',
        '--',
        ...files,
      ])
      const intentToAddFiles = selectIntentToAddPaths(files, visible.stdout, invisible.stdout)
      if (isEmpty(intentToAddFiles)) return []
      // provider 若忽略 env，真实 Git 会因 canonical index.lock 拒绝写入，不能发布私有副本。
      await runPrivate([
        '--literal-pathspecs',
        'rm',
        '--cached',
        '--ignore-unmatch',
        '--',
        ...intentToAddFiles,
      ])
      if ((await readFile(lockPath, 'utf8')) !== token)
        throw new AppError('CONFLICT', 'Git 索引锁的所有权已变化')
      await rename(privateIndex, index)
      return intentToAddFiles
    } catch (error) {
      failure = error
      this.warn(event, { files, error })
      return []
    } finally {
      if (ownsPrivateIndex) {
        if (privateCommandUnsettled) {
          const diagnostic = {
            token,
            privateIndex,
            files,
            error: AppError.getMessage(failure),
            reason: '私有 Git 进程尚未证明物理结束，保留索引及其锁供核对',
          }
          await writeFile(`${privateIndex}.diagnostic.json`, JSON.stringify(diagnostic), {
            flag: 'wx',
          }).catch((error: unknown) => {
            this.warn('project.git.privateIndex.diagnostic.failed', { privateIndex, error })
          })
          this.warn('project.git.privateIndex.retained', diagnostic)
        } else {
          for (const file of [`${privateIndex}.lock`, privateIndex])
            await unlink(file).catch((error: unknown) => {
              if ((error as { code?: string }).code !== 'ENOENT')
                this.warn('project.git.privateIndex.cleanup.failed', { file, error })
            })
        }
      }
      if (lock) {
        await lock.close().catch((error: unknown) => {
          this.warn('project.git.indexLock.close.failed', { lockPath, error })
        })
        const owner = await readFile(lockPath, 'utf8').catch((error: unknown) => {
          if ((error as { code?: string }).code !== 'ENOENT')
            this.warn('project.git.indexLock.owner.failed', { lockPath, error })
          return undefined
        })
        if (owner === token)
          await unlink(lockPath).catch((error: unknown) => {
            this.warn('project.git.indexLock.cleanup.failed', { lockPath, error })
          })
      }
    }
  }
}
