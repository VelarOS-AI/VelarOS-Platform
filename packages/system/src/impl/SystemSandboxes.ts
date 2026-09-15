/**
 * 演练沙箱：`SystemSandboxes`。接口 `SystemSandboxesApi` 与构造参数 `SystemSandboxesOptions` 在本文件的类上方。
 * 登记每个沙箱和它专属的命令执行器（约束钉死在镜像根），镜像、清单、差量、落回的纯函数在 `utils/sandbox.ts`。
 */

import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

import { isEmpty, Log } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { PlatformCompatibilityApi } from '@velaros-ai/platform'

import { SystemFailureLimits, SystemSandboxLimits } from '../contract/constants.js'
import type { SystemProcessConfinementProvider } from '../contract/requires.js'
import type { SystemSandboxManifest } from '../types/sandbox.js'
import type { SystemSandboxApplyOptions, SystemSandboxApplyResult, SystemSandboxDiff, SystemSandboxDiffOptions, SystemSandboxDiscardResult, SystemSandboxIgnoredMode, SystemSandboxRecord } from '../types/system.js'
import { buildSystemProcessConfinementSpawnSpec } from '../utils/confinement.js'
import { realPathForSafety } from '../utils/file-safety.js'
import { applyMirrorChanges, assertInsideSandboxBase, diffMirror, disableGitPush, isSandboxId, mirrorTree, newSandboxId, readSandboxManifest, sandboxBaseDirectory, sandboxConfinementPolicy, scanTree, selectSandboxChanges } from '../utils/sandbox.js'

import { GitIgnoreSystemSearchPolicy } from './GitIgnoreSystemSearchPolicy.js'
import type { SystemCommandRunnerApi } from './SystemCommandRunner.js'
import { SystemCommandRunner } from './SystemCommandRunner.js'
import type { SystemProcessManagerApi } from './SystemProcessManager.js'
import type { SystemShellResolverApi } from './SystemShellResolver.js'

const log = Log.tag('SystemSandboxes')

/**
 * 演练沙箱登记表：把目录镜像到临时区，镜像根之内跑的命令一律受进程约束；跑完能看差量、能把文件变化落回源目录、能整个丢弃。
 *
 * 实现是 `SystemSandboxes`，由本地内核创建并持有。每个沙箱有自己的命令执行器，约束固定是 `workspace-write`、根是镜像根、
 * 临时目录也在沙箱里、网络按创建时的选择；没有约束后端的宿主上建不出沙箱。
 */
export interface SystemSandboxesApi {
  /**
   * 建沙箱：源目录解开符号链接后镜像到基目录下的新目录（文件按写时复制，gitignore 忽略的目录按 ignored 处理，忽略的文件不复制），
   * 镜像仓库的推送地址改成无效值，清单落盘，登记专属执行器。先探测约束后端，没有就抛 `SYSTEM_PROCESS_CONFINEMENT_UNAVAILABLE` 并不留目录。
   * 源目录不能在基目录之内，基目录也不能在源目录之内；最多同时 5 个沙箱。
   */
  create(source: string, options: { network: boolean; ignored: SystemSandboxIgnoredMode }): Promise<SystemSandboxRecord>
  /** 镜像相对创建时的变化：新增、修改、删除三列（删除列永远完整），文本文件附有界的差量，.git 里的变化只汇总成一个布尔。 */
  diff(options: SystemSandboxDiffOptions): Promise<SystemSandboxDiff>
  /**
   * 把镜像里的文件变化落回源目录：先核对每一处在源目录里自镜像以来没被改过，任何冲突整批不落并抛错（cause.details.conflicts）；
   * 然后按新增、覆盖、删除写。.git 永远不落。审批由工具在调用前完成。
   */
  apply(options: SystemSandboxApplyOptions): Promise<SystemSandboxApplyResult>
  /** 删掉镜像并注销：路径不在基目录之下就拒绝；沙箱不存在时 removed 为 false。 */
  discard(sandboxId: string): Promise<SystemSandboxDiscardResult>
  /** 登记着的沙箱。 */
  list(): SystemSandboxRecord[]
  /** cwd 落在哪个沙箱根之内，就返回那个沙箱的专属执行器（内核重启后从清单重新登记）；不在任何沙箱里返回 null。 */
  runnerFor(cwd: string): Promise<Nullable<SystemCommandRunnerApi>>
  /** 所有登记着的沙箱执行器，宿主合并后台任务表用。 */
  runners(): SystemCommandRunnerApi[]
  /** 停掉所有沙箱执行器起的进程；镜像目录保留，用户可能还要看差量。 */
  dispose(): Promise<void>
}

