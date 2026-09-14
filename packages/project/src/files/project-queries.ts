import {
  isEmpty,
  isNotNull,
  isObject,
  isPresent,
  isUndefined,
  optionalWhen,
} from '@velaros-ai/core'

import { type AuditJournal } from '../persistence/audit-journal.js'
import type { ProjectSymbol } from '../types/adapter.js'
import type { FileAdapter } from '../types/adapter.js'
import type { Range } from '../types/common.js'
import type { BuildEvidencePackInput, EvidencePack, TaskContext } from '../types/context.js'
import type { ProjectFileAccess } from '../types/file-access.js'
import type { HookEvent } from '../types/hook.js'
import type {
  FileListEntry,
  FileStatInput,
  FileStatResult,
  ObserveInput,
  ReadInput,
  ReadResult,
  SearchHit,
  SearchInput,
  SearchResult,
} from '../types/io.js'
import type { ProjectRuntimeProviders } from '../types/kernel.js'
import type { CorePolicy, PolicyDecisionInput } from '../types/policy.js'
import type { FileSnapshot, ProjectSnapshot } from '../types/snapshot.js'
import type { ResolvedTarget, ResolveTargetInput, ResolveTargetResult } from '../types/target.js'
import { matchesAny } from '../utils/glob.js'
import { id } from '../utils/id.js'

import { searchWithRipgrep } from './ripgrep.js'

interface ProjectQueryDependencies {
  readonly root: string
  readonly policy: CorePolicy
  readonly providers: ProjectRuntimeProviders
  readonly store: Pick<
    ProjectFileAccess,
    'snapshot' | 'read' | 'stat' | 'listFiles' | 'observe' | 'authorize'
  >
  readonly searchTextKind?: (path: string) => Promise<'native' | 'decoded' | 'excluded'>
  readonly journal: Pick<AuditJournal, 'record'>
  readonly decide: (
    action: PolicyDecisionInput['action'],
    paths?: string[],
    data?: unknown,
  ) => Promise<void>
  readonly enrichSnapshot: (snapshot: FileSnapshot) => Promise<FileSnapshot>
  readonly createAdapters: (snapshot: FileSnapshot) => Promise<FileAdapter[]>
  readonly emit: (event: HookEvent, data: unknown) => Promise<void>
  readonly transform: <T>(phase: string, input: T) => Promise<T>
}

function resolveEvidenceTargetRange(
  storedTarget?: ResolvedTarget,
  inputRange?: Partial<Range>,
): Range | undefined {
  if (storedTarget?.range) return storedTarget.range
  if (!inputRange || !isPresent(inputRange.startLine) || !isPresent(inputRange.endLine))
    return undefined
  const range: Range = {
    startLine: inputRange.startLine,
    endLine: inputRange.endLine,
  }
  if (isPresent(inputRange.startColumn)) range.startColumn = inputRange.startColumn
  if (isPresent(inputRange.endColumn)) range.endColumn = inputRange.endColumn
  if (isPresent(inputRange.startOffset)) range.startOffset = inputRange.startOffset
  if (isPresent(inputRange.endOffset)) range.endOffset = inputRange.endOffset
  return range
}

function symbolIdentityKey(symbol: ProjectSymbol): string {
  const start = isPresent(symbol.range.startOffset)
    ? String(symbol.range.startOffset)
    : `${symbol.range.startLine}:${symbol.range.startColumn ?? ''}`
  return [symbol.path, symbol.kind, symbol.container ?? '', symbol.name, start].join('\u0000')
}

function uniqueSymbols(symbols: ProjectSymbol[]): ProjectSymbol[] {
  const seen = new Set<string>()
  const unique: ProjectSymbol[] = []
  for (const symbol of symbols) {
    const key = symbolIdentityKey(symbol)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(symbol)
  }
  return unique
}

