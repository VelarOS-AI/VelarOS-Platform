/**
 * 本机演练沙箱：`LocalSandboxHost`，`velar:sandbox` 的宿主端口在本机上的实现，接口 `LocalSandboxHostApi` 在本文件的类上方，
 * 由 `createLocalSandboxHost` 创建。登记每个沙箱和它专属的受约束执行器（约束钉死在镜像根）；镜像、清单、差量、落回的纯函数在 `utils/mirror.ts`。
 */

import { lstat, mkdir, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { isEmpty, isPresent, isUndefined, Log } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { resolveRealPath } from '@velaros-ai/core/utils/RealPath'
import { createIgnorePolicy } from '@velaros-ai/path-rules'
import { textFileIo } from '@velaros-ai/text-files'
import { createConfinedShellRunner } from '@velaros-ai/velar/shell/local'

import { RehearsalSandboxLimits } from '../contract/constants.js'
import type { LocalSandboxHostOptions, RehearsalSandboxHostPort } from '../contract/requires.js'
import type { LocalSandboxEntry, SandboxManifest } from '../types/mirror.js'
import type { SandboxApplyOptions, SandboxApplyResult, SandboxCommandOutcome, SandboxCreateOptions, SandboxDiff, SandboxDiffOptions, SandboxDiscardResult, SandboxRecord, SandboxRunOptions } from '../types/rehearsal-sandbox.js'
import { applyMirrorChanges, diffMirror, disableGitPush, isPathInsideRoot, mirrorTree, newSandboxId, readSandboxManifest, removeSandboxDirectory, sandboxBaseDirectory, sandboxChangedSinceDiff, sandboxDirectoryOf, scanTree, stampOfEntry } from '../utils/mirror.js'
import { SandboxTuning } from '../utils/tuning.js'

import { rehearsalSandboxRules } from './RehearsalSandboxRules.js'

const log = Log.tag('LocalSandboxHost')

/** 按配置创建一个本机演练沙箱宿主；配置全可缺省。 */
export function createLocalSandboxHost(options: LocalSandboxHostOptions = {}): LocalSandboxHostApi {
  return new LocalSandboxHost(options)
}

/**
 * 本机演练沙箱：把目录镜像到临时区，镜像里跑的命令一律受进程约束；跑完能看差量、能把文件变化落回源目录、能整个丢弃。
 *
 * 实现是 `LocalSandboxHost`，宿主创建并持有。它就是 `velar:sandbox` 空间端口里除作用域（`resolveSource`）之外的全部：
 * 空间给端口时把这里原样接上，自己只补「源目录可以是哪儿」；项目空间的宿主端口也把它当沙箱给。每个沙箱有自己的受约束执行器（`@velaros-ai/velar/shell/local`
 * 的 `createConfinedShellRunner`）：约束固定是 `workspace-write`、写根是镜像根与沙箱自己的临时目录、网络按创建时的选择；
 * 没有约束后端的宿主上建不出沙箱。宿主重启后，按 id 用到的沙箱从基目录下的清单重新登记。
 */
export interface LocalSandboxHostApi extends RehearsalSandboxHostPort {
  /** 登记着的沙箱。 */
  listSandboxes(): SandboxRecord[]
  /** 停掉所有沙箱里还在跑的进程；镜像目录保留，用户可能还要看差量。 */
  dispose(): Promise<void>
}

export class LocalSandboxHost implements LocalSandboxHostApi {
  private readonly entries = new Map<string, LocalSandboxEntry>()
  private readonly loading = new Map<string, Promise<LocalSandboxEntry>>()
  private readonly options: LocalSandboxHostOptions
  private readonly baseDir: string

  constructor(options: LocalSandboxHostOptions) {
    this.options = options
    this.baseDir = options.baseDir ?? sandboxBaseDirectory()
  }

  public async createSandbox(options: SandboxCreateOptions = {}): Promise<SandboxRecord> {
    const source = options.source
    // 空间的 resolveSource 已经把源目录解析成绝对路径；这里不替空间猜默认目录，也不拿进程的工作目录去补相对路径。
    if (isUndefined(source) || !isAbsolute(source)) throw new AppError('VALIDATION', '建沙箱要给源目录的绝对路径（空间的 resolveSource 解析好的那个）')
    const network = !!options.network
    const ignored = options.ignored ?? 'link'
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
      // 先建受约束执行器：它先探测约束后端，没有就在这里拒绝，不留一个没有约束的目录副本冒充沙箱。
      const runner = this.createRunner(root, temp, network)
      const ignorePolicy = createIgnorePolicy(realSource, { rulesFrom: 'repository' })
      const mirrored = await mirrorTree(realSource, root, {
        ignored,
        shouldSkip: (absolutePath, isDirectory) => ignorePolicy.shouldSkip(absolutePath, isDirectory),
        limits: { files: RehearsalSandboxLimits.files, bytes: RehearsalSandboxLimits.bytes },
      })
      // 剪断镜像里每个仓库的推送；改过的配置文件在清单里记改完的印记，刚建好的沙箱差量才是干净的。
      for (const path of await disableGitPush(root, mirrored.gitConfigs)) mirrored.mirror[path] = stampOfEntry(await lstat(join(root, path)))
      const record: SandboxRecord = {
        id, root, source: realSource, createdAt: Date.now(), network, ignored,
        fileCount: Object.keys(mirrored.files).length, bytes: mirrored.bytes, linkedDirectories: mirrored.linkedDirectories,
        git: mirrored.gitConfigs.includes('.git/config'), detachedGitLinks: mirrored.detachedGitLinks,
      }
      const manifest: SandboxManifest = { version: 1, record, files: mirrored.files, mirror: mirrored.mirror }
      // 清单原子落盘：写到一半崩溃不会留下读不出来的清单。
      await textFileIo.writeBytes(join(directory, 'manifest.json'), Buffer.from(JSON.stringify(manifest)))
      this.entries.set(id, { record, directory, runner })
      log.info('sandbox created', { id, source: realSource, files: record.fileCount, bytes: record.bytes })
      return record
    } catch (error) {
      await removeSandboxDirectory(directory)
      throw error
    }
  }

  public async diffSandbox(options: SandboxDiffOptions): Promise<SandboxDiff> {
    const entry = await this.resolveEntry(options.sandboxId)
    const manifest = await readSandboxManifest(entry.directory)
    const current = await scanTree(entry.record.root)
    const changes = await diffMirror(manifest, current, { paths: options.paths, textDiffs: options.textDiffs })
    return { sandboxId: entry.record.id, source: entry.record.source, ...changes }
  }

  public async applySandbox(options: SandboxApplyOptions): Promise<SandboxApplyResult> {
    const entry = await this.resolveEntry(options.sandboxId)
    const manifest = await readSandboxManifest(entry.directory)
    // 落回按完整的三列算，不附文本差量。
    const changes = await diffMirror(manifest, await scanTree(entry.record.root), { textDiffs: false })
    // 落回前核对的那份差量和现在的对不上（核对之后镜像又被改过）：整批不落，让调用方重新 diff 再落。
    if (isPresent(options.fingerprint) && options.fingerprint !== changes.fingerprint) throw sandboxChangedSinceDiff()
    const selection = rehearsalSandboxRules.select(changes, options.paths)
    if (!isEmpty(selection.unknown)) throw new AppError('VALIDATION', `这些路径在沙箱里没有变化：${selection.unknown.slice(0, SandboxTuning.listedPaths).join('、')}`)
    const applied = await applyMirrorChanges(manifest, selection)
    log.info('sandbox applied', { id: entry.record.id, created: applied.created.length, modified: applied.modified.length, deleted: applied.deleted.length })
    // .git 里的变化差量阶段就已经只汇总不列出，所以这里按差量的 gitChanged 如实报「没落」。
    return { sandboxId: entry.record.id, ...applied, skippedGit: applied.skippedGit || changes.gitChanged }
  }

  public async discardSandbox(sandboxId: string): Promise<SandboxDiscardResult> {
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

  public async runInSandbox(options: SandboxRunOptions, abortSignal?: AbortSignal): Promise<SandboxCommandOutcome> {
    // 按 id 取登记项：没登记的从清单重新登记；清单读不出来就报错，绝不退回没有约束的执行器。
    const entry = await this.resolveEntry(options.sandboxId)
    const result = await entry.runner.run(options.command, { timeoutMs: options.timeoutMs, maxOutputChars: options.maxOutputChars }, abortSignal)
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, durationMs: result.durationMs, timedOut: result.timedOut, truncated: result.truncated, success: result.success }
  }

  public listSandboxes(): SandboxRecord[] {
    return [...this.entries.values()].map((entry) => entry.record)
  }

  public async dispose(): Promise<void> {
    await Promise.allSettled([...this.entries.values()].map((entry) => entry.runner.dispose()))
  }

  /** 给一个沙箱建专属的受约束执行器：约束钉死在镜像根，临时目录环境变量指进沙箱，git 不许交互式要口令；没有约束后端就抛错。 */
  private createRunner(root: string, temp: string, network: boolean): LocalSandboxEntry['runner'] {
    return createConfinedShellRunner({ root, tempDir: temp, network, platform: this.options.platform, confinementProvider: this.options.confinementProvider })
  }

  /**
   * 按 id 取登记项；没登记的从基目录下的清单加载并登记（内核重启过），清单也没有就报 NOT_FOUND。
   * 同一个沙箱同时被几处第一次用到（界面看差量、模型跑命令）时共用同一次加载，只建一个执行器，谁起的进程都停得掉。
   */
  private async resolveEntry(sandboxId: string): Promise<LocalSandboxEntry> {
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

  /** 从基目录下的清单加载一个沙箱并登记：目录先过 sandboxDirectoryOf 的核对，再读清单、建专属的受约束执行器。 */
  private async loadEntry(sandboxId: string): Promise<LocalSandboxEntry> {
    await sandboxDirectoryOf(this.baseDir, sandboxId)
    const directory = join(this.baseDir, sandboxId)
    const manifest = await readSandboxManifest(directory)
    const root = join(directory, 'tree')
    const temp = join(directory, 'tmp')
    await mkdir(temp, { recursive: true })
    const entry: LocalSandboxEntry = { record: { ...manifest.record, root }, directory, runner: this.createRunner(root, temp, manifest.record.network) }
    this.entries.set(sandboxId, entry)
    return entry
  }

}
