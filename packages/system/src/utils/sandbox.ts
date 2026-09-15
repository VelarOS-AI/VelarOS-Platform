/**
 * 演练沙箱：镜像一棵目录树、记印记、算差量、落回源目录、剪断镜像仓库的推送，以及只许删沙箱基目录之下东西的守卫。
 */

import { createHash, randomBytes } from 'node:crypto'
import type { Stats } from 'node:fs'
import { constants } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rename, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, posix, sep } from 'node:path'

import { createTwoFilesPatch } from 'diff'

import { isEmpty, isFalse, isNull, isPresent } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { SystemErrorCodes, SystemFailureLimits, SystemSandboxLimits } from '../contract/constants.js'
import type { SystemProcessConfinementPolicy } from '../types/commands.js'
import type { SystemSandboxApplyFailureDetails, SystemSandboxConflict, SystemSandboxFileStamp, SystemSandboxManifest, SystemSandboxStampTable } from '../types/sandbox.js'
import type { SystemSandboxApplyResult, SystemSandboxDiff, SystemSandboxIgnoredMode, SystemSandboxTextDiff } from '../types/system.js'

import { realPathForSafety } from './file-safety.js'
import { readErrnoCode } from './fs.js'
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
    throw new AppError('PERMISSION', `拒绝操作 ${path}：它不在沙箱基目录 ${base} 之下`)
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
  if (isNull(raw)) throw new AppError('NOT_FOUND', `${directory} 下没有沙箱清单：这个沙箱已经丢弃，或者从来没建过`)
  const manifest = JSON.parse(raw) as SystemSandboxManifest
  if (manifest.version !== 1 || !manifest.record || !manifest.files || !manifest.mirror) throw new AppError('NOT_FOUND', `${directory} 下的沙箱清单读不出来`)
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
      if (count > options.limits.files) throw new AppError('VALIDATION', `源目录的文件超过 ${options.limits.files} 个；换一个小一点的目录，或者加 .gitignore 让构建产物不进镜像`)
      if (bytes > options.limits.bytes) throw new AppError('VALIDATION', `源目录超过 ${options.limits.bytes} 字节；换一个小一点的目录，或者加 .gitignore 让构建产物不进镜像`)
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
 * 大小和权限位相同、只是修改时间变了的文件，再和源目录里没变过的那份比内容，内容一样就不算修改。
 * 指纹按截断前的完整三列和镜像印记算，落回时拿它核对镜像在确认之后有没有再变。文本差量按预算附上（textDiffs 为 false 时不附），超出只列路径。
 */
export async function diffMirror(
  manifest: SystemSandboxManifest,
  current: SystemSandboxStampTable,
  options: { maxFiles: number; textDiffs?: boolean }
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
    if (before.size === after.size && before.mode === after.mode && before.link === after.link && !isPresent(after.link)) {
      // 大小和权限位没变、只是时间变了：和源目录里没动过的那份比内容，内容一样不算改。只改了权限位的算修改。
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
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ created: created.map((path) => [path, current[path]]), modified: modified.map((path) => [path, current[path]]), deleted }))
    .digest('hex')
    .slice(0, 16)
  const textDiffs: SystemSandboxTextDiff[] = []
  let omittedDiffs = 0
  let budget = SystemSandboxLimits.diffTotalChars
  const candidates = isFalse(options.textDiffs) ? [] : [...modified.slice(0, options.maxFiles), ...created.slice(0, options.maxFiles)]
  for (const path of candidates) {
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
    fingerprint,
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
    `源目录里有 ${conflicts.length} 个文件自建沙箱以来变过，什么都没写。${conflicts.slice(0, SystemFailureLimits.listItems).map((conflict) => `${conflict.path}：${conflict.message}`).join('；')}`,
    { reason: SystemErrorCodes.sandboxConflict, details, suggestedNextAction: '什么都没写。从现在的源目录重建沙箱，或者只落回没有冲突的路径。' },
    { executionOutcome: 'not-applied' }
  )
}