/** 沙箱登记表的构造参数，由本地内核给：创建专属执行器要的全部东西，外加基目录（缺省在临时区）。 */
export interface SystemSandboxesOptions {
  /** 命令跑在哪个平台上。 */
  platform: NodeJS.Platform
  /** 按这个平台算 shell 参数与终止命令。 */
  platformTools: PlatformCompatibilityApi
  /** 宿主注入的约束后端；没有内置后端的平台靠它。 */
  confinementProvider?: SystemProcessConfinementProvider
  /** 选 shell 用。 */
  shells: SystemShellResolverApi
  /** 登记和管理子进程用。 */
  processes: SystemProcessManagerApi
  /** 沙箱基目录；缺省是临时区下的 velaros-sandbox。 */
  baseDir?: string
}

/** 登记表里的一项：沙箱记录、清单所在目录和专属执行器。 */
export interface SystemSandboxesEntry {
  /** 沙箱记录。 */
  record: SystemSandboxRecord
  /** 沙箱目录（清单、镜像根、沙箱自己的临时目录都在里面）。 */
  directory: string
  /** 镜像根解开符号链接后的真实路径，判断 cwd 在不在沙箱里用它比。 */
  realRoot: string
  /** 专属执行器。 */
  runner: SystemCommandRunnerApi
}

export class SystemSandboxes implements SystemSandboxesApi {
  private readonly entries = new Map<string, SystemSandboxesEntry>()
  private readonly options: SystemSandboxesOptions
  private readonly baseDir: string

  constructor(options: SystemSandboxesOptions) {
    this.options = options
    this.baseDir = options.baseDir ?? sandboxBaseDirectory()
  }

  public async create(source: string, options: { network: boolean; ignored: SystemSandboxIgnoredMode }): Promise<SystemSandboxRecord> {
    if (this.entries.size >= SystemSandboxLimits.sandboxes) throw new AppError('VALIDATION', `At most ${SystemSandboxLimits.sandboxes} sandboxes at a time; discard one first`)
    const realSource = await realPathForSafety(source)
    const sourceStats = await stat(realSource).catch(() => null)
    if (!sourceStats?.isDirectory()) throw new AppError('NOT_FOUND', `Sandbox source is not a directory: ${source}`)
    await mkdir(this.baseDir, { recursive: true, mode: 0o700 })
    const realBase = await realPathForSafety(this.baseDir)
    if (realSource === realBase || realSource.startsWith(realBase + sep)) throw new AppError('VALIDATION', 'The sandbox source cannot be inside the sandbox base directory')
    if (realBase.startsWith(realSource + sep)) throw new AppError('VALIDATION', 'The sandbox source contains the sandbox base directory; pick a narrower directory')

    const id = newSandboxId()
    const directory = join(this.baseDir, id)
    const root = join(directory, 'tree')
    const temp = join(directory, 'tmp')
    await mkdir(directory, { mode: 0o700 })
    await mkdir(root)
    await mkdir(temp)
    try {
      // 先探测约束后端：没有就拒绝，不留一个没有约束的目录副本冒充沙箱。
      buildSystemProcessConfinementSpawnSpec(
        { spec: { file: 'true', args: [] }, policy: sandboxConfinementPolicy(root, temp, options.network) },
        { platform: this.options.platform, env: process.env, provider: this.options.confinementProvider, tempDir: temp }
      )
      const ignorePolicy = new GitIgnoreSystemSearchPolicy(realSource, {})
      const mirrored = await mirrorTree(realSource, root, {
        ignored: options.ignored,
        shouldSkip: (absolutePath, isDirectory) => ignorePolicy.shouldSkip(absolutePath, isDirectory),
        limits: { files: SystemSandboxLimits.files, bytes: SystemSandboxLimits.bytes },
      })
      const git = await disableGitPush(root)
      const record: SystemSandboxRecord = {
        id, root, source: realSource, createdAt: Date.now(), network: options.network, ignored: options.ignored,
        fileCount: Object.keys(mirrored.files).length, bytes: mirrored.bytes, linkedDirectories: mirrored.linkedDirectories, git,
      }
      const manifest: SystemSandboxManifest = { version: 1, record, files: mirrored.files, mirror: mirrored.mirror }
      await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
      this.entries.set(id, { record, directory, realRoot: await realPathForSafety(root), runner: this.createRunner(root, temp, options.network) })
      log.info('sandbox created', { id, source: realSource, files: record.fileCount, bytes: record.bytes })
      return record
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw error
    }
  }

  public async diff(options: SystemSandboxDiffOptions): Promise<SystemSandboxDiff> {
    const entry = await this.resolveEntry(options.sandboxId)
    const manifest = await readSandboxManifest(entry.directory)
    const current = await scanTree(entry.record.root)
    const changes = await diffMirror(manifest, current, { maxFiles: options.maxFiles ?? SystemSandboxLimits.diffFiles })
    return { sandboxId: entry.record.id, source: entry.record.source, ...changes }
  }