// 内存治理上限：长会话内核常驻时，避免 target/evidence/已结束事务无界增长。
const MaxRetainedTargets = 500
const MaxRetainedEvidence = 500
const DefaultImplicitSearchExcludeGlobs = [
  'node_modules/**',
  '.git/**',
  'dist/**',
  'coverage/**',
] as const
export class ProjectQueries {
  private targets = new Map<string, ResolvedTarget>()
  private evidence = new Map<string, EvidencePack>()
  constructor(private readonly dependencies: ProjectQueryDependencies) {}

  private defaultExcludeGitignoredForRoot(root?: string): boolean | undefined {
    const normalizedRoot = root?.trim()
    // 显式搜索子目录时默认保留 ignored 子项，避免用户点名的目录被整体跳过。
    return optionalWhen(normalizedRoot && normalizedRoot !== '.', false)
  }

  private resolveSearchExcludeGlobs(input: SearchInput): string[] {
    return [...this.defaultImplicitSearchExcludeGlobs(input.root), ...(input.exclude ?? [])]
  }

  private defaultImplicitSearchExcludeGlobs(root?: string): string[] {
    const normalizedRoot = root?.trim()
    if (normalizedRoot && normalizedRoot !== '.') return []
    return [...DefaultImplicitSearchExcludeGlobs]
  }

  /** 扫描工作区并返回文件快照列表。 */
  public async observe(input: ObserveInput = {}): Promise<ProjectSnapshot> {
    await this.dependencies.decide('search', undefined, input)
    const processed = await this.dependencies.transform('observe.input', input)
    const result = await this.dependencies.store.observe(processed)
    this.dependencies.journal.record({
      actor: 'system',
      action: 'observe',
      outputSummary: `${result.files.length} files`,
    })
    return result
  }

  /** 列出工作区内符合条件的文件和目录。 */
  public async listFiles(input: ObserveInput = {}): Promise<FileListEntry[]> {
    await this.dependencies.decide('search', undefined, input)
    return this.dependencies.store.listFiles(input)
  }

  /** 返回单个路径的轻量状态信息和建议读取范围。 */
  public async stat(input: FileStatInput): Promise<FileStatResult> {
    const access = await this.dependencies.store.authorize(input.path, 'read', '读取')
    const authorizedInput = { ...input, path: access.rel }
    await this.dependencies.decide('read', [access.rel], authorizedInput)
    return this.dependencies.store.stat(authorizedInput, { skipFileFilter: true })
  }

  /** 读取工作区文件内容，并执行权限、管线和脱敏处理。 */
  public async read(input: ReadInput): Promise<ReadResult> {
    await this.dependencies.emit('BeforeRead', input)
    const processed = await this.dependencies.transform('read.input', input)
    const access = await this.dependencies.store.authorize(processed.path, 'read', '读取')
    const authorizedInput = { ...processed, path: access.rel }
    await this.dependencies.decide('read', [access.rel], authorizedInput)
    let result = await this.dependencies.store.read(authorizedInput, { skipFileFilter: true })
    result.snapshot = await this.dependencies.enrichSnapshot(result.snapshot)
    if (result.content && this.dependencies.providers.secretRedaction) {
      const redacted = await this.dependencies.providers.secretRedaction.redact({
        path: result.snapshot.path,
        content: result.content,
        trust: input.trust,
      })
      result = { ...result, content: redacted.content, redacted: redacted.redacted }
    }
    await this.dependencies.emit('AfterRead', result)
    this.dependencies.journal.record({
      actor: 'system',
      action: 'read',
      path: result.snapshot.path,
      outputSummary: result.content ? `${result.content.length} chars` : 'binary/no content',
    })
    return result
  }