/** 落回时镜像跟用户确认时看到的不一样了：什么都没写，cause.reason 是 SYSTEM_SANDBOX_CHANGED，context.executionOutcome 是 not-applied。 */
export function sandboxChangedSinceConfirmation(): AppError {
  return new AppError(
    'VALIDATION',
    '确认之后沙箱里的改动又变了（镜像里可能还有命令在跑），什么都没写；停掉镜像里的任务，重新 diff 再落回。',
    { reason: SystemErrorCodes.sandboxChanged, suggestedNextAction: '什么都没写。先用 system:list-tasks 找到并停掉镜像里还在跑的任务，再 diff、apply。' },
    { executionOutcome: 'not-applied' }
  )
}

/** 核对一处变化落回时源目录的状态：改过、丢了、凭空出现都算冲突；没冲突返回 null。 */
async function conflictOf(source: string, manifest: SystemSandboxManifest, path: string, kind: 'created' | 'modified' | 'deleted'): Promise<Nullable<SystemSandboxConflict>> {
  const stats = await lstat(join(source, path)).catch(() => null)
  if (kind === 'created') return stats ? { path, reason: 'appeared', message: '源目录里这个路径现在有文件，建沙箱时没有' } : null
  const before = manifest.files[path]
  if (!stats) return { path, reason: 'missing', message: '源文件在建沙箱之后被删了' }
  const link = stats.isSymbolicLink() ? await readlink(join(source, path)) : undefined
  if (!before || !sameStamp(stampOfEntry(stats, link), before)) return { path, reason: 'changed', message: '源文件在建沙箱之后被改过；看过再决定要不要落回' }
  return null
}

/** 源目录里一条相对路径的各级上级中，第一个已经存在却不是真目录的（符号链接或文件）；都是目录或还不存在时返回 null。 */
async function blockingAncestor(source: string, path: string): Promise<Nullable<{ path: string; link: boolean }>> {
  const segments = path.split('/')
  for (let depth = 1; depth < segments.length; depth += 1) {
    const ancestor = segments.slice(0, depth).join('/')
    const stats = await lstat(join(source, ancestor)).catch(() => null)
    if (!stats) return null
    if (stats.isSymbolicLink()) return { path: ancestor, link: true }
    if (!stats.isDirectory()) return { path: ancestor, link: false }
  }
  return null
}

/** 把镜像里的一个文件或符号链接复制到暂存路径：文件按写时复制并保留权限位，符号链接照原样再建一个。 */
async function stageEntry(from: string, to: string): Promise<void> {
  const stats = await lstat(from)
  if (stats.isSymbolicLink()) {
    await symlink(await readlink(from), to)
    return
  }
  await copyFile(from, to, constants.COPYFILE_FICLONE)
  await chmod(to, stats.mode & 0o777)
}

/** 把暂存好的条目原子地挪到目标位置（缺的上级目录补建）；隔着挂载点挪不动时，就在目标旁边复制一份再原子替换。 */
async function moveIntoPlace(staged: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  try {
    await rename(staged, target)
  } catch (error) {
    if (readErrnoCode(error) !== 'EXDEV') throw error
    const nearby = `${target}.velaros-sandbox-${process.pid}.tmp`
    await stageEntry(staged, nearby)
    await rename(nearby, target)
  }
}

/** 删除之后，源目录里变空、镜像里也已经没有的上级目录自底向上一并删掉；镜像里还在的、不空的目录照留。 */
async function removeEmptiedDirectories(root: string, source: string, deleted: readonly string[]): Promise<void> {
  const directories = new Set<string>()
  for (const path of deleted) {
    for (let directory = posix.dirname(path); directory !== '.' && !directories.has(directory); directory = posix.dirname(directory)) directories.add(directory)
  }
  for (const directory of [...directories].sort((a, b) => b.split('/').length - a.split('/').length)) {
    if (await lstat(join(root, directory)).catch(() => null)) continue
    await rmdir(join(source, directory)).catch(() => null)
  }
}

