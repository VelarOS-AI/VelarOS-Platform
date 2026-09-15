/**
 * 演练沙箱：镜像一棵目录树、记印记、算差量、落回源目录、剪断镜像仓库的推送，以及只许删沙箱基目录之下东西的守卫。
 */

import { randomBytes } from 'node:crypto'
import type { Stats } from 'node:fs'
import { constants } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readdir, readFile, readlink, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, posix, sep } from 'node:path'

import { createTwoFilesPatch } from 'diff'

import { isEmpty, isNull, isPresent } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { SystemErrorCodes, SystemFailureLimits, SystemSandboxLimits } from '../contract/constants.js'
import type { SystemProcessConfinementPolicy } from '../types/commands.js'
import type { SystemSandboxApplyFailureDetails, SystemSandboxConflict, SystemSandboxFileStamp, SystemSandboxManifest, SystemSandboxStampTable } from '../types/sandbox.js'
import type { SystemSandboxApplyResult, SystemSandboxDiff, SystemSandboxIgnoredMode, SystemSandboxTextDiff } from '../types/system.js'

import { realPathForSafety } from './file-safety.js'
import { isBinaryBuffer } from './text-file.js'
import { SystemTuning } from './tuning.js'

/** 沙箱都放在临时区的这个基目录之下；删除前核对路径确实在它之下。 */
export function sandboxBaseDirectory(tempDir: string = tmpdir()): string {
  return join(tempDir, 'velaros-sandbox')
}

