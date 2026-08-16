/**
 * `memory-files` —— bundled 默认后端，**权威层**（kernel-contract §15.7 裁决四 / §九 9.1）。
 *
 * 形态：一个作用域一个目录，目录里是 markdown + frontmatter，外加一个 `MEMORY.md` 索引
 * （一行一条）。检索 = 索引行匹配 + 命中后按需读全文。零依赖：无模型、无原生模块、无
 * 嵌入——BYOK 免费模式下不装任何东西也要全功能（§13 在记忆域的兑现）。
 *
 * 权威层的三条硬要求正是选文件的理由：**人可读、可手改、可 diff 可版本化**。因此：
 * - 后端从不假设自己是唯一写者：每次读都重新解析磁盘，用户拿编辑器改一行立即生效；
 * - `archive` 就是归档（撤索引行 + 标 `status: archived`），从不物理删除——权威内容是用户资产；
 * - 不认识的 frontmatter 字段原样保留写回。
 *
 * 作用域双轨（§九 9.5）：全局面住宿主 userData，项目面住仓根 `.velaros/memory/` 随 git 走。
 * **两条路径全部由宿主注入**，本文件对宿主目录布局零假设。
 *
 * 与 `memory-vector` 叠加时，本后端仍是权威层：向量索引只返回指针，再由 `getItem`
 * 读取全文；capture 始终先写权威层，再更新派生索引。
 */