/** 落回途中出错时的报错：一条都还没落回就标 not-applied；落回了一部分就在 context.applied 里点名已经落回的路径。 */
function sandboxApplyFailure(error: unknown, applied: readonly string[]): AppError {
  const failure = AppError.from(error)
  if (isEmpty(applied)) return new AppError(failure.code, `落回时出错，源目录里什么都没改：${failure.message}`, error, { executionOutcome: 'not-applied' })
  return new AppError(failure.code, `已经落回了 ${applied.length} 个路径，后面的没落：${failure.message}`, error, { applied: [...applied] })
}

/**
 * 把镜像里选中的变化落回源目录，只写在源目录之内，要么全落、要么如实报出落了哪些：
 * 先把每一处核对一遍——源目录里改过、丢了、凭空出现，或者上级路径是符号链接、是文件（又不在这次删除之列），都算冲突，整批不落；
 * 再把新增与覆盖的内容拷进源目录里的暂存目录，拷不全就什么都不落；最后挪到位（镜像把文件换成了同名目录的，先删那个文件），按删除列删掉，
 * 删空、镜像里也已经没有的目录一并删掉。挪到位的途中出错，已经落回的路径在 context.applied 里点名。`.git` 里的东西永远不落。
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
  const deletedSet = new Set(deleted)
  const removeFirst = new Set<string>()
  const conflicts: SystemSandboxConflict[] = []
  // 上级路径：源目录里已经存在的每一级都必须是真目录。是这次要删的文件或链接（镜像把它换成了目录）就先删；否则落回会穿过它写到别处，算冲突。
  for (const path of [...created, ...modified]) {
    const blocker = await blockingAncestor(source, path)
    if (!blocker) continue
    if (deletedSet.has(blocker.path)) removeFirst.add(blocker.path)
    else conflicts.push(blocker.link
      ? { path, reason: 'link', message: `上级路径 ${blocker.path} 在源目录里是符号链接，落回会写到源目录外` }
      : { path, reason: 'changed', message: `上级路径 ${blocker.path} 在源目录里是文件，不是目录` })
  }
  const underRemoved = (path: string): boolean => [...removeFirst].some((ancestor) => path.startsWith(`${ancestor}/`))
  for (const [kind, list] of [['created', created], ['modified', modified], ['deleted', deleted]] as const) {
    for (const path of list) {
      // 上级要先删掉的新增路径，落回时是一个全新的目录，不看源目录里经过那个链接或文件能找到什么。
      if (kind === 'created' && underRemoved(path)) continue
      const conflict = await conflictOf(source, manifest, path, kind)
      if (conflict) conflicts.push(conflict)
    }
  }
  if (!isEmpty(conflicts)) throw sandboxApplyConflict(conflicts)

  // 暂存：新增与覆盖的内容先拷进源目录里的临时目录（同一个文件系统，最后一步是原子的改名），拷不全就什么都不落。
  const writes = [...created, ...modified]
  const applied: string[] = []
  let stage: Nullable<string> = null
  try {
    const staged: Array<{ path: string; staged: string }> = []
    if (!isEmpty(writes)) stage = await mkdtemp(join(source, '.velaros-sandbox-'))
    for (const [index, path] of writes.entries()) {
      const stagedPath = join(stage!, String(index))
      await stageEntry(join(root, path), stagedPath)
      staged.push({ path, staged: stagedPath })
    }
    for (const path of removeFirst) {
      await unlink(join(source, path))
      applied.push(path)
    }
    for (const entry of staged) {
      await moveIntoPlace(entry.staged, join(source, entry.path))
      applied.push(entry.path)
    }
    for (const path of deleted) {
      if (removeFirst.has(path)) continue
      await unlink(join(source, path))
      applied.push(path)
    }
  } catch (error) {
    throw sandboxApplyFailure(error, applied)
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true })
  }
  await removeEmptiedDirectories(root, source, deleted)
  return { created, modified, deleted, skippedGit }
}