  /** 在工作区内搜索文本，并优先使用可用的快速搜索后端。 */
  public async search(input: SearchInput): Promise<SearchResult> {
    await this.dependencies.emit('BeforeSearch', input)
    await this.dependencies.decide('search', undefined, input)
    const processed = await this.dependencies.transform('search.input', input)
    const rootAccess = processed.root?.trim()
      ? await this.dependencies.store.authorize(processed.root, 'search', '搜索', {
          skipFileFilter: true,
        })
      : null
    const authorizedProcessed = rootAccess ? { ...processed, root: rootAccess.rel } : processed
    const maxResults = processed.maxResults ?? 50

    let backend: SearchResult['backend']
    let hits: SearchHit[] = []
    let truncated = false
    let toolRequirements: SearchResult['toolRequirements']

    const allowRg = this.dependencies.policy.enableRipgrepSearch && (processed.useRipgrep ?? true)

    if (allowRg) {
      try {
        const textKinds = await this.classifySearchFiles(authorizedProcessed)
        const rgResult = await searchWithRipgrep({
          rootAbs: this.dependencies.root,
          subdirRel: authorizedProcessed.root,
          query: authorizedProcessed.query,
          regex: !!processed.regex,
          caseSensitive: processed.caseSensitive,
          include: processed.include,
          exclude: this.resolveSearchExcludeGlobs(authorizedProcessed),
          excludeGitignored:
            processed.excludeGitignored ??
            this.defaultExcludeGitignoredForRoot(authorizedProcessed.root),
          maxResults,
          filterPath: optionalWhen(!!this.dependencies.searchTextKind, (path: string) => textKinds.get(path) === 'native'),
          command: this.dependencies.providers.command,
          policy: this.dependencies.policy,
        })
        if (rgResult.toolRequirements && !isEmpty(rgResult.toolRequirements)) {
          toolRequirements = rgResult.toolRequirements
        }
        if (isNotNull(rgResult.hits)) {
          backend = 'ripgrep'
          const enriched: SearchHit[] = []
          // 同一文件可能有多条命中：按路径缓存 revision，避免对同一文件重复整文件读取 + 哈希。
          const revisionByPath = new Map<string, string>()
          for (const hit of rgResult.hits) {
            const kind = textKinds.get(hit.path)
            if (this.dependencies.searchTextKind && kind !== 'native') continue
            if (matchesAny(hit.path, this.dependencies.policy.readDeny)) continue
            try {
              let revision = revisionByPath.get(hit.path)
              if (isUndefined(revision)) {
                revision = (await this.dependencies.store.snapshot(hit.path, false)).revision
                revisionByPath.set(hit.path, revision)
              }
              let snippet = hit.snippet
              if (snippet && this.dependencies.providers.secretRedaction) {
                snippet = (
                  await this.dependencies.providers.secretRedaction.redact({
                    path: hit.path,
                    content: snippet,
                    trust: { source: 'project', trust: 'untrusted' },
                  })
                ).content
              }
              enriched.push({
                ...hit,
                revision,
                snippet,
                trust: { source: 'project', trust: 'untrusted' },
              })
            } catch {
              // arch-guard:silent-catch-ok 单条搜索命中可能已不可读，跳过后继续处理其它命中。
              continue
            }
            if (enriched.length >= maxResults) break
          }
          const decodedPaths = [...textKinds].filter(([, kind]) => kind === 'decoded').map(([path]) => path)
          if (!isEmpty(decodedPaths) && enriched.length < maxResults) {
            const decoded = await this.searchViaAdapters(authorizedProcessed, maxResults - enriched.length, decodedPaths)
            enriched.push(...decoded.hits)
          }
          enriched.sort((a, b) => b.score - a.score)
          truncated =
            !!rgResult.timedOut ||
            !!rgResult.truncated ||
            rgResult.hits.length >= maxResults ||
            enriched.length >= maxResults
          hits = enriched.slice(0, maxResults)
          const result: SearchResult = {
            query: authorizedProcessed.query,
            hits,
            truncated,
            backend,
            diagnostics: rgResult.diagnostics,
            toolRequirements,
          }
          await this.dependencies.emit('AfterSearch', result)
          this.dependencies.journal.record({
            actor: 'system',
            action: 'search',
            outputSummary: `${result.hits.length} hits`,
            inputSummary: `${authorizedProcessed.query} [rg]`,
          })
          return result
        }
      } catch {
        // arch-guard:silent-catch-ok ripgrep 搜索失败时按设计回退到 adapter 搜索。
      }
    }

    const adapterSearch = await this.searchViaAdapters(authorizedProcessed, maxResults)
    backend = 'adapters'
    hits = adapterSearch.hits
    truncated = adapterSearch.truncated
    const scannedFiles = adapterSearch.scannedFiles

    const result: SearchResult = {
      query: authorizedProcessed.query,
      hits,
      truncated,
      backend,
      scannedFiles,
      toolRequirements,
    }
    await this.dependencies.emit('AfterSearch', result)
    this.dependencies.journal.record({
      actor: 'system',
      action: 'search',
      inputSummary: authorizedProcessed.query,
      outputSummary: `${result.hits.length} hits`,
    })
    return result
  }