import {
  isArray,
  isEmpty,
  isFalse,
  isFunction,
  isNotNull,
  isNull,
  isString,
  isTrue,
  trimmedStringOrEmpty,
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type {
  MemoryBackendCaptureBatchOptions,
  MemoryBackendDescriptor,
  MemoryBackendStats,
  MemoryStoreBackend,
} from '../backend/Contract'
import type { MemoryAuthorityEnumeration } from '../backend/DerivedIndex'
import type {
  MemoryCaptureBatchResult,
  MemoryCaptureResult,
  MemoryConceptType,
  MemoryEvidenceCategory,
  MemoryEvidenceInput,
  MemoryEvidenceRecord,
  MemoryForgetResult,
  MemoryRecallItem,
  MemoryRecallOptions,
  MemoryScopeType,
} from '../memory-tree/Types'
import {
  isMemoryVisibleInScope,
  type MemoryScopeId,
  resolveMemoryScopeSelector,
} from '../MemoryScope'

import {
  type MemoryFileDocument,
  parseMemoryFileDocument,
  serializeMemoryFileDocument,
} from './Frontmatter'
import {
  type MemoryIndexEntry,
  MemoryIndexFileName,
  parseMemoryIndex,
  removeMemoryIndexEntry,
  serializeMemoryIndex,
  upsertMemoryIndexEntry,
} from './IndexFile'
import { createInMemoryMemoryFilesIo, type MemoryFilesIo } from './Io'

export const MemoryFilesBackendId = 'files'

/** id 分隔符：`<scopeId>::<相对路径>`。scopeId 里可能有 `:`（`project:/a/b`），故用双冒号。 */
const IdSeparator = '::'
const DefaultEntriesDirectory = 'entries'
/** 索引命中后最多读多少个全文——「按需全文」的上限，防止一次召回把整个记忆库读进内存。 */
const MaxFullTextReadsPerRecall = 24
const ArchivedStatus = 'archived'

/**
 * 一个作用域的磁盘落点。
 *
 * `directory` 由宿主注入：全局 = `<userData>/memory`，项目 = `<repoRoot>/.velaros/memory`。
 */
export interface MemoryFilesScopeRoot {
  readonly scopeType: MemoryScopeType
  readonly scopeId: MemoryScopeId
  readonly directory: string
  /** 只读根（如别人 clone 来的共享记忆）不接受写入；缺省可写。 */
  readonly readOnly?: boolean
}

export interface MemoryFilesBackendOptions {
  /**
   * 作用域根。传函数时每次调用都会重新求值——项目根随会话切换，宿主不必重建后端。
   */
  readonly roots:
    | readonly MemoryFilesScopeRoot[]
    | (() => readonly MemoryFilesScopeRoot[])
  /** 文件系统端口；缺省用纯内存实现（宿主须显式注入 `createNodeMemoryFilesIo()`）。 */
  readonly io?: MemoryFilesIo
  readonly indexFileName?: string
  readonly entriesDirectoryName?: string
  readonly now?: () => number
}

const filesDescriptor: MemoryBackendDescriptor = Object.freeze({
  id: MemoryFilesBackendId,
  role: 'authority',
  displayName: 'Memory files (markdown authority)',
  // dream / govern 缺席 = partial activation 的「没装就没有」，不是降级：
  // 文件后端没有整理管线，也没有证据可用性状态机。
  verbs: Object.freeze(['capture', 'recall', 'inspect', 'archive'] as const),
})

const conceptTypeByCategory: Readonly<Record<string, MemoryConceptType>> = {
  conversation: 'conversation',
  fact: 'entity',
  preference: 'user',
  feedback: 'user',
  procedure: 'procedure',
  project: 'project',
  task: 'task',
  goal: 'goal',
  interest: 'interest',
  entity: 'entity',
  artifact: 'artifact',
}

function slugify(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  return (normalized || 'memory').slice(0, 60).replace(/-+$/u, '') || 'memory'
}

function hash(value: string): string {
  // 稳定键只需要「同输入同输出、碰撞概率够低」，不做密码学承诺；权威层不靠它做安全判定。
  let h1 = 0x81_1c_9d_c5
  let h2 = 0x01_00_01_93
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    h1 = Math.imul(h1 ^ code, 0x01_00_01_93)
    h2 = Math.imul(h2 ^ (code + index), 0x85_eb_ca_6b)
  }
  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`
}

/**
 * 查询分词：空白/标点切词，CJK 连续段额外产生 2-gram。
 *
 * 中文不带空格，纯按空白切会把整句当成一个 token 而永不命中；2-gram 是零依赖前提下
 * 最便宜的可用近似。语义匹配由可选的 `memory-vector` 负责，本层提供可靠的词法回退。
 */
function tokenize(value: string): string[] {
  const lowered = value.toLowerCase()
  const tokens = new Set<string>()
  for (const raw of lowered.split(/[^\p{Letter}\p{Number}]+/u)) {
    if (raw.length === 0) continue
    if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+$/u.test(raw)) {
      if (raw.length === 1) tokens.add(raw)
      for (let index = 0; index + 1 < raw.length; index += 1) {
        tokens.add(raw.slice(index, index + 2))
      }
      continue
    }
    if (raw.length >= 2) tokens.add(raw)
  }
  return [...tokens]
}

interface ScoredCandidate {
  readonly root: MemoryFilesScopeRoot
  readonly entry: MemoryIndexEntry
  readonly score: number
  readonly order: number
}

class MemoryFilesBackend implements MemoryStoreBackend {
  public readonly descriptor = filesDescriptor

  private readonly io: MemoryFilesIo
  private readonly indexFileName: string
  private readonly entriesDirectoryName: string
  private readonly now: () => number

  public constructor(private readonly options: MemoryFilesBackendOptions) {
    this.io = options.io ?? createInMemoryMemoryFilesIo()
    this.indexFileName = options.indexFileName ?? MemoryIndexFileName
    this.entriesDirectoryName = options.entriesDirectoryName ?? DefaultEntriesDirectory
    this.now = options.now ?? (() => Date.now())
  }

  public capture(input: MemoryEvidenceInput): MemoryCaptureResult {
    const root = this.resolveWriteRoot(input)
    const timestamp = input.occurredAt ?? this.now()
    const title = (input.title ?? '').trim() || firstLine(input.content) || 'memory'
    const category: MemoryEvidenceCategory = input.category ?? 'fact'
    const stableKey = (input.sourceId ?? '').trim()
      || hash(`${input.sourceType}|${title}|${input.content}`)

    const index = this.readIndex(root)
    const existingPath = this.findPathByStableKey(root, index, stableKey)
    const relativePath = existingPath ?? this.allocatePath(root, index, title)
    const absolutePath = this.io.join(root.directory, relativePath)

    const previousRaw = this.io.readTextFile(absolutePath)
    const previous = isNull(previousRaw)
      ? undefined
      : parseMemoryFileDocument(previousRaw, title)

    const description = (
      readMetadataString(input.metadata, 'summary')
      || previous?.description
      || firstLine(input.content)
    ).slice(0, 400)

    const document = serializeMemoryFileDocument({
      name: title,
      description,
      type: category,
      attributes: {
        // 未知字段原样带回：用户或未来档写下的东西不归本后端处置。
        ...previous?.attributes,
        id: stableKey,
        scope: root.scopeId,
        scopeType: root.scopeType,
        stableKey,
        source: readMetadataString(input.metadata, 'source') || input.sourceType,
        sourceType: input.sourceType,
        trust: input.trustLevel,
        privacy: input.privacyClass ?? 'standard',
        status: 'active',
        created: previous?.attributes.created ?? String(timestamp),
        updated: String(timestamp),
        ...optionalTags(input.metadata),
      },
      body: input.content.trim(),
    })

    const inserted = isNull(previousRaw) || previousRaw !== document
    if (inserted) {
      this.io.ensureDirectory(this.io.join(root.directory, this.entriesDirectoryName))
      this.io.writeTextFile(absolutePath, document)
      this.writeIndex(
        root,
        upsertMemoryIndexEntry(index, { path: relativePath, name: title, description }),
      )
    }

    return {
      evidence: this.toEvidenceRecord({
        input,
        root,
        relativePath,
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

    const limit = Math.max(1, Math.min(options.limit ?? 10, 100))
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

    const categories = options.categories?.length ? new Set(options.categories) : undefined
    const excludedSourceTypes = options.excludeSourceTypes?.length
      ? new Set(options.excludeSourceTypes)
      : undefined
    const items: MemoryRecallItem[] = []
    // 按需全文：只对索引命中的头部候选读文件，类别过滤在读到的文档上完成。
    for (const candidate of candidates.slice(0, MaxFullTextReadsPerRecall)) {
      if (items.length >= limit) break
      const loaded = this.loadEntry(candidate.root, candidate.entry)
      if (!loaded) continue
      if (loaded.document.attributes.status === ArchivedStatus && !options.includeDormant) continue
      if (categories && !categories.has(loaded.document.type as MemoryEvidenceCategory)) continue
      if (options.excludeConversationObservations && loaded.document.type === 'conversation') continue
      if (
        excludedSourceTypes
        && excludedSourceTypes.has(
          loaded.document.attributes.sourceType as MemoryEvidenceInput['sourceType']
        )
      ) continue
      items.push(
        this.toRecallItem(
          candidate.root,
          candidate.entry,
          loaded.document,
          isEmpty(tokens) ? 'recent' : 'text',
        ),
      )
    }
    return items
  }

  public getItem(id: string): Nullable<MemoryRecallItem> {
    const parsed = parseEntryId(id)
    if (!parsed) return null
    const root = this.listRoots().find((candidate) => candidate.scopeId === parsed.scopeId)
    if (!root) return null
    const entry = this.readIndex(root).find((candidate) => candidate.path === parsed.path)
      ?? { path: parsed.path, name: parsed.path, description: '' }
    const loaded = this.loadEntry(root, entry)
    return loaded ? this.toRecallItem(root, entry, loaded.document, 'scope') : null
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
        yield this.toRecallItem(root, entry, loaded.document, 'scope')
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
      backendId: MemoryFilesBackendId,
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
   */
  public archive(id: string): MemoryForgetResult {
    const parsed = parseEntryId(id)
    if (!parsed) return { claimId: id, affectedEvidenceIds: [], treeVersion: 0 }
    const root = this.listRoots().find((candidate) => candidate.scopeId === parsed.scopeId)
    if (!root || root.readOnly) return { claimId: id, affectedEvidenceIds: [], treeVersion: 0 }

    const absolutePath = this.io.join(root.directory, parsed.path)
    const raw = this.io.readTextFile(absolutePath)
    if (isNotNull(raw)) {
      const document = parseMemoryFileDocument(raw, parsed.path)
      this.io.writeTextFile(
        absolutePath,
        serializeMemoryFileDocument({
          name: document.name,
          description: document.description,
          type: document.type,
          attributes: {
            ...document.attributes,
            status: ArchivedStatus,
            updated: String(this.now()),
          },
          body: document.body,
        }),
      )
    }
    this.writeIndex(root, removeMemoryIndexEntry(this.readIndex(root), parsed.path))
    return { claimId: id, affectedEvidenceIds: [id], treeVersion: 0 }
  }

  private listRoots(): readonly MemoryFilesScopeRoot[] {
    const { roots } = this.options
    return isFunction(roots) ? roots() : roots
  }

  private resolveWriteRoot(input: MemoryEvidenceInput): MemoryFilesScopeRoot {
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
    const bySelector = selector
      ? roots.find((root) => root.scopeId === selector)
      : undefined
    if (bySelector) return bySelector

    if (input.scopeType === 'workspace') {
      const anyProject = roots.find((root) => root.scopeType === 'workspace')
      if (anyProject) return anyProject
    }
    return roots.find((root) => root.scopeType === 'global') ?? roots[0]
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
    const entries = parseMemoryIndex(raw)
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
      .filter((name) => name.endsWith('.md'))
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

  private findPathByStableKey(
    root: MemoryFilesScopeRoot,
    entries: readonly MemoryIndexEntry[],
    stableKey: string,
  ): string | undefined {
    for (const entry of entries) {
      if (this.loadDocument(root, entry.path)?.attributes.stableKey === stableKey) return entry.path
    }
    return undefined
  }

  private allocatePath(
    root: MemoryFilesScopeRoot,
    entries: readonly MemoryIndexEntry[],
    title: string,
  ): string {
    const base = slugify(title)
    const taken = new Set(entries.map((entry) => entry.path))
    for (let suffix = 0; suffix < 1000; suffix += 1) {
      const path = `${this.entriesDirectoryName}/${suffix === 0 ? base : `${base}-${suffix + 1}`}.md`
      if (
        !taken.has(path)
        && isNull(this.io.readTextFile(this.io.join(root.directory, path)))
      ) return path
    }
    return `${this.entriesDirectoryName}/${base}-${hash(title)}.md`
  }

  private loadDocument(
    root: MemoryFilesScopeRoot,
    relativePath: string,
  ): Nullable<MemoryFileDocument> {
    const raw = this.io.readTextFile(this.io.join(root.directory, relativePath))
    if (isNull(raw)) return null
    return parseMemoryFileDocument(raw, relativePath.replace(/^.*\//u, '').replace(/\.md$/u, ''))
  }

  private loadEntry(
    root: MemoryFilesScopeRoot,
    entry: MemoryIndexEntry,
  ): Nullable<{ document: MemoryFileDocument }> {
    const document = this.loadDocument(root, entry.path)
    return document ? { document } : null
  }

  private toRecallItem(
    root: MemoryFilesScopeRoot,
    entry: MemoryIndexEntry,
    document: MemoryFileDocument,
    retrievalReason: MemoryRecallItem['retrievalReason'],
  ): MemoryRecallItem {
    const id = `${root.scopeId}${IdSeparator}${entry.path}`
    const updatedAt = Number.parseInt(document.attributes.updated ?? '', 10)
    return {
      id,
      claimId: id,
      conceptId: entry.path,
      conceptType: conceptTypeByCategory[document.type] ?? 'entity',
      predicate: 'memory',
      title: document.name || entry.name,
      summary: document.description || entry.description,
      value: document.body,
      scopeType: root.scopeType,
      scopeId: root.scopeId,
      // 权威层的内容是被写下来的原文，不存在树后端那种「由证据推断」的置信度衰减。
      confidence: 1,
      salience: 1,
      activation: document.attributes.status === ArchivedStatus ? 0 : 1,
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
      snapshotVersion: 0,
      retrievalReason,
      evidenceIds: [id],
      sourceTypes: document.attributes.sourceType
        ? [document.attributes.sourceType as MemoryEvidenceInput['sourceType']]
        : [],
      // 文件后端没有树投影：路径为空是诚实回答，不是缺陷。
      path: [],
    }
  }

  private toEvidenceRecord(input: {
    input: MemoryEvidenceInput
    root: MemoryFilesScopeRoot
    relativePath: string
    title: string
    category: MemoryEvidenceCategory
    timestamp: number
    stableKey: string
  }): MemoryEvidenceRecord {
    return {
      id: `${input.root.scopeId}${IdSeparator}${input.relativePath}`,
      sourceType: input.input.sourceType,
      trustLevel: input.input.trustLevel,
      sourceId: input.stableKey,
      sessionId: input.input.sessionId ?? '',
      executionId: input.input.executionId ?? '',
      workspaceRoot: input.input.workspaceRoot ?? '',
      scopeType: input.root.scopeType,
      scopeId: input.root.scopeId,
      occurredAt: input.timestamp,
      title: input.title,
      content: input.input.content,
      category: input.category,
      privacyClass: input.input.privacyClass ?? 'standard',
      eligibilityState: 'active',
      metadata: input.input.metadata ?? {},
      // 文件后端没有全局摄入序列：条目之间没有全序关系。
      ingestSequence: 0,
      createdAt: input.timestamp,
    }
  }
}

function scoreIndexEntry(entry: MemoryIndexEntry, tokens: readonly string[]): number {
  const name = entry.name.toLowerCase()
  const description = entry.description.toLowerCase()
  const path = entry.path.toLowerCase()
  let score = 0
  for (const token of tokens) {
    if (name.includes(token)) score += 3
    else if (path.includes(token)) score += 2
    else if (description.includes(token)) score += 1
  }
  return score
}

function parseEntryId(id: string): Nullable<{ scopeId: string; path: string }> {
  const separator = id.lastIndexOf(IdSeparator)
  if (separator <= 0) return null
  return {
    scopeId: id.slice(0, separator),
    path: id.slice(separator + IdSeparator.length),
  }
}

function firstLine(content: string): string {
  return (content ?? '').split('\n').map((line) => line.trim()).find(Boolean)?.slice(0, 120) ?? ''
}

function readMetadataString(
  metadata: LooseOptional<Record<string, unknown>>,
  key: string,
): string {
  const value = metadata?.[key]
  return trimmedStringOrEmpty(value)
}

function optionalTags(
  metadata: LooseOptional<Record<string, unknown>>,
): Record<string, string> {
  const tags = metadata?.tags
  if (!isArray(tags) || isEmpty(tags)) return {}
  const joined = tags.filter(isString).join(', ')
  return joined ? { tags: joined } : {}
}

/**
 * 构造一个 `memory-files` 后端。所有路径由宿主注入；包内不认识 userData 或仓根。
 *
 * 返回类型带上 `MemoryAuthorityEnumeration`：本档**自带全量枚举**，因此叠加编排不需要
 * 宿主再注入一个枚举源，装上派生索引即可重建。
 */
export function createMemoryFilesBackend(
  options: MemoryFilesBackendOptions,
): MemoryStoreBackend & MemoryAuthorityEnumeration {
  return new MemoryFilesBackend(options)
}
