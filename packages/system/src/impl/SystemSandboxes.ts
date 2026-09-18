/**
 * 演练沙箱：`SystemSandboxes`。接口 `SystemSandboxesApi` 与构造参数 `SystemSandboxesOptions` 在本文件的类上方。
 * 登记每个沙箱和它专属的命令执行器（约束钉死在镜像根），镜像、清单、差量、落回的纯函数在 `utils/sandbox.ts`。
 */

import { lstat, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { isEmpty, isNotNull, isPresent, Log } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { resolveRealPath } from '@velaros-ai/core/utils/RealPath'
import { createIgnorePolicy } from '@velaros-ai/path-rules'
import type { PlatformCompatibilityApi } from '@velaros-ai/platform'
import { currentPlatform } from '@velaros-ai/platform'
import { rehearsalSandboxRules } from '@velaros-ai/velar/sandbox'
import type { SandboxApplyOptions, SandboxApplyResult, SandboxDiff, SandboxDiffOptions, SandboxDiscardResult, SandboxIgnoredMode, SandboxRecord } from '@velaros-ai/velar/sandbox/contracts'
import { RehearsalSandboxLimits } from '@velaros-ai/velar/sandbox/contracts'

import { SystemErrorCodes } from '../contract/constants.js'
import type { SystemProcessConfinementProvider } from '../contract/requires.js'
import type { SystemSandboxManifest } from '../types/sandbox.js'
import { buildSystemProcessConfinementSpawnSpec } from '../utils/confinement.js'
import { isPathInsideRoot } from '../utils/file-safety.js'
import { writeSystemFileAtomically } from '../utils/fs.js'
import { applyMirrorChanges, diffMirror, disableGitPush, isSandboxId, mirrorTree, newSandboxId, readSandboxManifest, removeSandboxDirectory, sandboxBaseDirectory, sandboxChangedSinceConfirmation, sandboxConfinementPolicy, sandboxDirectoryOf, scanTree, stampOfEntry } from '../utils/sandbox.js'
import { SystemTuning } from '../utils/tuning.js'

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
   * 镜像里每个仓库（含嵌套仓库、子模块）的推送地址改成无效值，指向源目录外真实仓库的 `.git` 链接文件不进镜像，清单原子落盘，登记专属执行器。
   * 先探测约束后端，没有就抛 `SYSTEM_PROCESS_CONFINEMENT_UNAVAILABLE` 并不留目录。源目录不能在基目录之内，基目录也不能在源目录之内（源是 `/` 也算）；
   * 最多同时 5 个沙箱。
   */
  create(source: string, options: { network: boolean; ignored: SandboxIgnoredMode }): Promise<SandboxRecord>
  /** 镜像相对创建时的变化：新增、修改、删除三列（删除列永远完整），文本文件附有界的差量，.git 里的变化只汇总成一个布尔。 */
  diff(options: SandboxDiffOptions): Promise<SandboxDiff>
  /**
   * 把镜像里的文件变化落回源目录：给了确认时的差量指纹就先核对，镜像在确认之后又变过整批不落（SYSTEM_SANDBOX_CHANGED）；
   * 再核对每一处在源目录里自镜像以来没被改过、上级路径不是符号链接，任何冲突整批不落并抛错（cause.details.conflicts）；
   * 内容先暂存再挪到位，暂存不全什么都不落，挪到位途中失败在 context.applied 里点名已落回的路径。.git 永远不落。审批由工具在调用前完成。
   */
  apply(options: SandboxApplyOptions): Promise<SandboxApplyResult>
  /** 删掉镜像并注销：路径不在基目录之下就拒绝；沙箱不存在时 removed 为 false。 */
  discard(sandboxId: string): Promise<SandboxDiscardResult>
  /** 登记着的沙箱。 */
  list(): SandboxRecord[]
  /**
   * cwd 落在哪个沙箱根之内，就返回那个沙箱的专属执行器（内核重启后从清单重新登记）；不在任何沙箱里返回 null。
   * cwd 落在某个沙箱的镜像根里、清单却读不出来时抛 `SYSTEM_PROCESS_CONFINEMENT_UNAVAILABLE`，不退回裸进程。
   */
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
  record: SandboxRecord
  /** 沙箱目录（清单、镜像根、沙箱自己的临时目录都在里面）。 */
  directory: string
  /** 镜像根解开符号链接后的真实路径，判断 cwd 在不在沙箱里用它比。 */
  realRoot: string
  /** 专属执行器。 */
  runner: SystemCommandRunnerApi
}