  /** 快速后端只负责其可精确解释的文本；遗留编码在统一解码后交给同一搜索适配器。 */
  private async classifySearchFiles(input: SearchInput): Promise<Map<string, 'native' | 'decoded' | 'excluded'>> {
    const kinds = new Map<string, 'native' | 'decoded' | 'excluded'>()
    if (!this.dependencies.searchTextKind) return kinds
    for (const path of await this.searchFilePaths(input)) {
      const classified = await this.classifySearchFile(path)
      kinds.set(path, classified.kind)
      if (classified.error) this.dependencies.journal.record({ actor: 'system', action: 'search', path, outputSummary: '格式检测失败，已跳过不可读取文件。' })
    }
    return kinds
  }

  private async classifySearchFile(path: string): Promise<{ kind: 'native' | 'decoded' | 'excluded'; error?: unknown }> {
    try { return { kind: await this.dependencies.searchTextKind!(path) } }
    catch (error) { return { kind: 'excluded', error } }
  }

  private async searchFilePaths(processed: SearchInput): Promise<string[]> {
    const entries = await this.dependencies.store.listFiles({
      path: processed.root,
      include: processed.include,
      exclude: this.resolveSearchExcludeGlobs(processed),
      excludeGitignored: processed.excludeGitignored ?? this.defaultExcludeGitignoredForRoot(processed.root),
      recursive: true,
      // 搜索必须遍历完整候选集；公开 list 的展示页长不能静默裁掉旧编码文件。
      maxFiles: Number.MAX_SAFE_INTEGER,
      maxDepth: Number.MAX_SAFE_INTEGER,
    })
    return entries.filter((entry) => entry.type === 'file').map((entry) => entry.path)
  }

  /** 回退搜索：通过 adapter 扫描文件，每个文件限制命中数，再做全局合并。 */
  private async searchViaAdapters(
    processed: SearchInput,
    maxResults: number,
    selectedFiles?: string[],
  ): Promise<{ hits: SearchHit[]; scannedFiles: number; truncated: boolean }> {
    const files = selectedFiles ?? await this.searchFilePaths(processed)
    const perFileCap = Math.min(120, Math.max(maxResults * 2, 24))
    const hits: SearchHit[] = []
    let scannedFiles = 0
    let stoppedEarly = false

    for (const file of files) {
      scannedFiles++
      let snap: FileSnapshot
      try {
        snap = await this.dependencies.enrichSnapshot(
          await this.dependencies.store.snapshot(file, true),
        )
      } catch {
        // arch-guard:silent-catch-ok 搜索扫描按 best-effort 跳过不可读取文件。
        continue
      }
      if (snap.isBinary || snap.size > this.dependencies.policy.maxSearchFileSizeBytes) continue
      if (matchesAny(snap.path, this.dependencies.policy.readDeny)) continue

      const adapters = await this.dependencies.createAdapters(snap)
      for (const adapter of adapters) {
        if (!adapter.search) continue
        const adapterHits = await adapter.search({
          snapshot: snap,
          query: processed.query,
          regex: processed.regex,
          maxResults: perFileCap,
          caseSensitive: processed.caseSensitive,
        })
        for (const hit of adapterHits) {
          let snippet = hit.snippet
          if (snippet && this.dependencies.providers.secretRedaction) {
            snippet = (
              await this.dependencies.providers.secretRedaction.redact({
                path: hit.path,
                content: snippet,
                trust: { source: 'project', trust: 'untrusted' },
              })
            ).content
          }
          hits.push({
            ...hit,
            snippet,
            revision: snap.revision,
            trust: { source: 'project', trust: 'untrusted' },
          })
        }
      }
      // 命中已够：不再扫描剩余文件（这是 ripgrep 不可用时的回退路径，停止整树读取+脱敏，
      // 避免命中很早就满足却仍把整个工作区读一遍）。停止即视为可能截断。
      if (hits.length >= maxResults) {
        stoppedEarly = true
        break
      }
    }

    hits.sort((a, b) => b.score - a.score)
    const truncated = stoppedEarly || hits.length > maxResults
    return {
      hits: hits.slice(0, maxResults),
      scannedFiles,
      truncated,
    }
  }