/** 生成沙箱 id，同时也是目录名：日期时间加随机段，只含数字、小写字母和横线。 */
export function newSandboxId(now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${stamp}-${randomBytes(3).toString('hex')}`
}

/** 沙箱 id 的形状；不合形状的 id 连目录名都拼不出来，防止路径穿越。 */
export function isSandboxId(value: string): boolean {
  return /^\d{8}-\d{6}-[a-f0-9]{6}$/.test(value)
}

/** 核对一个路径确实在沙箱基目录之下（两边都解开符号链接再比），不在就抛 PERMISSION——递归删除只许删这里面的东西。 */
export async function assertInsideSandboxBase(path: string, base: string): Promise<string> {
  const real = await realPathForSafety(path)
  const realBase = await realPathForSafety(base)
  if (real !== realBase && !real.startsWith(realBase + sep)) {
    throw new AppError('PERMISSION', `Refusing to touch ${path}: it is not inside the sandbox base directory ${base}`)
  }
  return real
}

/** 沙箱专属的约束策略：只能写镜像根和沙箱自己的临时目录，网络按创建时的选择。 */
export function sandboxConfinementPolicy(root: string, temp: string, network: boolean): SystemProcessConfinementPolicy {
  return { mode: 'workspace-write', workspaceRoot: root, writeRoots: [temp], network }
}

/** 读一个沙箱目录下的清单；读不到或形状不对就报 NOT_FOUND。镜像根永远按当前目录算，清单里的绝对路径只作记录。 */
export async function readSandboxManifest(directory: string): Promise<SystemSandboxManifest> {
  const raw = await readFile(join(directory, 'manifest.json'), 'utf8').catch(() => null)
  if (isNull(raw)) throw new AppError('NOT_FOUND', `No sandbox manifest under ${directory}; the sandbox was discarded or never created`)
  const manifest = JSON.parse(raw) as SystemSandboxManifest
  if (manifest.version !== 1 || !manifest.record || !manifest.files || !manifest.mirror) throw new AppError('NOT_FOUND', `Sandbox manifest under ${directory} is not readable`)
  manifest.record.root = join(directory, 'tree')
  return manifest
}

/** 从 lstat 结果取一个条目的印记；符号链接记它指向哪。 */
export function stampOfEntry(stats: Stats, link?: string): SystemSandboxFileStamp {
  const stamp: SystemSandboxFileStamp = { size: stats.size, mtimeMs: stats.mtimeMs, mode: stats.mode & 0o777 }
  if (isPresent(link)) stamp.link = link
  return stamp
}

/** 两个印记是否相同：大小、修改时间、权限位、链接目标都一样。 */
export function sameStamp(a: SystemSandboxFileStamp, b: SystemSandboxFileStamp): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.mode === b.mode && a.link === b.link
}

/**
 * 递归镜像源目录到镜像根：文件按写时复制（不支持的文件系统退回普通复制），忽略的目录按 ignored 处理，忽略的文件不复制。
 * 返回两张印记表：files 是源目录里每个文件与符号链接的印记，mirror 是镜像里每个条目（含链接过去的忽略目录）的印记。
 */
export async function mirrorTree(
  source: string,
  root: string,
  options: {
    ignored: SystemSandboxIgnoredMode
    shouldSkip: (absolutePath: string, isDirectory: boolean) => Promise<boolean>
    limits: { files: number; bytes: number }
  }
): Promise<{ files: SystemSandboxStampTable; mirror: SystemSandboxStampTable; bytes: number; linkedDirectories: string[] }> {
  const files: SystemSandboxStampTable = {}
  const mirror: SystemSandboxStampTable = {}
  const linkedDirectories: string[] = []
  let bytes = 0
  let count = 0
  const pending: string[] = ['']
  while (!isEmpty(pending)) {
    const relative = pending.pop()!
    const entries = await readdir(join(source, relative), { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))
    for (const entry of entries) {
      const relativePath = relative ? posix.join(relative, entry.name) : entry.name
      const sourcePath = join(source, relativePath)
      const mirrorPath = join(root, relativePath)
      const stats = await lstat(sourcePath)
      const ignored = await options.shouldSkip(sourcePath, entry.isDirectory())
      if (entry.isSymbolicLink()) {
        if (ignored) continue
        const target = await readlink(sourcePath)
        await symlink(target, mirrorPath)
        files[relativePath] = stampOfEntry(stats, target)
        mirror[relativePath] = stampOfEntry(await lstat(mirrorPath), target)
        count += 1
        continue
      }
      if (entry.isDirectory()) {
        if (ignored) {
          if (options.ignored === 'skip') continue
          if (options.ignored === 'link') {
            await symlink(sourcePath, mirrorPath, 'dir')
            mirror[relativePath] = stampOfEntry(await lstat(mirrorPath), sourcePath)
            linkedDirectories.push(relativePath)
            continue
          }
        }
        await mkdir(mirrorPath, { mode: stats.mode & 0o777 })
        pending.push(relativePath)
        continue
      }
      if (!entry.isFile() || ignored) continue
      count += 1
      bytes += stats.size
      if (count > options.limits.files) throw new AppError('VALIDATION', `The source has more than ${options.limits.files} files; pick a smaller directory or add a .gitignore so build output is not mirrored`)
      if (bytes > options.limits.bytes) throw new AppError('VALIDATION', `The source is larger than ${options.limits.bytes} bytes; pick a smaller directory or add a .gitignore so build output is not mirrored`)
      await copyFile(sourcePath, mirrorPath, constants.COPYFILE_FICLONE)
      await chmod(mirrorPath, stats.mode & 0o777)
      files[relativePath] = stampOfEntry(stats)
      mirror[relativePath] = stampOfEntry(await lstat(mirrorPath))
    }
  }
  return { files, mirror, bytes, linkedDirectories }
}

/** 遍历一棵树得到每个文件与符号链接的印记，不跟随符号链接（链接过去的忽略目录因此不会被翻）。 */
export async function scanTree(root: string): Promise<SystemSandboxStampTable> {
  const files: SystemSandboxStampTable = {}
  const pending: string[] = ['']
  while (!isEmpty(pending)) {
    const relative = pending.pop()!
    const entries = await readdir(join(root, relative), { withFileTypes: true })
    for (const entry of entries) {
      const relativePath = relative ? posix.join(relative, entry.name) : entry.name
      const absolutePath = join(root, relativePath)
      const stats = await lstat(absolutePath)
      if (entry.isSymbolicLink()) {
        files[relativePath] = stampOfEntry(stats, await readlink(absolutePath))
      } else if (entry.isDirectory()) {
        pending.push(relativePath)
      } else if (entry.isFile()) {
        files[relativePath] = stampOfEntry(stats)
      }
    }
  }
  return files
}

/** 一个相对路径是不是 .git 里面的东西。 */
export function isGitInternalPath(relativePath: string): boolean {
  return relativePath === '.git' || relativePath.startsWith('.git/')
}

/** 把镜像仓库的推送地址改成无效值：.git/config 里每个 remote 段加 `pushurl = DISABLED`，push 会失败而 fetch 照常。没有 .git/config 返回 false。 */
export async function disableGitPush(root: string): Promise<boolean> {
  const configPath = join(root, '.git', 'config')
  const config = await readFile(configPath, 'utf8').catch(() => null)
  if (isNull(config)) return false
  const rewritten = config.replace(/^\[remote "[^"]*"\]\n/gm, (header) => `${header}\tpushurl = DISABLED-BY-VELAROS-SANDBOX\n`)
  await writeFile(configPath, rewritten)
  return true
}

/** 读一个文件当文本（不像二进制且不超过上限）；不是就返回 null。 */
async function readTextForDiff(path: string, maxChars: number): Promise<Nullable<string>> {
  const stats = await lstat(path).catch(() => null)
  if (!stats?.isFile() || stats.size > maxChars * 4) return null
  const buffer = await readFile(path)
  if (isBinaryBuffer(buffer)) return null
  const text = buffer.toString('utf8')
  return text.length > maxChars ? null : text
}

/** 渲染一个文本文件的统一差量并按字符预算截断。 */
export function renderTextDiff(path: string, oldText: string, newText: string, maxChars: number): SystemSandboxTextDiff {
  const diff = createTwoFilesPatch(path, path, oldText, newText, '', '', { context: 3 })
  return diff.length > maxChars ? { path, diff: diff.slice(0, maxChars), truncated: true } : { path, diff, truncated: false }
}

/**
 * 比较镜像现在的印记和创建时的清单，算出新增、修改、删除三列（.git 里的东西只汇总成 gitChanged）。
 * 大小相同只是修改时间变了的文件，再和源目录里没变过的那份比内容，内容一样就不算修改。文本差量按预算附上，超出只列路径。
 */
export async function diffMirror(
  manifest: SystemSandboxManifest,
  current: SystemSandboxStampTable,
  options: { maxFiles: number }
): Promise<Omit<SystemSandboxDiff, 'sandboxId' | 'source'>> {
  const { root, source } = manifest.record
  const created: string[] = []
  const modified: string[] = []
  const deleted: string[] = []
  let gitChanged = false
  const noteGit = (path: string): boolean => {
    if (!isGitInternalPath(path)) return false
    gitChanged = true
    return true
  }
  for (const path of Object.keys(current).sort()) {
    const before = manifest.mirror[path]
    if (!before) {
      if (!noteGit(path)) created.push(path)
      continue
    }
    const after = current[path]!
    if (sameStamp(before, after)) continue
    if (before.size === after.size && before.link === after.link && !isPresent(after.link)) {
      // 大小没变只是时间变了：和源目录里没动过的那份比内容，内容一样不算改。
      const sourceStats = await lstat(join(source, path)).catch(() => null)
      const sourceBefore = manifest.files[path]
      if (sourceStats?.isFile() && sourceBefore && sameStamp(stampOfEntry(sourceStats), sourceBefore)) {
        const [mirrorBuffer, sourceBuffer] = await Promise.all([readFile(join(root, path)), readFile(join(source, path))])
        if (mirrorBuffer.equals(sourceBuffer)) continue
      }
    }
    if (!noteGit(path)) modified.push(path)
  }
  for (const path of Object.keys(manifest.mirror).sort()) {
    if (path in current) continue
    if (!noteGit(path)) deleted.push(path)
  }
  const truncated = created.length > options.maxFiles || modified.length > options.maxFiles
  const textDiffs: SystemSandboxTextDiff[] = []
  let omittedDiffs = 0
  let budget = SystemSandboxLimits.diffTotalChars
  for (const path of [...modified.slice(0, options.maxFiles), ...created.slice(0, options.maxFiles)]) {
    if (budget <= 0 || textDiffs.length >= SystemSandboxLimits.textDiffs) { omittedDiffs += 1; continue }
    const after = await readTextForDiff(join(root, path), SystemSandboxLimits.diffFileChars)
    if (isNull(after)) { omittedDiffs += 1; continue }
    let before = ''
    if (path in manifest.mirror) {
      // 修改前的内容只能从源目录里没动过的那份拿；源目录也变了就没有基线。
      const sourceStats = await lstat(join(source, path)).catch(() => null)
      const sourceBefore = manifest.files[path]
      if (!sourceStats?.isFile() || !sourceBefore || !sameStamp(stampOfEntry(sourceStats), sourceBefore)) { omittedDiffs += 1; continue }
      const baseline = await readTextForDiff(join(source, path), SystemSandboxLimits.diffFileChars)
      if (isNull(baseline)) { omittedDiffs += 1; continue }
      before = baseline
    }
    const rendered = renderTextDiff(path, before, after, Math.min(SystemSandboxLimits.diffFileChars, budget))
    budget -= rendered.diff.length
    textDiffs.push(rendered)
  }
  const result: Omit<SystemSandboxDiff, 'sandboxId' | 'source'> = {
    created: created.slice(0, options.maxFiles),
    modified: modified.slice(0, options.maxFiles),
    deleted,
    truncated,
    gitChanged,
    textDiffs,
    omittedDiffs,
  }
  if (omittedDiffs > 0) result.note = `${omittedDiffs} 个文件没附差量（二进制、太大、超过预算，或源目录里那份也变了没有基线）；用 system:read 直接看镜像里的文件。`
  return result
}

/** 按调用方给的相对路径筛选三列；不给就全部。给了但三列里都没有的路径原样返回在 unknown 里。 */
export function selectSandboxChanges(
  changes: Pick<SystemSandboxDiff, 'created' | 'modified' | 'deleted'>,
  paths: LooseOptional<readonly string[]>
): { created: string[]; modified: string[]; deleted: string[]; unknown: string[] } {
  if (!paths || isEmpty(paths)) return { created: [...changes.created], modified: [...changes.modified], deleted: [...changes.deleted], unknown: [] }
  const wanted = new Set(paths.map((path) => path.replace(/\\/g, '/').replace(/^\.\//, '')))
  const pick = (list: readonly string[]): string[] => list.filter((path) => wanted.has(path))
  const known = new Set([...changes.created, ...changes.modified, ...changes.deleted])
  return { created: pick(changes.created), modified: pick(changes.modified), deleted: pick(changes.deleted), unknown: [...wanted].filter((path) => !known.has(path)) }
}

/** 生成落回源目录前给用户看的确认文案：三列的条数、前几条路径，以及其中的系统敏感路径与凭证文件。 */
export function buildSandboxApplyConfirmationMessage(
  source: string,
  selection: { created: readonly string[]; modified: readonly string[]; deleted: readonly string[] },
  sensitivePaths: readonly string[]
): string {
  const shown = SystemTuning.sandbox.confirmationPreviewItems
  const preview = (list: readonly string[]): string => list.slice(0, shown).join('、') + (list.length > shown ? ` 等 ${list.length} 个` : '')
  const lines = [`即将把演练沙箱里的改动落回 ${source}：新增 ${selection.created.length} 个、覆盖 ${selection.modified.length} 个、删除 ${selection.deleted.length} 个文件。`]
  if (!isEmpty(selection.deleted)) lines.push(`删除：${preview(selection.deleted)}`)
  if (!isEmpty(selection.modified)) lines.push(`覆盖：${preview(selection.modified)}`)
  if (!isEmpty(selection.created)) lines.push(`新增：${preview(selection.created)}`)
  if (!isEmpty(sensitivePaths)) lines.push(`其中是系统敏感路径或凭证文件的：${preview(sensitivePaths)}`)
  lines.push('删除和覆盖无法撤销；落回前会核对这些文件自建沙箱以来没被别人改过，改过就整批不落。')
  return lines.join('\n')
}

/** 落回时整批不落的错误：什么都没写，cause.details.conflicts 列出每处冲突，context.executionOutcome 是 not-applied。 */
export function sandboxApplyConflict(conflicts: readonly SystemSandboxConflict[]): AppError {
  const details: SystemSandboxApplyFailureDetails = { executionOutcome: 'not-applied', conflicts: conflicts.slice(0, SystemFailureLimits.listItems) }
  return new AppError(
    'VALIDATION',
    `${conflicts.length} file(s) in the source changed since the sandbox was created; nothing was written. ${conflicts.slice(0, SystemFailureLimits.listItems).map((conflict) => `${conflict.path}: ${conflict.message}`).join('; ')}`,
    { reason: SystemErrorCodes.sandboxConflict, details, suggestedNextAction: 'Nothing was written. Re-create the sandbox from the current source, or apply only the paths that did not conflict.' },
    { executionOutcome: 'not-applied' }
  )
}

/** 核对一处变化落回时源目录的状态：改过、丢了、凭空出现都算冲突；没冲突返回 null。 */
async function conflictOf(source: string, manifest: SystemSandboxManifest, path: string, kind: 'created' | 'modified' | 'deleted'): Promise<Nullable<SystemSandboxConflict>> {
  const stats = await lstat(join(source, path)).catch(() => null)
  if (kind === 'created') return stats ? { path, reason: 'appeared', message: 'the source now has a file at this path that the sandbox did not mirror' } : null
  const before = manifest.files[path]
  if (!stats) return { path, reason: 'missing', message: 'the source file is gone since the sandbox was created' }
  const link = stats.isSymbolicLink() ? await readlink(join(source, path)) : undefined
  if (!before || !sameStamp(stampOfEntry(stats, link), before)) return { path, reason: 'changed', message: 'the source file changed since the sandbox was created; read it again before applying' }
  return null
}

/** 把镜像里的一个文件（或符号链接）原子地写到源目录的同一相对路径，保留权限位。 */
async function copyBack(root: string, source: string, path: string): Promise<void> {
  const mirrorPath = join(root, path)
  const targetPath = join(source, path)
  const stats = await lstat(mirrorPath)
  await mkdir(dirname(targetPath), { recursive: true })
  if (stats.isSymbolicLink()) {
    await rm(targetPath, { force: true })
    await symlink(await readlink(mirrorPath), targetPath)
    return
  }
  const temporary = `${targetPath}.velaros-sandbox-${process.pid}.tmp`
  await copyFile(mirrorPath, temporary, constants.COPYFILE_FICLONE)
  await chmod(temporary, stats.mode & 0o777)
  await rename(temporary, targetPath)
}

/**
 * 把镜像里选中的变化落回源目录：先把每一处都核对一遍（任何冲突整批不落），再按新增、覆盖、删除的顺序写；.git 里的东西永远不落。
 */
export async function applyMirrorChanges(
  manifest: SystemSandboxManifest,
  selection: { created: readonly string[]; modified: readonly string[]; deleted: readonly string[] }
): Promise<Omit<SystemSandboxApplyResult, 'sandboxId'>> {
  const { root, source } = manifest.record
  const outside = (list: readonly string[]): string[] => list.filter((path) => !isGitInternalPath(path))
  const created = outside(selection.created)
  const modified = outside(selection.modified)
  const deleted = outside(selection.deleted)
  const skippedGit = created.length + modified.length + deleted.length < selection.created.length + selection.modified.length + selection.deleted.length
  const conflicts: SystemSandboxConflict[] = []
  for (const [kind, list] of [['created', created], ['modified', modified], ['deleted', deleted]] as const) {
    for (const path of list) {
      const conflict = await conflictOf(source, manifest, path, kind)
      if (conflict) conflicts.push(conflict)
    }
  }
  if (!isEmpty(conflicts)) throw sandboxApplyConflict(conflicts)
  for (const path of created) await copyBack(root, source, path)
  for (const path of modified) await copyBack(root, source, path)
  for (const path of deleted) await unlink(join(source, path))
  return { created, modified, deleted, skippedGit }
}