  public async apply(options: SystemSandboxApplyOptions): Promise<SystemSandboxApplyResult> {
    const entry = await this.resolveEntry(options.sandboxId)
    const manifest = await readSandboxManifest(entry.directory)
    const changes = await diffMirror(manifest, await scanTree(entry.record.root), { maxFiles: SystemSandboxLimits.files })
    const selection = selectSandboxChanges(changes, options.paths)
    if (!isEmpty(selection.unknown)) throw new AppError('VALIDATION', `These paths did not change in the sandbox: ${selection.unknown.slice(0, SystemFailureLimits.listItems).join(', ')}`)
    const applied = await applyMirrorChanges(manifest, selection)
    log.info('sandbox applied', { id: entry.record.id, created: applied.created.length, modified: applied.modified.length, deleted: applied.deleted.length })
    // .git 里的变化差量阶段就已经只汇总不列出，所以这里按差量的 gitChanged 如实报「没落」。
    return { sandboxId: entry.record.id, ...applied, skippedGit: applied.skippedGit || changes.gitChanged }
  }

  public async discard(sandboxId: string): Promise<SystemSandboxDiscardResult> {
    if (!isSandboxId(sandboxId)) throw new AppError('VALIDATION', `Not a sandbox id: ${sandboxId}`)
    const directory = join(this.baseDir, sandboxId)
    // 递归删除只许删基目录之下的东西：路径核对不过就拒绝，这是整仓误删事故的直接教训。
    const real = await assertInsideSandboxBase(directory, this.baseDir)
    const entry = this.entries.get(sandboxId)
    if (entry) {
      await entry.runner.dispose()
      this.entries.delete(sandboxId)
    }
    const existing = await stat(real).catch(() => null)
    if (!existing) return { sandboxId, removed: false }
    await rm(real, { recursive: true, force: true })
    log.info('sandbox discarded', { id: sandboxId })
    return { sandboxId, removed: true }
  }

  public list(): SystemSandboxRecord[] {
    return [...this.entries.values()].map((entry) => entry.record)
  }

  public async runnerFor(cwd: string): Promise<Nullable<SystemCommandRunnerApi>> {
    const realCwd = await realPathForSafety(cwd)
    const inside = (entry: SystemSandboxesEntry): boolean => realCwd === entry.realRoot || realCwd.startsWith(entry.realRoot + sep)
    for (const entry of this.entries.values()) if (inside(entry)) return entry.runner
    // 没登记但落在基目录之下的沙箱（内核重启过）：按清单重新登记，别让它裸跑。
    const realBase = await realPathForSafety(this.baseDir)
    if (!realCwd.startsWith(realBase + sep)) return null
    const candidate = relative(realBase, realCwd).split(sep)[0] ?? ''
    if (!isSandboxId(candidate)) return null
    const entry = await this.resolveEntry(candidate).catch(() => null)
    return entry && inside(entry) ? entry.runner : null
  }

  public runners(): SystemCommandRunnerApi[] {
    return [...this.entries.values()].map((entry) => entry.runner)
  }

  public async dispose(): Promise<void> {
    await Promise.allSettled([...this.entries.values()].map((entry) => entry.runner.dispose()))
  }

  /** 给一个沙箱建专属执行器：约束钉死在镜像根，临时目录环境变量指进沙箱，git 不许交互式要口令。 */
  private createRunner(root: string, temp: string, network: boolean): SystemCommandRunnerApi {
    return new SystemCommandRunner({
      platform: this.options.platform,
      platformTools: this.options.platformTools,
      confinement: sandboxConfinementPolicy(root, temp, network),
      confinementProvider: this.options.confinementProvider,
      confinementTempDir: temp,
      extraEnv: { TMPDIR: temp, TMP: temp, TEMP: temp, GIT_TERMINAL_PROMPT: '0' },
      shells: this.options.shells,
      processes: this.options.processes,
    })
  }

  /** 按 id 取登记项；没登记的从基目录下的清单加载并登记（内核重启过），清单也没有就报 NOT_FOUND。 */
  private async resolveEntry(sandboxId: string): Promise<SystemSandboxesEntry> {
    const registered = this.entries.get(sandboxId)
    if (registered) return registered
    if (!isSandboxId(sandboxId)) throw new AppError('VALIDATION', `Not a sandbox id: ${sandboxId}`)
    const directory = join(this.baseDir, sandboxId)
    await assertInsideSandboxBase(directory, this.baseDir)
    const manifest = await readSandboxManifest(directory)
    const root = join(directory, 'tree')
    const temp = join(directory, 'tmp')
    await mkdir(temp, { recursive: true })
    const entry: SystemSandboxesEntry = { record: { ...manifest.record, root }, directory, realRoot: await realPathForSafety(root), runner: this.createRunner(root, temp, manifest.record.network) }
    this.entries.set(sandboxId, entry)
    return entry
  }

}