  /** 收集指定文件中各适配器解析出的符号列表。 */
  public async listSymbols(pathInput: string): Promise<ProjectSymbol[]> {
    const snap = await this.dependencies.enrichSnapshot(
      await this.dependencies.store.snapshot(pathInput, true),
    )
    const codeIntel = this.dependencies.providers.codeIntelligence
    // 只有宿主显式启用代码智能时才使用远端/索引后端，否则回退本地 adapter。
    if (codeIntel?.isProjectEnabled(this.dependencies.root)) {
      try {
        const graphSymbols = await codeIntel.listSymbols({
          projectRoot: this.dependencies.root,
          path: snap.path,
        })
        const projectSymbols = graphSymbols.map((symbol) => ({
          name: symbol.name,
          kind: symbol.kind,
          line: symbol.line,
          column: symbol.column,
          endLine: symbol.endLine,
          endColumn: symbol.endColumn,
          exported: symbol.exported,
          nodeId: symbol.nodeId,
          signature: symbol.signature,
          adapterId: 'code-intelligence',
          path: snap.path,
          range: {
            startLine: symbol.line,
            startColumn: symbol.column,
            endLine: symbol.endLine,
            endColumn: symbol.endColumn,
          },
        }))
        if (!isEmpty(projectSymbols)) return uniqueSymbols(projectSymbols)
      } catch {
        // arch-guard:silent-catch-ok 代码智能不可用时回退本地 adapter 符号解析。
      }
    }
    const adapters = await this.dependencies.createAdapters(snap)
    const symbols: ProjectSymbol[] = []
    for (const adapter of adapters) {
      const parsed = await adapter.parse?.({ snapshot: snap })
      if (parsed?.symbols) {
        symbols.push(
          ...parsed.symbols.map((symbol) => ({
            ...symbol,
            adapterId: adapter.id,
            path: snap.path,
            line: symbol.range.startLine,
            column: symbol.range.startColumn,
            endLine: symbol.range.endLine,
            endColumn: symbol.range.endColumn,
          })),
        )
      }
    }
    return uniqueSymbols(symbols)
  }

