// 域：工作区底层文件系统网关——所有读/写/列举都必须经过它，没有第二条通往 fs 的路。
//
// ## 从哪读起
//  1. `authorize`：**唯一**的准入点（根内约束），返回归一后的 `{ abs, rel }`。下面所有公开方法
//     都以它开头；绕过它 = 能读写到项目根外面去。
//  2. `snapshot` / `read`：读路径，附带 revision 与文本编码/二进制判定。
//  3. `write` / `remove` / `rename`：写路径。
//  4. `listFiles` / `observe`：遍历路径，含 gitignore 过滤与宿主的列举过滤（`visible`）。
//
// ## 安全门（挡什么、为什么门在这一层）
//  - **两段式根内约束**：`toAbs` 拦词法穿越（`../`），`resolveConfinedRealPath` 对 realpath 结果
//    再拦一次软链逃逸。门放在 FileStore 而不是各调用点，是因为「新增一个调用点忘了检查」
//    在上层是查不出来的，在这里则不可能发生——上层拿不到 abs 路径。
//  - **没有读写名单**：根内的路径点名就能读写。宿主的列举过滤器（`fileFilter`）只决定列举、扫描、
//    搜索时哪些条目不出现，点名访问从不问它——它管的是噪音，不是权限。
//  - **已知且刻意接受的 TOCTOU**：authorize 与真正的 write 之间存在时间窗，期间新建的软链
//    能逃逸。修它要 `openat` + `O_NOFOLLOW` 逐级打开（Node 无跨平台原语），代价远高于收益：
//    本包的威胁模型是「模型给出坏路径」，不是「攻击者与我们竞速」。
import type { BigIntStats } from 'node:fs'
import { lstat, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import * as path from 'node:path'

import { isNull, isObject, isPresent, isUndefined, optionalWhen, toOptional } from '@velaros-ai/core'
import { resolveRealPath } from '@velaros-ai/core/utils/RealPath'
import { textCodec, textFileIo } from '@velaros-ai/text-files'
import type { ExpectedBytes, TextEncoding } from '@velaros-ai/text-files/contracts'

import type { CommandProvider, FileFilterProvider } from '../../contract/requires.js'
import type {
  FileListEntry,
  FileStatInput,
  FileStatResult,
  ObserveInput,
  ReadInput,
  ReadResult,
} from '../../types/io.js'
import type { CorePolicy } from '../../types/policy.js'
import type { FileFilterInput } from '../../types/provider.js'
import type { FileSnapshot, ProjectSnapshot } from '../../types/snapshot.js'
import { ProjectError, projectErrorFromTextFile, RevisionMismatchSuggestedNextAction } from '../../utils/errors.js'
import { listProjectFiles } from '../../utils/files/file-listing.js'
import {
  advanceReadCursor,
  continuationInput,
  countTextLines,
  detectBinaryByPrefix,
  endColumnClampNote,
  estimateTokensFromBytes,
  hashFileAndDetectBinary,
  limitContent,
  readLimitedTextPrefix,
  readPastEnd,
  readProjectTextFile,
  readTextLineWindow,
  sliceWindowColumns,
} from '../../utils/files/file-reader.js'
import { relativeInsideRealRoot, resolveConfinedRealPath } from '../../utils/files/path-containment.js'
import { validateReadBounds } from '../../utils/files/read-bounds.js'
import { metadataFingerprint, metadataRevisionFor, revisionFor, sha256 } from '../../utils/hash.js'
import { toAbs, toRel } from '../../utils/path.js'
import { sliceLines } from '../../utils/text.js'
import { ProjectTuning } from '../../utils/tuning.js'

/**
 * 工作区的文件网关：内核的读、写、删、改名、列举都经它，没有第二条通往文件系统的路。每个公开方法先过 authorize：
 * 根内约束（字面上的 `../` 与经符号链接的逃逸都拦）；根内的路径点名就能读写。宿主的列举过滤器只在列举、扫描、搜索时用（`visible`）。
 * 快照带版本号（按策略用内容指纹或 metadata 算）与文本编码判定；写入是同目录临时文件加改名的原子替换，沿用原文件的编码与权限。实例归一个内核所有。
 */
export interface FileStoreApi {
  /** 工作区根目录的绝对路径。 */
  readonly root: string
  /** 只规范化路径并确认它在根之内，不碰正文：返回绝对路径和相对根的路径；出了根（含经符号链接指到外面）抛 PERMISSION_DENIED。 */
  authorize(pathInput: string): Promise<{ abs: string; rel: string }>
  /** 列举、扫描、搜索时一个条目出不出现：宿主的列举过滤器说了算（没给就都出现），按路径与它解开符号链接后的真实路径各问一次。点名访问不问它。 */
  visible(rel: string, action: FileFilterInput['action']): Promise<boolean>
  /** 取文件或目录的快照：是否存在、大小、版本、是不是二进制、文本编码与权限；includeContent 为真且文件不超读取上限时带正文。路径不存在时返回 exists 为假的快照，不抛错。 */
  snapshot(pathInput: string, includeContent?: boolean): Promise<FileSnapshot>
  /** 按行范围、字节数或字符数有界读取文本，带续读参数；给了 baseRevision 而版本对不上时抛 BASE_REVISION_MISMATCH，超出整读上限又没给范围或上限时抛 NOT_SUPPORTED。 */
  read(input: ReadInput): Promise<ReadResult>
  /** 搜索前给文件分类：UTF-8 文本能交给 ripgrep 直接搜（native），旧编码文本要解码后再搜（decoded），二进制、超搜索上限的跳过（excluded）；按文件身份与修改时间缓存。 */
  searchTextKind(pathInput: string): Promise<'native' | 'decoded' | 'excluded'>
  /** 轻量的文件状态：类型、大小、估算 token、行数（不太大的文本文件才数）、版本、编码和建议的首个读取窗口；不存在时返回 kind 为 missing。 */
  stat(input: FileStatInput): Promise<FileStatResult>
  /** 原子写入文本并返回写后的快照：已有文本文件沿用自己的编码与权限，encoding、mode 只在路径上还没有文件时生效；给了 transactionBytes 就原样写这些字节，给了 expectedBytes 时磁盘上的字节对不上就抛 CONFLICT_WITH_EXTERNAL_EDIT。 */
  write(pathInput: string, content: string, options?: { encoding?: TextEncoding; mode?: number; transactionBytes?: Uint8Array; expectedBytes?: ExpectedBytes }): Promise<FileSnapshot>
  /** 事务捕获原字节用：执行根内约束，最多读 maximumBytes（缺省是整读上限）；文件不存在返回 undefined，类型或长度变了抛 CONFLICT_WITH_EXTERNAL_EDIT。 */
  readTransactionBytes(pathInput: string, maximumBytes?: number): Promise<Buffer | undefined>
  /** 删除工作区里的单个文件（不存在也不报错）；给了 expectedBytes 时先核对磁盘字节，对不上抛 CONFLICT_WITH_EXTERNAL_EDIT。 */
  remove(pathInput: string, options?: { expectedBytes?: ExpectedBytes }): Promise<void>
  /** 在工作区里改名或移动文件，目标目录不存在就建；两端都要在根之内。 */
  rename(from: string, to: string): Promise<void>
  /** 按路径、include、exclude、深度和条数列出文件与目录，默认排除 gitignore 的条目（优先问 git，git 不可用时按本地规则判断）。 */
  listFiles(input?: ObserveInput): Promise<FileListEntry[]>
  /** 递归扫描工作区，返回每个文件的快照（不读正文）；读不了的文件跳过。 */
  observe(input?: ObserveInput): Promise<ProjectSnapshot>
}

/** 底层文件系统网关，统一执行根目录约束、列举过滤和 revision 管理。 */
export class FileStore implements FileStoreApi {
  readonly root: string
  private fileFilter?: FileFilterProvider
  private command: CommandProvider
  private policy: CorePolicy
  private realRoot?: Promise<string>
  private readonly searchTextKinds = new Map<string, { token: string; kind: 'native' | 'decoded' | 'excluded'; lastUsedAt: number }>()
  private searchTextKindNextSweep = 0
  private readonly snapshotEncodings = new WeakMap<FileSnapshot, TextEncoding>()

  constructor(
    root: string,
    policy: CorePolicy,
    fileFilter: LooseOptional<FileFilterProvider>,
    command: CommandProvider,
  ) {
    this.root = path.resolve(root)
    this.policy = policy
    this.fileFilter = toOptional(fileFilter)
    this.command = command
  }

  /** 路径解开符号链接后相对真实根的写法（同一个物理文件的各种别名解出来是同一条）；解出来不在根里时返回 null。 */
  private async realRelative(rel: string): Promise<Nullable<string>> {
    const real = await resolveRealPath(path.resolve(this.root, rel))
    return relativeInsideRealRoot(await this.getRealRoot(), real)
  }

  private getRealRoot(): Promise<string> {
    this.realRoot ??= resolveRealPath(this.root)
    return this.realRoot
  }

  /** 只做根内约束：规范化路径，再确认它（连同经符号链接指向的地方）在项目根之内，不碰正文。 */
  public async authorize(pathInput: string): Promise<{ abs: string; rel: string }> {
    const abs = toAbs(this.root, pathInput)
    await resolveConfinedRealPath(await this.getRealRoot(), abs, pathInput)
    return { abs, rel: toRel(this.root, abs) }
  }

  /** 列举、扫描、搜索时一个条目出不出现：项目内的链接、大小写别名指向同一个文件，挡住一条不能从另一条列出来。 */
  public async visible(rel: string, action: FileFilterInput['action']): Promise<boolean> {
    if (!this.fileFilter) return true
    if (!(await this.fileFilter.shouldInclude({ path: rel, action }))) return false
    const identity = await this.realRelative(rel)
    return isNull(identity) || identity === rel || this.fileFilter.shouldInclude({ path: identity, action })
  }

  /** 读取文件或目录的元数据，并按需附带文本内容。 */
  public async snapshot(
    pathInput: string,
    includeContent = true,
  ): Promise<FileSnapshot> {
    // 所有公开读写路径都先按工作区根目录规范化。
    const { abs, rel } = await this.authorize(pathInput)
    // 用 bigint stat 一次拿到纳秒级 mtime：metadata 模式据此区分相邻写入，content 模式仍按毫秒计算保持兼容。
    let st: BigIntStats
    try {
      st = await stat(abs, { bigint: true })
    } catch (error) {
      const code = isObject(error) && 'code' in error ? error.code : undefined
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
      const ident = this.identity(rel, 0, '0', 0, sha256('missing'))
      return {
        path: rel,
        absPath: abs,
        exists: false,
        isDirectory: false,
        isBinary: false,
        size: 0,
        sha256: ident.sha256,
        revision: ident.revision,
        mtimeMs: 0,
        adapterIds: [],
      }
    }
    const size = Number(st.size)
    const mtimeMs = Number(st.mtimeMs)
    const mtimeToken = st.mtimeNs.toString()
    const metadataMode = this.policy.revisionStrategy === 'metadata'

    const isDirectory = st.isDirectory()
    if (isDirectory) {
      const contentHash = sha256(`directory:${rel}:${mtimeMs}`)
      const ident = this.identity(rel, mtimeMs, mtimeToken, size, contentHash)
      return {
        path: rel,
        absPath: abs,
        exists: true,
        isDirectory: true,
        isBinary: false,
        size,
        sha256: ident.sha256,
        revision: ident.revision,
        mtimeMs,
        adapterIds: [],
      }
    }
    let content: string | undefined
    let textEncoding: Nullable<TextEncoding> = null
    let binary: boolean
    // contentHash 仅在 content 模式下参与计算；metadata 模式整文件读取/哈希都被跳过。
    let contentHash = ''
    if (includeContent && size <= this.policy.maxFileSizeToReadBytes) {
      const data = await readFile(abs)
      const decoded = textCodec.decode(data)
      binary = isNull(decoded)
      if (!metadataMode) {
        contentHash = sha256(data)
      }
      if (decoded) {
        textEncoding = decoded.encoding
        content = decoded.content
      }
    } else if (metadataMode) {
      // 轻量路径：不读全文，仅取头部样本判定二进制。
      binary = await detectBinaryByPrefix(abs)
    } else {
      const metadata = await hashFileAndDetectBinary(abs)
      binary = metadata.binary
      textEncoding = metadata.textEncoding
      contentHash = metadata.hash
    }
    const ident = this.identity(rel, mtimeMs, mtimeToken, size, contentHash)
    const base: FileSnapshot = {
      path: rel,
      absPath: abs,
      exists: true,
      isDirectory: false,
      isBinary: binary,
      size,
      encoding: binary ? 'binary' : 'utf8',
      mode: Number(st.mode) & 0o777,
      sha256: ident.sha256,
      revision: ident.revision,
      mtimeMs,
      adapterIds: [],
    }
    if (isPresent(content)) {
      base.content = content
    }
    if (isPresent(textEncoding)) {
      this.snapshotEncodings.set(base, textEncoding)
      if (textEncoding !== 'utf8') base.textEncoding = textEncoding
    }
    // stat 跟随链接取到的是目标文件；删除/重命名作用于链接本身，需要知道路径是不是链接。
    if ((await lstat(abs)).isSymbolicLink()) {
      base.isSymbolicLink = true
    }
    return base
  }

  /**
   * 按当前 revisionStrategy 计算 snapshot 的 revision 与 sha256：
   * metadata 模式只用 path+纳秒 mtime+size，content 模式用传入的内容哈希。
   */
  private identity(
    rel: string,
    mtimeMs: number,
    mtimeToken: string,
    size: number,
    contentHash: string,
  ): { revision: string; sha256: string } {
    if (this.policy.revisionStrategy === 'metadata')
      return {
        revision: metadataRevisionFor(rel, mtimeToken, size),
        sha256: metadataFingerprint(rel, mtimeToken, size),
      }
    return { revision: revisionFor(rel, contentHash, mtimeMs, size), sha256: contentHash }
  }

  /** 按范围、字节数或字符数限制读取文本内容。 */
  public async read(input: ReadInput): Promise<ReadResult> {
    validateReadBounds(input)
    const snap = await this.snapshot(input.path, true)
    if (input.baseRevision && snap.revision !== input.baseRevision) {
      throw new ProjectError(
        'BASE_REVISION_MISMATCH',
        `${snap.path} 的 revision 不匹配`,
        {
          expected: input.baseRevision,
          actual: snap.revision,
        },
        RevisionMismatchSuggestedNextAction,
      )
    }
    if (!snap.exists || snap.isDirectory || snap.isBinary) return { snapshot: snap }
    const hasRange =
      !!input.range &&
      [
        input.range.startLine,
        input.range.endLine,
        input.range.startColumn,
        input.range.endColumn,
      ].some((value) => !isUndefined(value))
    const hasLimit = !isUndefined(input.maxBytes) || !isUndefined(input.maxChars)
    if (isUndefined(snap.content) && !hasLimit && !hasRange) {
      throw new ProjectError(
        'NOT_SUPPORTED',
        `文件超过完整读取上限：${snap.path}`,
        {
          size: snap.size,
          maxFileSizeToReadBytes: this.policy.maxFileSizeToReadBytes,
        },
        '请读取有界范围，或传入 maxBytes。',
      )
    }
    if (isUndefined(snap.content) && !hasRange && hasLimit) {
      const prefix = await readLimitedTextPrefix(snap.absPath, snap.size, {
        maxBytes: input.maxBytes,
        maxChars: input.maxChars,
      }, this.snapshotEncodings.get(snap))
      const limited = limitContent(prefix.content, input.maxBytes, input.maxChars)
      const truncated = prefix.truncated || limited.truncated
      const cursor = advanceReadCursor(
        { line: 1, column: 1 },
        prefix.content.slice(0, limited.consumedChars),
      )
      return {
        snapshot: snap,
        content: limited.content,
        totalLines: optionalWhen(!truncated, countTextLines(prefix.content)),
        truncated,
        hasMore: truncated,
        nextStartLine: optionalWhen(truncated && cursor.column === 1, cursor.line),
        continuation: optionalWhen(
          truncated,
          continuationInput(input, snap.path, snap.revision, cursor, true),
        ),
      }
    }

    if (isUndefined(snap.content) && hasRange) {
      const range = input.range!
      const window = await readTextLineWindow(
        snap.absPath,
        {
          startLine: range.startLine,
          endLine: range.endLine,
          startColumn: range.startColumn,
          endColumn: range.endColumn,
        },
        {
          maxBytes: input.maxBytes,
          maxChars: input.maxChars,
        },
        this.snapshotEncodings.get(snap),
      )
      const requestedStartLine = range.startLine ?? 1
      if (isPresent(window.totalLines) && requestedStartLine > window.totalLines)
        return readPastEnd(snap, requestedStartLine, window.totalLines)
      const selected = sliceWindowColumns(
        snap.path,
        window.content,
        range,
        window.range.startLine,
        window.range.endLine,
      )
      const limited = limitContent(selected.content, input.maxBytes, input.maxChars)
      const startCursor = { line: window.range.startLine, column: selected.startColumn }
      const limitedCursor = advanceReadCursor(
        startCursor,
        selected.content.slice(0, limited.consumedChars),
      )
      const cursor = limited.truncated
        ? limitedCursor
        : selected.hasMoreOnEndLine
          ? { line: window.range.endLine, column: selected.endColumn }
          : { line: window.range.endLine + 1, column: 1 }
      const hasMore = limited.truncated || selected.hasMoreOnEndLine || window.hasMore
      return {
        snapshot: snap,
        content: limited.content,
        range: {
          startLine: window.range.startLine,
          startColumn: selected.startColumn,
          endLine: limited.truncated ? limitedCursor.line : window.range.endLine,
          endColumn: limited.truncated ? limitedCursor.column : selected.endColumn,
        },
        // 要的那一段完整给到了就不叫截断；后面还有内容由 hasMore 和 continuation 说。
        truncated: limited.truncated || selected.hasMoreOnEndLine,
        hasMore,
        nextStartLine: optionalWhen(hasMore && cursor.column === 1, cursor.line),
        continuation: optionalWhen(
          hasMore,
          continuationInput(input, snap.path, snap.revision, cursor, limited.truncated),
        ),
        note: endColumnClampNote(range, window.totalLines),
      }
    }

    const rawContent = snap.content ?? (await readProjectTextFile(snap.absPath, this.snapshotEncodings.get(snap)))
    const allLines = rawContent.split('\n')
    const totalLines = allLines.length

    if (hasRange) {
      const range = input.range!
      const requestedStartLine = range.startLine ?? 1
      if (requestedStartLine > totalLines) return readPastEnd(snap, requestedStartLine, totalLines)
      const sliced = sliceLines(rawContent, range.startLine, range.endLine)
      const selected = sliceWindowColumns(
        snap.path,
        sliced.content,
        range,
        sliced.range.startLine,
        sliced.range.endLine,
      )
      const limited = limitContent(selected.content, input.maxBytes, input.maxChars)
      const startCursor = { line: sliced.range.startLine, column: selected.startColumn }
      const limitedCursor = advanceReadCursor(
        startCursor,
        selected.content.slice(0, limited.consumedChars),
      )
      const cursor = limited.truncated
        ? limitedCursor
        : selected.hasMoreOnEndLine
          ? { line: sliced.range.endLine, column: selected.endColumn }
          : { line: sliced.range.endLine + 1, column: 1 }
      const hasMore =
        limited.truncated || selected.hasMoreOnEndLine || sliced.range.endLine < totalLines
      // 明确给了 range 时，这一段读全了就不标截断：标了模型会以为没读完，接着去翻页。
      const truncated = limited.truncated || selected.hasMoreOnEndLine
      const remainingLines = hasMore
        ? Math.max(0, totalLines - cursor.line + (cursor.column > 1 ? 1 : 0))
        : 0
      return {
        snapshot: snap,
        content: limited.content,
        range: {
          startLine: sliced.range.startLine,
          startColumn: selected.startColumn,
          endLine: limited.truncated ? limitedCursor.line : sliced.range.endLine,
          endColumn: limited.truncated ? limitedCursor.column : selected.endColumn,
        },
        totalLines,
        truncated,
        hasMore,
        nextStartLine: optionalWhen(hasMore && cursor.column === 1, cursor.line),
        remainingLines: optionalWhen(hasMore, remainingLines),
        continuation: optionalWhen(
          hasMore,
          continuationInput(input, snap.path, snap.revision, cursor, limited.truncated),
        ),
        note: endColumnClampNote(range, totalLines),
      }
    }

    const limited = limitContent(rawContent, input.maxBytes, input.maxChars)
    const cursor = advanceReadCursor(
      { line: 1, column: 1 },
      rawContent.slice(0, limited.consumedChars),
    )
    const hasMore = limited.truncated
    return {
      snapshot: snap,
      content: limited.content,
      totalLines,
      truncated: limited.truncated,
      hasMore,
      nextStartLine: optionalWhen(hasMore && cursor.column === 1, cursor.line),
      remainingLines: optionalWhen(
        hasMore,
        Math.max(0, totalLines - cursor.line + (cursor.column > 1 ? 1 : 0)),
      ),
      continuation: optionalWhen(
        hasMore,
        continuationInput(input, snap.path, snap.revision, cursor, true),
      ),
    }
  }

  /** 搜索只缓存物理格式分类；纳秒 mtime/ctime 与文件身份变化都会重新严格探测。 */
  public async searchTextKind(pathInput: string): Promise<'native' | 'decoded' | 'excluded'> {
    const { abs, rel } = await this.authorize(pathInput)
    const metadata = await stat(abs, { bigint: true })
    if (!metadata.isFile() || metadata.size > this.policy.maxSearchFileSizeBytes) return 'excluded'
    const token = [metadata.dev, metadata.ino, metadata.size, metadata.mtimeNs, metadata.ctimeNs].join(':')
    const cached = this.searchTextKinds.get(rel)
    const now = Date.now()
    if (cached) cached.lastUsedAt = now
    if (cached?.token === token) return cached.kind
    const encoding = textCodec.detect(await readFile(abs))
    const kind = !encoding ? 'excluded' : encoding === 'utf8' || encoding === 'utf8-bom' ? 'native' : 'decoded'
    if (now >= this.searchTextKindNextSweep) {
      // 只回收近期不再参与查询的条目，容量外扫描不会把仍活跃的整批条目逐项顶出。
      for (const [path, entry] of this.searchTextKinds) {
        if (now - entry.lastUsedAt >= ProjectTuning.files.searchTextKindIdleMs) this.searchTextKinds.delete(path)
      }
      this.searchTextKindNextSweep = now + ProjectTuning.files.searchTextKindIdleMs
    }
    if (cached || this.searchTextKinds.size < ProjectTuning.files.searchTextKindEntries) {
      this.searchTextKinds.set(rel, { token, kind, lastUsedAt: now })
    }
    return kind
  }

  /** 返回轻量文件状态和建议的安全读取窗口。 */
  public async stat(input: FileStatInput): Promise<FileStatResult> {
    // stat 比 read 更轻量，并返回推荐的安全读取窗口。
    // 这里取 includeContent=true：对可读文本文件复用同一次读取的正文来数行数，
    // 避免「先为哈希读一遍、再为行数读一遍」的重复整文件读取。
    const snap = await this.snapshot(input.path, true)
    const warnings: string[] = []

    if (!snap.exists) {
      warnings.push('文件不存在。')
      return {
        path: snap.path,
        absolutePath: snap.absPath,
        exists: false,
        kind: 'missing',
        sizeBytes: 0,
        estimatedTokens: null,
        lineCount: null,
        isBinary: false,
        readableText: false,
        mtimeMs: null,
        revision: null,
        recommendedRead: null,
        warnings,
      }
    }

    // 复用 snapshot 已做的 bigint stat：snapshot 已携带 size / mtimeMs / isDirectory，
    // 不再为 stat 结果重复发一次 stat() 系统调用。snapshot 把存在的非目录项一律按文件读取，
    // 因此走到这里的「存在且非目录」项即视作常规文件（fifo 等异常项在 snapshot 读取阶段已退化为 missing）。
    const kind = snap.isDirectory ? 'directory' : 'file'
    const sizeBytes = snap.size
    const mtimeMs = snap.mtimeMs
    const estimatedTokens = kind === 'file' ? estimateTokensFromBytes(sizeBytes) : null

    if (kind !== 'file') {
      warnings.push(kind === 'directory' ? '目标是目录。' : '目标不是常规文件。')
      return {
        path: snap.path,
        absolutePath: snap.absPath,
        exists: true,
        kind,
        sizeBytes,
        estimatedTokens,
        lineCount: null,
        isBinary: snap.isBinary,
        readableText: false,
        mtimeMs,
        revision: snap.revision,
        recommendedRead: null,
        warnings,
      }
    }

    if (snap.isBinary) {
      warnings.push('文件看起来是二进制。')
      return {
        path: snap.path,
        absolutePath: snap.absPath,
        exists: true,
        kind,
        sizeBytes,
        estimatedTokens,
        lineCount: null,
        isBinary: true,
        readableText: false,
        mtimeMs,
        revision: snap.revision,
        recommendedRead: null,
        warnings,
      }
    }

    let lineCount: Nullable<number> = null
    if (sizeBytes <= ProjectTuning.files.statLineCountBytes) {
      // 优先复用 snapshot 已读到的正文；仅当宿主把读取上限调得比行数上限更小时才回退到再读一次。
      const text = snap.content ?? (await readProjectTextFile(snap.absPath, this.snapshotEncodings.get(snap)))
      lineCount = countTextLines(text)
    } else {
      warnings.push('文件较大；stat 阶段未计算行数。')
    }

    const endLine = isNull(lineCount)
      ? ProjectTuning.files.statRecommendedLines
      : Math.min(lineCount, ProjectTuning.files.statRecommendedLines)

    return {
      path: snap.path,
      absolutePath: snap.absPath,
      exists: true,
      kind,
      sizeBytes,
      estimatedTokens,
      lineCount,
      isBinary: false,
      readableText: true,
      textEncoding: this.snapshotEncodings.get(snap) ?? 'utf8',
      mtimeMs,
      revision: snap.revision,
      recommendedRead: endLine > 0 ? { path: snap.path, range: { startLine: 1, endLine } } : null,
      warnings,
    }
  }

  /**
   * 写入文本文件，并返回写入后的 snapshot。既有文本文件沿用自己的编码；`encoding` 只在路径上还没有
   * 文件时生效，供删除后回滚、重命名重建文件时沿用原文件的编码。
   */
  public async write(
    pathInput: string,
    content: string,
    options?: { encoding?: TextEncoding; mode?: number; transactionBytes?: Uint8Array; expectedBytes?: ExpectedBytes },
  ): Promise<FileSnapshot> {
    const { abs, rel } = await this.authorize(pathInput)
    await mkdir(path.dirname(abs), { recursive: true })
    const written = options?.transactionBytes
      ? textFileIo.writeBytes(abs, options.transactionBytes, { mode: options.mode, expected: options.expectedBytes })
      : textFileIo.writeText(abs, content, { fallbackEncoding: options?.encoding, mode: options?.mode })
    await written.catch((error: unknown) => {
      throw projectErrorFromTextFile(error)
    })
    return this.snapshot(rel, true)
  }

  /** 私有事务捕获；根内约束始终执行。 */
  public async readTransactionBytes(pathInput: string, maximumBytes = this.policy.maxFileSizeToReadBytes): Promise<Buffer | undefined> {
    const { abs } = await this.authorize(pathInput)
    return textFileIo.readBounded(abs, maximumBytes).catch((error: unknown) => {
      throw projectErrorFromTextFile(error)
    })
  }

  /** 删除工作区内的单个文件；给了 expectedBytes 时先核对磁盘字节。 */
  public async remove(pathInput: string, options?: { expectedBytes?: ExpectedBytes }): Promise<void> {
    const { abs } = await this.authorize(pathInput)
    if (options?.expectedBytes) {
      await textFileIo.assertUnchanged(abs, options.expectedBytes).catch((error: unknown) => {
        throw projectErrorFromTextFile(error)
      })
    }
    await rm(abs, { force: true, recursive: false })
  }

  /** 在工作区内重命名或移动文件。 */
  public async rename(from: string, to: string): Promise<void> {
    const fromAccess = await this.authorize(from)
    const toAccess = await this.authorize(to)
    await mkdir(path.dirname(toAccess.abs), { recursive: true })
    await rename(fromAccess.abs, toAccess.abs)
  }
  public async listFiles(input: ObserveInput = {}): Promise<FileListEntry[]> {
    return listProjectFiles(input, {
      root: this.root,
      command: this.command,
      authorize: (pathInput) => this.authorize(pathInput),
      visible: (rel, action) => this.visible(rel, action),
    })
  }

  /** 构建工作区文件快照列表，不默认读取文件正文。 */
  public async observe(input: ObserveInput = {}): Promise<ProjectSnapshot> {
    // observe 默认递归扫描整个工作区。
    const entries = await this.listFiles({
      ...input,
      recursive: input.recursive ?? true,
      maxDepth: input.maxDepth ?? ProjectTuning.files.observeDepth,
    })
    const snapshots: ProjectSnapshot['files'] = []
    for (const entry of entries) {
      if (entry.type !== 'file') continue
      try {
        const snap = await this.snapshot(entry.path, false)
        snapshots.push({
          path: snap.path,
          size: snap.size,
          sha256: snap.sha256,
          revision: snap.revision,
          mtimeMs: snap.mtimeMs,
          isBinary: snap.isBinary,
          adapterIds: snap.adapterIds,
        })
      } catch {
        // arch-guard:silent-catch-ok 文件可能被 provider/policy 动态拒绝，observe 按 best-effort 跳过。
      }
    }
    const revision = revisionFor(
      'project',
      sha256(snapshots.map((s) => `${s.path}:${s.sha256}`).join('\n')),
      Date.now(),
      snapshots.length,
    )
    return { root: this.root, revision, files: snapshots, createdAt: Date.now() }
  }
}