export class SystemSandboxes implements SystemSandboxesApi {
  private readonly entries = new Map<string, SystemSandboxesEntry>()
  private readonly loading = new Map<string, Promise<SystemSandboxesEntry>>()
  private readonly options: SystemSandboxesOptions
  private readonly baseDir: string

  constructor(options: SystemSandboxesOptions) {
    this.options = options
    this.baseDir = options.baseDir ?? sandboxBaseDirectory()
  }

  public async create(source: string, options: { network: boolean; ignored: SandboxIgnoredMode }): Promise<SandboxRecord> {
    if (this.entries.size >= RehearsalSandboxLimits.sandboxes) throw new AppError('VALIDATION', `同时最多 ${RehearsalSandboxLimits.sandboxes} 个沙箱；先 discard 一个`)
    const realSource = await resolveRealPath(source)
    const sourceStats = await stat(realSource).catch(() => null)
    if (!sourceStats?.isDirectory()) throw new AppError('NOT_FOUND', `沙箱的源不是目录：${source}`)
    await mkdir(this.baseDir, { recursive: true, mode: 0o700 })
    const realBase = await resolveRealPath(this.baseDir)
    if (isPathInsideRoot(realSource, realBase)) throw new AppError('VALIDATION', '沙箱的源不能在沙箱基目录之内')
    if (isPathInsideRoot(realBase, realSource)) throw new AppError('VALIDATION', '沙箱的源包含了沙箱基目录；换一个范围小一点的目录')

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
      const ignorePolicy = createIgnorePolicy(realSource, { rulesFrom: 'repository' })
      const mirrored = await mirrorTree(realSource, root, {
        ignored: options.ignored,
        shouldSkip: (absolutePath, isDirectory) => ignorePolicy.shouldSkip(absolutePath, isDirectory),
        limits: { files: RehearsalSandboxLimits.files, bytes: RehearsalSandboxLimits.bytes },
      })
      // 剪断镜像里每个仓库的推送；改过的配置文件在清单里记改完的印记，刚建好的沙箱差量才是干净的。
      for (const path of await disableGitPush(root, mirrored.gitConfigs)) mirrored.mirror[path] = stampOfEntry(await lstat(join(root, path)))
      const record: SandboxRecord = {
        id, root, source: realSource, createdAt: Date.now(), network: options.network, ignored: options.ignored,
        fileCount: Object.keys(mirrored.files).length, bytes: mirrored.bytes, linkedDirectories: mirrored.linkedDirectories,
        git: mirrored.gitConfigs.includes('.git/config'), detachedGitLinks: mirrored.detachedGitLinks,
      }
      const manifest: SystemSandboxManifest = { version: 1, record, files: mirrored.files, mirror: mirrored.mirror }
      // 清单原子落盘：写到一半崩溃不会留下读不出来的清单。
      await writeSystemFileAtomically(join(directory, 'manifest.json'), Buffer.from(JSON.stringify(manifest)))
      this.entries.set(id, { record, directory, realRoot: await resolveRealPath(root), runner: this.createRunner(root, temp, options.network) })
      log.info('sandbox created', { id, source: realSource, files: record.fileCount, bytes: record.bytes })
      return record
    } catch (error) {
      await removeSandboxDirectory(directory)
      throw error
    }
  }

  public async diff(options: SandboxDiffOptions): Promise<SandboxDiff> {
    const entry = await this.resolveEntry(options.sandboxId)
    const manifest = await readSandboxManifest(entry.directory)
    const current = await scanTree(entry.record.root)
    const changes = await diffMirror(manifest, current, { maxFiles: options.maxFiles ?? RehearsalSandboxLimits.diffFiles, textDiffs: options.textDiffs })
    return { sandboxId: entry.record.id, source: entry.record.source, ...changes }
  }

  public async apply(options: SandboxApplyOptions): Promise<SandboxApplyResult> {
    const entry = await this.resolveEntry(options.sandboxId)
    const manifest = await readSandboxManifest(entry.directory)
    // 落回永远按完整差量算，不截断、不附文本差量。
    const changes = await diffMirror(manifest, await scanTree(entry.record.root), { maxFiles: Number.MAX_SAFE_INTEGER, textDiffs: false })
    // 用户确认时看到的差量和现在的对不上（确认之后镜像又被改过）：整批不落，让调用方重新 diff、重新确认。
    if (isPresent(options.fingerprint) && options.fingerprint !== changes.fingerprint) throw sandboxChangedSinceConfirmation()
    const selection = rehearsalSandboxRules.select(changes, options.paths)
    if (!isEmpty(selection.unknown)) throw new AppError('VALIDATION', `这些路径在沙箱里没有变化：${selection.unknown.slice(0, SystemTuning.sandbox.listedPaths).join('、')}`)
    const applied = await applyMirrorChanges(manifest, selection)
    log.info('sandbox applied', { id: entry.record.id, created: applied.created.length, modified: applied.modified.length, deleted: applied.deleted.length })
    // .git 里的变化差量阶段就已经只汇总不列出，所以这里按差量的 gitChanged 如实报「没落」。
    return { sandboxId: entry.record.id, ...applied, skippedGit: applied.skippedGit || changes.gitChanged }
  }

  public async discard(sandboxId: string): Promise<SandboxDiscardResult> {
    // 递归删除只许删基目录下面正好一层、不是符号链接的沙箱目录：核对不过就拒绝，这是整仓误删事故的直接教训。
    const real = await sandboxDirectoryOf(this.baseDir, sandboxId)
    // 先停掉镜像里还在跑的进程再删；删成功了才注销，删不掉时沙箱照样登记着，还能再丢一次。
    await this.entries.get(sandboxId)?.runner.dispose()
    const existing = await stat(real).catch(() => null)
    if (existing) await removeSandboxDirectory(real)
    this.entries.delete(sandboxId)
    if (!existing) return { sandboxId, removed: false }
    log.info('sandbox discarded', { id: sandboxId })
    return { sandboxId, removed: true }
  }

  public list(): SandboxRecord[] {
    return [...this.entries.values()].map((entry) => entry.record)
  }

  public async runnerFor(cwd: string): Promise<Nullable<SystemCommandRunnerApi>> {
    // 真实路径都解开过，按字面比（realpath 给出的就是盘上的写法）。
    const realCwd = await resolveRealPath(cwd)
    const insidePath = (root: string): boolean => currentPlatform.isPathTextInside(realCwd, root, { caseSensitive: true })
    const inside = (entry: SystemSandboxesEntry): boolean => insidePath(entry.realRoot)
    for (const entry of this.entries.values()) if (inside(entry)) return entry.runner
    // 没登记但落在基目录之下的沙箱（内核重启过）：按清单重新登记，别让它裸跑。
    const realBase = await resolveRealPath(this.baseDir)
    const belowBase = currentPlatform.relativePathTextInside(realCwd, realBase, { caseSensitive: true })
    if (!isNotNull(belowBase) || belowBase === '.') return null
    const candidate = belowBase.split('/')[0] ?? ''
    if (!isSandboxId(candidate)) return null
    const entry = await this.resolveEntry(candidate).catch(() => null)
    if (entry) return inside(entry) ? entry.runner : null
    // 清单读不出来（写坏了、被清理掉了）：cwd 落在这个沙箱的镜像根里就拒绝执行，绝不退回没有约束的执行器。
    if (insidePath(join(realBase, candidate, 'tree'))) {
      throw new AppError(SystemErrorCodes.processConfinementUnavailable, `沙箱 ${candidate} 的清单读不出来，镜像里的命令没法约束，已拒绝执行；discard 这个沙箱后重建`)
    }
    return null
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

  /**
   * 按 id 取登记项；没登记的从基目录下的清单加载并登记（内核重启过），清单也没有就报 NOT_FOUND。
   * 同一个沙箱同时被几处第一次用到（界面看差量、模型跑命令）时共用同一次加载，只建一个执行器，谁起的后台任务都列得到、停得掉。
   */
  private async resolveEntry(sandboxId: string): Promise<SystemSandboxesEntry> {
    const registered = this.entries.get(sandboxId)
    if (registered) return registered
    const pending = this.loading.get(sandboxId) ?? this.loadEntry(sandboxId)
    this.loading.set(sandboxId, pending)
    try {
      return await pending
    } finally {
      this.loading.delete(sandboxId)
    }
  }

  /** 从基目录下的清单加载一个沙箱并登记：目录先过 sandboxDirectoryOf 的核对，再读清单、建专属执行器。 */
  private async loadEntry(sandboxId: string): Promise<SystemSandboxesEntry> {
    await sandboxDirectoryOf(this.baseDir, sandboxId)
    const directory = join(this.baseDir, sandboxId)
    const manifest = await readSandboxManifest(directory)
    const root = join(directory, 'tree')
    const temp = join(directory, 'tmp')
    await mkdir(temp, { recursive: true })
    const entry: SystemSandboxesEntry = { record: { ...manifest.record, root }, directory, realRoot: await resolveRealPath(root), runner: this.createRunner(root, temp, manifest.record.network) }
    this.entries.set(sandboxId, entry)
    return entry
  }

}