  /** 把路径、符号或文本线索解析成可复用的目标引用。 */
  public async resolveTarget(input: ResolveTargetInput): Promise<ResolveTargetResult> {
    await this.dependencies.emit('BeforeResolve', input)
    const processed = await this.dependencies.transform('resolve.input', input)
    const access = await this.dependencies.store.authorize(processed.path, 'read', '读取')
    const authorizedInput = { ...processed, path: access.rel }
    await this.dependencies.decide('resolve', [access.rel], authorizedInput)
    const snap = await this.dependencies.enrichSnapshot(
      await this.dependencies.store.snapshot(authorizedInput.path, true, {
        skipFileFilter: true,
      }),
    )
    const codeIntel = this.dependencies.providers.codeIntelligence
    const symbolName = authorizedInput.target?.symbol?.name
    // 只有宿主显式启用代码智能时才查询定义，否则回退 adapter resolveTarget。
    if (codeIntel?.isProjectEnabled(this.dependencies.root) && symbolName) {
      try {
        const lineHint = authorizedInput.target?.lineHint
        const locations = await codeIntel.getDefinition({
          projectRoot: this.dependencies.root,
          path: snap.path,
          line: lineHint?.startLine ?? 1,
          column: 1,
          symbol: symbolName,
        })
        const match = locations[0]
        if (match) {
          const target: ResolvedTarget = {
            targetId: `code-intel:${match.nodeId ?? match.path}:${match.line}`,
            path: match.path,
            kind: 'symbol',
            symbol: {
              kind: authorizedInput.target?.symbol?.kind ?? 'symbol',
              name: symbolName,
              container: authorizedInput.target?.symbol?.container,
            },
            range: {
              startLine: match.line,
              startColumn: match.column,
              endLine: match.endLine,
              endColumn: match.endColumn,
            },
            anchors: {},
            confidence: 0.9,
            baseRevision: snap.revision,
            sha256: snap.sha256 ?? '',
            expectedMatches: authorizedInput.expectedMatches ?? 1,
            adapterId: 'code-intelligence',
          }
          this.targets.set(target.targetId, target)
          const resolved = { status: 'resolved' as const, target }
          await this.dependencies.emit('AfterResolve', resolved)
          return resolved
        }
      } catch {
        // arch-guard:silent-catch-ok 代码智能解析失败时回退 adapter resolveTarget。
      }
    }
    const adapters = await this.dependencies.createAdapters(snap)
    const ambiguous: ResolvedTarget[] = []
    for (const adapter of adapters) {
      if (!adapter.resolveTarget) continue
      const result = await adapter.resolveTarget({ ...authorizedInput, snapshot: snap })
      if (result.status === 'resolved') {
        this.targets.set(result.target.targetId, result.target)
        this.capInsertionOrderedMap(this.targets, MaxRetainedTargets)
        await this.dependencies.emit('AfterResolve', result)
        this.dependencies.journal.record({
          actor: 'system',
          action: 'resolve_target',
          path: result.target.path,
          targetId: result.target.targetId,
          outputSummary: `${result.target.kind}:${result.target.confidence}`,
        })
        return result
      }
      if (result.status === 'ambiguous') ambiguous.push(...result.candidates)
    }
    if (!isEmpty(ambiguous))
      return {
        status: 'ambiguous',
        candidates: ambiguous,
        reason: `找到 ${ambiguous.length} 个候选目标`,
      }
    return { status: 'not_found', reason: '没有 adapter 能解析该目标' }
  }

  /** 为一次任务创建带唯一 id 和时间戳的上下文。 */
  public createTaskContext(input: Omit<TaskContext, 'taskId' | 'createdAt'>): TaskContext {
    return { ...input, taskId: id('task'), createdAt: Date.now() }
  }

