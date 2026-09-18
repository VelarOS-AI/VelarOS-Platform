/**
 * `memory-files` 是内置默认记忆后端，也是权威层，对应内核契约 §15.7 裁决四和第九章 9.1。
 *
 * 每个作用域对应一个目录，目录包含带前置元数据的 Markdown 文件及逐行记录的 `MEMORY.md` 索引。
 * 检索先匹配索引，命中后按需读取全文。实现不依赖模型、原生模块或嵌入服务，免费模式也能完整工作。
 *
 * 权威层必须人可读、可手工编辑、可比较并可版本化。因此每次读取都重新解析磁盘；`archive` 只
 * 撤销索引并标记归档，不物理删除用户资产；未知前置元数据字段会原样保留。
 *
 * 全局路径与项目路径都由宿主注入，本文件不假设宿主目录布局。与 `memory-vector` 叠加时，本后端
 * 仍保存权威全文，向量索引只返回指针；写入顺序始终先权威层、后派生索引。
 */

import {
  isEmpty,
  isFalse,
  isFunction,
  isNotNull,
  isNull,
  isTrue,
  Log,
  toNullable,
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { MemoryBackendIds, MemoryFilesLayout } from '../../contract/constants.js'
import type {
  MemoryAuthorityEnumeration,
  MemoryFilesIo,
  MemoryStoreBackend,
} from '../../contract/requires.js'
import type {
  MemoryFileDocument,
  MemoryFilesBackendOptions,
  MemoryIndexEntry,
  ScoredCandidate,
  StableKeyCacheEntry,
} from '../../types/files.js'
import type {
  MemoryBackendCaptureBatchOptions,
  MemoryBackendDescriptor,
  MemoryBackendStats,
  MemoryCaptureBatchResult,
  MemoryCaptureResult,
  MemoryEvidenceCategory,
  MemoryEvidenceInput,
  MemoryEvidenceRecord,
  MemoryFilesScopeRoot,
  MemoryForgetResult,
  MemoryRecallItem,
  MemoryRecallOptions,
} from '../../types/memory.js'
import {
  isMemoryRecallItemExcluded,
} from '../../utils/backends.js'
import { redactMemorySecrets, sanitizeMemoryEvidenceInput } from '../../utils/evidence.js'
import {
  firstLine,
  hasContentFilter,
  hashStableKey,
  MemoryFilesArchivedStatus,
  MemoryFilesEntryIdSeparator,
  optionalTags,
  readMetadataString,
  redactAttributes,
  scoreIndexEntry,
  slugify,
  toEvidenceRecord,
  tokenize,
  toRecallItem,
} from '../../utils/files/entries.js'
import {
  isMemoryEntryFileName,
  isMemoryEntryPath,
  isMemoryFileSegment,
} from '../../utils/files/entry-path.js'
import {
  parseMemoryFileDocument,
  serializeMemoryFileDocument,
} from '../../utils/files/frontmatter.js'
import {
  parseMemoryIndex,
  removeMemoryIndexEntry,
  serializeMemoryIndex,
  upsertMemoryIndexEntry,
} from '../../utils/files/index-file.js'
import {
  isMemoryVisibleInScope,
  resolveMemoryScopeSelector,
  scopeTypeForScopeId,
} from '../../utils/scope.js'
import { MemoryTuning } from '../../utils/tuning.js'

import { InMemoryMemoryFilesIo } from './InMemoryMemoryFilesIo.js'

/**
 * 文件权威层对外的整件能力：窄端口的六个动词，外加「把权威层从头读一遍」的全量枚举。
 *
 * 本档**自带全量枚举**，因此叠加编排不需要宿主再注入一个枚举源，装上派生索引即可重建。
 * 实例由 `createMemoryFilesBackend` 造，一个实例管一组作用域根。
 */
export interface MemoryFilesBackendApi extends MemoryStoreBackend, MemoryAuthorityEnumeration {}

/** 文件权威层：每个作用域一个目录，条目是带 frontmatter 的 markdown，索引是一份 `MEMORY.md`。 */
export class MemoryFilesBackend implements MemoryFilesBackendApi {
  /** 后端自述：dream / govern 缺席 = 「没装就没有」，不是降级——文件档没有整理管线。 */
  private static readonly Descriptor: MemoryBackendDescriptor = Object.freeze({
    id: MemoryBackendIds.files,
    role: 'authority',
    displayName: '记忆文件（markdown 权威层）',
    verbs: Object.freeze(['capture', 'recall', 'inspect', 'archive'] as const),
  })

  public readonly descriptor = MemoryFilesBackend.Descriptor

  private readonly log = Log.tag('MemoryFilesBackend')
  private readonly io: MemoryFilesIo
  private readonly indexFileName: string
  private readonly entriesDirectoryName: string
  private readonly now: () => number
  /** 已经报过的越界路径；同一个坏索引不必每次召回都刷一条日志。 */
  private readonly reportedOutOfBoundsPaths = new Set<string>()
  /** 每个根的「稳定键 → 条目路径」映射，按条目集合的签名失效。 */
  private readonly stableKeyCache = new Map<string, StableKeyCacheEntry>()

  public constructor(private readonly options: MemoryFilesBackendOptions) {
    this.io = options.io ?? new InMemoryMemoryFilesIo()
    this.indexFileName = options.indexFileName ?? MemoryFilesLayout.indexFileName
    this.entriesDirectoryName = options.entriesDirectoryName ?? MemoryFilesLayout.entriesDirectoryName
    this.now = options.now ?? (() => Date.now())
    // 目录名与索引文件名由宿主注入，同样要过一段名字的判定：宿主传进一个 `../..`
    // 就等于把后面每一道条目路径判定都建在沙子上。
    if (!isMemoryFileSegment(this.entriesDirectoryName) || !isMemoryFileSegment(this.indexFileName)) {
      throw new AppError(
        'INVARIANT',
        'memory-files 后端的条目目录名与索引文件名必须是单段安全名字（不含路径分隔符、`.`、`..`）。',
      )
    }
  }

  public capture(input: MemoryEvidenceInput): MemoryCaptureResult {
    // 落盘前先过全仓同一道证据清洗：秘密打码、正文与标题截断、空内容拒收。
    // 文件后端是出厂默认的权威层，清洗漏在这里 = 用户在聊天里贴的 key 原样进了跟着 git 走的目录。
    const evidenceInput = sanitizeMemoryEvidenceInput(input)
    const timestamp = evidenceInput.occurredAt ?? this.now()
    const title = (evidenceInput.title ?? '').trim() || firstLine(evidenceInput.content) || 'memory'
    const category: MemoryEvidenceCategory = evidenceInput.category ?? 'fact'
    const stableKey = (evidenceInput.sourceId ?? '').trim()
      || hashStableKey(`${evidenceInput.sourceType}|${title}|${evidenceInput.content}`)

    const root = this.resolveWriteRoot(evidenceInput)
    if (isNull(root))
      return this.rejectCapture({ input: evidenceInput, title, category, timestamp, stableKey })

    const index = this.readIndex(root)
    const existingPath = this.findPathByStableKey(root, stableKey)
    const relativePath = existingPath ?? this.allocatePath(root, index, title)
    const absolutePath = this.resolveEntryPath(root, relativePath)
    if (isNull(absolutePath)) {
      throw new AppError(
        'INVARIANT',
        `memory-files 算出了越界的条目路径：${relativePath}`,
      )
    }

    const previousRaw = this.io.readTextFile(absolutePath)
    const previous = isNull(previousRaw)
      ? undefined
      : parseMemoryFileDocument(previousRaw, title)

    const description = redactMemorySecrets(
      (
        readMetadataString(evidenceInput.metadata, 'summary')
        || previous?.description
        || firstLine(evidenceInput.content)
      ).slice(0, MemoryTuning.files.descriptionMaxChars),
    )
    // 归档是用户的决定：同一来源再采集只更新内容，不解除归档、也不把索引行放回去。
    // （Desktop 每次保存会话状态都重放整段对话，不守住这一条，用户归档的条目下一次保存就复活。）
    const archived = previous?.attributes.status === MemoryFilesArchivedStatus

    const document = serializeMemoryFileDocument({
      name: title,
      description,
      type: category,
      attributes: redactAttributes({
        // 未知字段原样带回：用户或未来档写下的东西不归本后端处置。
        ...previous?.attributes,
        id: stableKey,
        scope: root.scopeId,
        scopeType: root.scopeType,
        stableKey,
        source: readMetadataString(evidenceInput.metadata, 'source') || evidenceInput.sourceType,
        sourceType: evidenceInput.sourceType,
        trust: evidenceInput.trustLevel,
        privacy: evidenceInput.privacyClass ?? 'standard',
        status: archived ? MemoryFilesArchivedStatus : 'active',
        created: previous?.attributes.created ?? String(timestamp),
        updated: String(timestamp),
        ...optionalTags(evidenceInput.metadata),
      }),
      body: evidenceInput.content.trim(),
    })

    const inserted = isNull(previousRaw) || previousRaw !== document
    if (inserted) {
      this.io.ensureDirectory(this.io.join(root.directory, this.entriesDirectoryName))
      this.io.writeTextFile(absolutePath, document)
      if (!archived) {
        this.writeIndex(
          root,
          upsertMemoryIndexEntry(index, { path: relativePath, name: title, description }),
        )
      }
      this.rememberStableKeyPath(root, stableKey, relativePath)
    }

    return {
      evidence: toEvidenceRecord({
        input: evidenceInput,
        scopeType: root.scopeType,
        scopeId: root.scopeId,
        id: `${root.scopeId}${MemoryFilesEntryIdSeparator}${relativePath}`,
        title,
        category,
        timestamp,
        stableKey,
      }),
      inserted,
    }
  }

  public captureBatch(
    inputs: readonly MemoryEvidenceInput[],
    _options?: MemoryBackendCaptureBatchOptions,
  ): MemoryCaptureBatchResult {
    // 文件后端写入即最终态，没有整理管线，`consolidate` 无意义（有意忽略）。
    const evidence: MemoryEvidenceRecord[] = []
    let insertedCount = 0
    for (const input of inputs) {
      const result = this.capture(input)
      evidence.push(result.evidence)
      if (result.inserted) insertedCount += 1
    }
    return { evidence, insertedCount, treeVersion: 0 }
  }

  public recall(query: string, options: MemoryRecallOptions = {}): MemoryRecallItem[] {
    const roots = this.resolveReadRoots(options)
    if (isEmpty(roots)) return []

    const limit = Math.max(1, Math.min(options.limit ?? MemoryTuning.files.defaultRecallLimit, MemoryTuning.files.maxRecallLimit))
    const tokens = tokenize(query ?? '')
    const candidates: ScoredCandidate[] = []
    let order = 0

    for (const root of roots) {
      // 归档条目已经从索引里撤走，深层召回才把目录里的残余条目一并纳入候选。
      for (const entry of this.listCandidateEntries(root, isTrue(options.includeDormant))) {
        const score = isEmpty(tokens)
          ? 1
          : scoreIndexEntry(entry, tokens)
        order += 1
        if (score > 0) candidates.push({ root, entry, score, order })
      }
    }

    candidates.sort((left, right) =>
      right.score - left.score || right.order - left.order)

    // 按需全文：只对索引命中的头部候选读文件。
    //
    // 上限分两档，因为过滤发生在**读到的全文**上：不带内容级过滤时 24 份就是结果本身；带过滤时
    // 24 份是个先截断后过滤的窗口，聊天采集开着的时候最近 24 条全是会话条目，`memory:search`
    // 的画像召回（`categories`）于是稳定返回 0 条。带过滤时按筛过的算，扫描量另有上限。
    const budget = hasContentFilter(options)
      ? MemoryTuning.files.maxFilteredFullTextScansPerRecall
      : MemoryTuning.files.maxFullTextReadsPerRecall
    const items: MemoryRecallItem[] = []
    for (const candidate of candidates.slice(0, budget)) {
      if (items.length >= limit) break
      const loaded = this.loadEntry(candidate.root, candidate.entry)
      if (!loaded) continue
      const item = toRecallItem(
        candidate.root,
        candidate.entry,
        loaded.document,
        isEmpty(tokens) ? 'recent' : 'text',
      )
      // 过滤判据与叠加编排的语义通道同一处（`isMemoryRecallItemExcluded`）；
      // 权威层读得到确切类别，直接交给判据，不必按概念类型反推。
      if (isMemoryRecallItemExcluded(item, options, { category: loaded.document.type })) continue
      items.push(item)
    }
    return items
  }

  public getItem(id: string): Nullable<MemoryRecallItem> {
    const parsed = this.parseEntryId(id)
    if (!parsed) return null
    const root = this.listRoots().find((candidate) => candidate.scopeId === parsed.scopeId)
    if (!root) return null
    const entry = this.readIndex(root).find((candidate) => candidate.path === parsed.path)
      ?? { path: parsed.path, name: parsed.path, description: '' }
    const loaded = this.loadEntry(root, entry)
    return loaded ? toRecallItem(root, entry, loaded.document, 'scope') : null
  }

  /**
   * 权威层全量枚举（`MemoryAuthorityEnumeration` 端口）——派生索引重建的唯一正当入口。
   *
   * 为什么不用 `recall('')` 代替：普通召回有 `limit` 与「按需全文」上限（一次最多读 24 份），
   * 那是**性能承诺**，不是缺陷。拿它当枚举会重建出一份看起来在工作的残缺索引，而残缺索引比
   * 没有索引更坏。因此枚举是一个独立方法，逐条 yield（不把整个记忆库先堆进数组）。
   *
   * 含已归档条目：归档只是退出普通召回，内容仍在权威层——派生索引把它一并收下，
   * `includeDormant` 的深层召回才不会因为「索引里没有」而失灵。
   */
  public *listAll(): Iterable<MemoryRecallItem> {
    for (const root of this.listRoots()) {
      for (const entry of this.listCandidateEntries(root, true)) {
        const loaded = this.loadEntry(root, entry)
        if (!loaded) continue
        yield toRecallItem(root, entry, loaded.document, 'scope')
      }
    }
  }

  public inspect(): MemoryBackendStats {
    const roots = this.listRoots()
    let itemCount = 0
    const details: Record<string, number | string> = { rootCount: roots.length }
    for (const root of roots) {
      const count = this.readIndex(root).length
      itemCount += count
      details[`scope:${root.scopeId}`] = count
    }
    return {
      backendId: MemoryBackendIds.files,
      itemCount,
      // 文件后端没有待整理队列：写入即最终态。
      pendingCount: 0,
      version: 0,
      details,
    }
  }

  /**
   * 归档一条记忆：撤索引行 + 标 `status: archived`。
   *
   * **文件不删**。这是 §九 9.4「权威内容永不静默硬删」的落点，也和 `memory:archive` 工具
   * 「自然遗忘不是物理删除」的产品语义对齐——归档后仍可被 `includeDormant` 深层召回捞回。
   *
   * 认不出、越界、不存在的 id 一律抛 `NOT_FOUND`（与树后端同口径）：从前回一个空的
   * `affectedEvidenceIds`、工具照样对用户说「已归档」，模型拿错 id 也不会发现。
   */
  public archive(id: string): MemoryForgetResult {
    const parsed = this.parseEntryId(id)
    const root = parsed
      ? this.listRoots().find((candidate) => candidate.scopeId === parsed.scopeId)
      : undefined
    const absolutePath = parsed && root ? this.resolveEntryPath(root, parsed.path) : null
    const raw = isNotNull(absolutePath) ? this.io.readTextFile(absolutePath) : null
    if (!parsed || !root || isNull(absolutePath) || isNull(raw)) {
      throw new AppError('NOT_FOUND', `记忆不存在：${id}`)
    }
    // 只读根（别人 clone 来的共享记忆）不接受写入：条目在，但归档不成，如实回空。
    if (root.readOnly) return { claimId: id, affectedEvidenceIds: [], treeVersion: 0 }

    const document = parseMemoryFileDocument(raw, parsed.path)
    this.io.writeTextFile(
      absolutePath,
      serializeMemoryFileDocument({
        name: document.name,
        description: document.description,
        type: document.type,
        attributes: {
          ...document.attributes,
          status: MemoryFilesArchivedStatus,
          updated: String(this.now()),
        },
        body: document.body,
      }),
    )
    this.writeIndex(root, removeMemoryIndexEntry(this.readIndex(root), parsed.path))
    return { claimId: id, affectedEvidenceIds: [id], treeVersion: 0 }
  }

  private listRoots(): readonly MemoryFilesScopeRoot[] {
    const { roots } = this.options
    return isFunction(roots) ? roots() : roots
  }

  /**
   * 条目 id → 作用域与相对路径；路径形状不合的一律当作认不出（返回 null）。
   *
   * id 的分隔符是双冒号，scopeId 里可能自带 `:`（`project:/a/b`），因此取**最后一个**分隔符。
   */
  private parseEntryId(id: string): Nullable<{ scopeId: string; path: string }> {
    const separator = id.lastIndexOf(MemoryFilesEntryIdSeparator)
    if (separator <= 0) return null
    const path = id.slice(separator + MemoryFilesEntryIdSeparator.length)
    if (!isMemoryEntryPath(path, this.entriesDirectoryName)) {
      this.reportOutOfBoundsPath(id)
      return null
    }
    return { scopeId: id.slice(0, separator), path }
  }

  /**
   * 条目相对路径 → 磁盘绝对路径；越界回 null（调用方当作不存在）。
   *
   * 两道判定：① 路径形状只认 `<条目目录>/<名>.md`，文本判定挡住 `..`、绝对路径、反斜杠与子目录；
   * ② 端口能解符号链接时，真实路径必须还在本作用域根里——条目目录里一个指向仓外凭据文件的
   * 符号链接，文本判定看不出来。
   */
  private resolveEntryPath(
    root: MemoryFilesScopeRoot,
    relativePath: string,
  ): Nullable<string> {
    if (!isMemoryEntryPath(relativePath, this.entriesDirectoryName)) {
      this.reportOutOfBoundsPath(`${root.scopeId}${MemoryFilesEntryIdSeparator}${relativePath}`)
      return null
    }
    const absolutePath = this.io.join(root.directory, relativePath)
    if (this.io.isInsideDirectory && !this.io.isInsideDirectory(absolutePath, root.directory)) {
      this.reportOutOfBoundsPath(`${root.scopeId}${MemoryFilesEntryIdSeparator}${relativePath}`)
      return null
    }
    return absolutePath
  }

  /** 越界路径记一条诊断；同一条只报一次，报满上限后停手（日志不跟着坏索引涨）。 */
  private reportOutOfBoundsPath(reference: string): void {
    if (this.reportedOutOfBoundsPaths.size >= MemoryTuning.files.reportedOutOfBoundsPaths) return
    if (this.reportedOutOfBoundsPaths.has(reference)) return
    this.reportedOutOfBoundsPaths.add(reference)
    this.log.warn('记忆条目路径越界，已跳过', { reference })
  }

  /**
   * 这条证据往哪个根写；作用域说了是哪个池子而宿主没给对应的根时**拒收**（返回 null）。
   *
   * 从前是兜底：`workspace` 型取「任意一个项目根」，否则回落 global 或第一个根。于是
   * `project:/other` 的证据写进当前项目 `/repo` 的目录（跨项目污染，而且会被 `/repo` 的会话
   * 召回到），`site:` 的写进系统池（此后在系统空间可见）。作用域是隔离语义，不是检索偏好，
   * 写错池子比不写坏得多——宿主少给一条根应该看见诊断，而不是让记忆静默流进别的池子。
   */
  private resolveWriteRoot(input: MemoryEvidenceInput): Nullable<MemoryFilesScopeRoot> {
    const roots = this.listRoots().filter((root) => !isTrue(root.readOnly))
    if (isEmpty(roots)) {
      throw new AppError(
        'INVARIANT',
        'memory-files 后端没有可写的作用域根；宿主必须注入至少一个目录。',
      )
    }
    // 两轴解析走单源：scopeId 在场即权威，缺席时由 workspaceRoot 物化出 `project:<root>`。
    // 历史实现在这里做过 `scopeId.endsWith(workspaceRoot)` 的后缀兜底，会把
    // `project:/backup/a/b` 当成 `/a/b` 的根写进去——落错池子且在本空间再也召回不到。
    const selector = resolveMemoryScopeSelector(input)
    // 两轴皆空 = 调用方没说作用域（管理面、无空间宿主）：这时才有兜底可言。
    if (!selector) return roots.find((root) => root.scopeType === 'global') ?? roots[0]
    return toNullable(roots.find((root) => root.scopeId === selector))
  }

  /** 找不到对应根时的拒收回执：作用域照实回，不改写；`inserted: false` 且没有条目 id。 */
  private rejectCapture(context: {
    input: MemoryEvidenceInput
    title: string
    category: MemoryEvidenceCategory
    timestamp: number
    stableKey: string
  }): MemoryCaptureResult {
    const scopeId = resolveMemoryScopeSelector(context.input)
    this.log.warn('证据的作用域没有对应的可写根，已拒收（不落进别的池子）', {
      scopeId,
      sourceType: context.input.sourceType,
    })
    return {
      evidence: toEvidenceRecord({
        ...context,
        scopeType: context.input.scopeType ?? scopeTypeForScopeId(scopeId),
        scopeId,
        id: '',
      }),
      inserted: false,
    }
  }

  private resolveReadRoots(options: MemoryRecallOptions): readonly MemoryFilesScopeRoot[] {
    // 可见性判据单源（`isMemoryVisibleInScope`）：两轴皆空时它对每条根都返回 true，
    // 因此「不过滤」这一档不必在这里再写一遍。
    return this.listRoots().filter((root) =>
      isMemoryVisibleInScope(root, {
        scopeId: options.scopeId,
        workspaceRoot: options.workspaceRoot,
        includeGlobal: isFalse(options.includeGlobal) ? false : undefined,
      }),
    )
  }

  private readIndex(root: MemoryFilesScopeRoot): MemoryIndexEntry[] {
    const raw = this.io.readTextFile(this.io.join(root.directory, this.indexFileName))
    const entries = parseMemoryIndex(raw, {
      entriesDirectoryName: this.entriesDirectoryName,
      onRejectedPath: (path) =>
        this.reportOutOfBoundsPath(`${root.scopeId}${MemoryFilesEntryIdSeparator}${path}`),
    })
    if (!isEmpty(entries) || isNotNull(raw)) return entries
    // 索引缺席但目录里有条目文件（用户手动拷进来 / 索引被误删）：按目录重建，绝不当作空记忆。
    return this.scanEntriesDirectory(root)
  }

  /**
   * 召回候选集。
   *
   * 常规召回只看索引（这是「索引常驻、全文按需」的性能承诺）；深层召回额外扫一遍条目目录，
   * 把已归档、以及用户手动拷进来还没进索引的文件一并纳入。
   */
  private listCandidateEntries(
    root: MemoryFilesScopeRoot,
    includeArchived: boolean,
  ): MemoryIndexEntry[] {
    const indexed = this.readIndex(root)
    if (!includeArchived) return indexed
    const known = new Set(indexed.map((entry) => entry.path))
    return [
      ...indexed,
      ...this.scanEntriesDirectory(root).filter((entry) => !known.has(entry.path)),
    ]
  }

  private scanEntriesDirectory(root: MemoryFilesScopeRoot): MemoryIndexEntry[] {
    return this.io
      .listFiles(this.io.join(root.directory, this.entriesDirectoryName))
      .filter((name) => isMemoryEntryFileName(name, this.entriesDirectoryName))
      .map((name) => {
        const path = `${this.entriesDirectoryName}/${name}`
        const document = this.loadDocument(root, path)
        return {
          path,
          name: document?.name ?? name.replace(/\.md$/u, ''),
          description: document?.description ?? '',
        }
      })
  }

  private writeIndex(root: MemoryFilesScopeRoot, entries: readonly MemoryIndexEntry[]): void {
    if (root.readOnly) return
    this.io.ensureDirectory(root.directory)
    this.io.writeTextFile(
      this.io.join(root.directory, this.indexFileName),
      serializeMemoryIndex(entries),
    )
  }

  /**
   * 稳定键 → 条目路径。
   *
   * **覆盖整个条目目录（含已归档）**：归档已经把索引行撤走了，只在索引里找就会让同一来源的
   * 下一次采集新建一个 `-2` 文件、以在用状态复活——Desktop 每次保存会话状态都重放整段对话，
   * 用户归档的条目下一次保存就回来了。
   *
   * 映射按「索引文本 + 条目目录清单」这道签名缓存在进程内：从前每写一条都把索引里的每个文件
   * 读一遍，400 条时写 1 条读 403 个文件，还全是同步 fs、跑在 Electron 主进程上。签名对不上
   * （外部编辑器改过）就整份重建。
   */
  private findPathByStableKey(
    root: MemoryFilesScopeRoot,
    stableKey: string,
  ): string | undefined {
    return this.stableKeyPaths(root).get(stableKey)
  }

  private stableKeyPaths(root: MemoryFilesScopeRoot): Map<string, string> {
    const signature = this.entriesSignature(root)
    const cached = this.stableKeyCache.get(root.directory)
    if (cached && cached.signature === signature) return cached.paths

    const paths = new Map<string, string>()
    for (const entry of this.listCandidateEntries(root, true)) {
      const key = this.loadDocument(root, entry.path)?.attributes.stableKey
      if (key) paths.set(key, entry.path)
    }
    this.stableKeyCache.set(root.directory, { signature, paths })
    return paths
  }

  /** 写完一条之后就地更新映射，省下一次全目录重扫（签名重算只是一次读 + 一次列目录）。 */
  private rememberStableKeyPath(
    root: MemoryFilesScopeRoot,
    stableKey: string,
    relativePath: string,
  ): void {
    const cached = this.stableKeyCache.get(root.directory)
    if (!cached) return
    cached.paths.set(stableKey, relativePath)
    cached.signature = this.entriesSignature(root)
  }

  /** 条目集合的指纹：索引文本 + 条目目录清单。任一变化就重建稳定键映射。 */
  private entriesSignature(root: MemoryFilesScopeRoot): string {
    const index = this.io.readTextFile(this.io.join(root.directory, this.indexFileName)) ?? ''
    const names = this.io.listFiles(this.io.join(root.directory, this.entriesDirectoryName))
    return JSON.stringify([index, names])
  }

  private allocatePath(
    root: MemoryFilesScopeRoot,
    entries: readonly MemoryIndexEntry[],
    title: string,
  ): string {
    const base = slugify(title)
    const taken = new Set(entries.map((entry) => entry.path))
    for (let suffix = 0; suffix < MemoryTuning.files.pathAllocationAttempts; suffix += 1) {
      const path = `${this.entriesDirectoryName}/${suffix === 0 ? base : `${base}-${suffix + 1}`}.md`
      const absolutePath = this.resolveEntryPath(root, path)
      if (taken.has(path) || isNull(absolutePath)) continue
      if (isNull(this.io.readTextFile(absolutePath))) return path
    }
    return `${this.entriesDirectoryName}/${base}-${hashStableKey(title)}.md`
  }

  private loadDocument(
    root: MemoryFilesScopeRoot,
    relativePath: string,
  ): Nullable<MemoryFileDocument> {
    const absolutePath = this.resolveEntryPath(root, relativePath)
    if (isNull(absolutePath)) return null
    const raw = this.io.readTextFile(absolutePath)
    if (isNull(raw)) return null
    return parseMemoryFileDocument(raw, relativePath.replace(/^.*\//u, '').replace(/\.md$/iu, ''))
  }

  private loadEntry(
    root: MemoryFilesScopeRoot,
    entry: MemoryIndexEntry,
  ): Nullable<{ document: MemoryFileDocument }> {
    const document = this.loadDocument(root, entry.path)
    return document ? { document } : null
  }


}

/**
 * 构造一个 `memory-files` 后端。所有路径由宿主注入；包内不认识 userData 或仓根。
 *
 * 返回类型带上 `MemoryAuthorityEnumeration`：本档**自带全量枚举**，因此叠加编排不需要
 * 宿主再注入一个枚举源，装上派生索引即可重建。
 */
export function createMemoryFilesBackend(
  options: MemoryFilesBackendOptions,
): MemoryFilesBackendApi {
  return new MemoryFilesBackend(options)
}