  /** 基于目标或路径范围构建可引用的证据包。 */
  public async buildEvidencePack(input: BuildEvidencePackInput): Promise<EvidencePack> {
    const evidenceId = id('evidence')
    const inputTargetId = input.target?.targetId
    const storedTarget = inputTargetId ? this.getTarget(inputTargetId) : undefined
    const targetPath = storedTarget?.path ?? input.target?.path
    const targetRange = resolveEvidenceTargetRange(storedTarget, input.target?.range)
    const targetBaseRevision = storedTarget?.baseRevision ?? input.target?.baseRevision
    const includeCurrentWindow = input.include?.currentWindow ?? Boolean(targetPath && targetRange)
    let freshContext: EvidencePack['freshContext']

    if (includeCurrentWindow && targetPath && targetRange) {
      // Evidence 只截取目标附近的新鲜窗口，不把整文件塞进上下文。
      const before = Math.max(0, input.include?.windowLinesBefore ?? 5)
      const after = Math.max(0, input.include?.windowLinesAfter ?? 5)
      const contextStart = Math.max(1, targetRange.startLine - before)
      const contextEnd = Math.max(contextStart, targetRange.endLine + after)
      const read = await this.read({
        path: targetPath,
        baseRevision: targetBaseRevision,
        range: { startLine: contextStart, endLine: contextEnd },
        maxBytes: 80_000,
      })
      const revision = read.snapshot.revision ?? targetBaseRevision
      const contextRange = read.range ?? { startLine: contextStart, endLine: contextEnd }
      let currentWindow = read.content
      if (currentWindow && this.dependencies.providers.secretRedaction) {
        currentWindow = (
          await this.dependencies.providers.secretRedaction.redact({
            path: read.snapshot.path,
            content: currentWindow,
            trust: { source: 'project', trust: 'untrusted' },
          })
        ).content
      }

      const suggestedReads: NonNullable<EvidencePack['freshContext']>['suggestedReads'] = []
      if (contextRange.startLine > 1) {
        suggestedReads.push({
          path: read.snapshot.path,
          range: {
            startLine: Math.max(1, contextRange.startLine - Math.max(before, 20)),
            endLine: contextRange.startLine - 1,
          },
          reason: 'before-context',
        })
      }
      if (read.hasMore) {
        suggestedReads.push({
          path: read.snapshot.path,
          range: {
            startLine: contextRange.endLine + 1,
            endLine: contextRange.endLine + Math.max(after, 20),
          },
          reason: 'after-context',
        })
      }

      freshContext = {
        currentWindow,
        path: read.snapshot.path,
        revision,
        targetRange,
        contextRange,
        citation: {
          path: read.snapshot.path,
          revision,
          range: targetRange,
        },
        hasMoreBefore: contextRange.startLine > 1,
        hasMoreAfter: !!read.hasMore,
        suggestedReads,
        metadata: input.metadata,
      }
    }
    const task = input.task
      ? {
          description: input.task.description,
          goal: input.task.goal,
          userConstraints: input.task.userConstraints,
          successCriteria: input.task.successCriteria,
          riskLevel: input.task.riskLevel,
        }
      : undefined
    let pack: EvidencePack = {
      evidenceId,
      task,
      target: storedTarget,
      editScope: input.editScope ?? {},
      freshContext,
      trust: {
        projectContentIsUntrusted: true,
        redactedSecrets: !!this.dependencies.providers.secretRedaction,
      },
      metadata: input.metadata,
    }
    const builtByContextProvider = await this.dependencies.providers.context?.buildEvidence?.(pack)
    if (builtByContextProvider && isObject(builtByContextProvider)) {
      pack = {
        ...pack,
        metadata: { ...(pack.metadata ?? {}), contextProvider: builtByContextProvider },
      }
    }
    const sanitizedByContextProvider = await this.dependencies.providers.context?.sanitize?.(pack)
    if (sanitizedByContextProvider && isObject(sanitizedByContextProvider)) {
      pack = {
        ...(sanitizedByContextProvider as EvidencePack),
        evidenceId: (sanitizedByContextProvider as EvidencePack).evidenceId ?? evidenceId,
      }
    }
    this.evidence.set(evidenceId, pack)
    this.capInsertionOrderedMap(this.evidence, MaxRetainedEvidence)
    this.dependencies.journal.record({
      actor: 'system',
      action: 'build_evidence',
      targetId: input.target?.targetId,
      outputSummary: evidenceId,
    })
    return pack
  }

  public get targetCount(): number {
    return this.targets.size
  }

  public getTarget(targetId?: string): ResolvedTarget | undefined {
    return targetId ? this.targets.get(targetId) : undefined
  }

  /** 按插入顺序淘汰最旧的条目，把 Map 体积约束在上限内（Map 保留插入顺序）。 */
  private capInsertionOrderedMap(map: Map<string, unknown>, maxSize: number): void {
    while (map.size > maxSize) {
      const oldest = map.keys().next().value
      if (isUndefined(oldest)) break
      map.delete(oldest)
    }
  }
}
