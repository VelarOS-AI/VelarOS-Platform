import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, join, relative, resolve } from 'node:path'

import { clamp, compact, first, isBlank, isEmpty, isFalse, last, toNullable, truncate, unique } from '@velaros-ai/core'

import type {
  KnowledgeCodeIntelligenceApi,
  KnowledgeCodeSymbol,
  KnowledgeIndexingPolicy,
} from '../../Types'
import {
  createImportTargetCandidates,
  extractImports,
  extractSymbols,
  getCodeExtensions,
  isLikelyTextFile,
  scorePathMatch,
} from '../domain/CodeHelper'
import type {
  KnowledgeSourceKind,
  KnowledgeUpsertInput,
} from '../domain/Types'

import {
  getRelativePathInsideRoot,
  toPortablePathText,
  toPortableRelativePath,
} from './PathPolicy'

/** 普通文档最大读取字节数，避免把大文件塞进知识索引。 */
const MAX_DOCUMENT_BYTES = 256 * 1024
/** 代码候选最大读取字节数，代码搜索走轻量候选策略。 */
const MAX_CODE_FILE_BYTES = 96 * 1024
/** 工作区扫描深度上限，防止递归遍历过深目录。 */
const MAX_SCAN_DEPTH = 6
/** 单次代码候选扫描最多检查的代码文件数。 */
const MAX_CODE_SCAN_FILES = 800
/** 默认返回的代码候选数量。 */
const DEFAULT_CODE_CANDIDATE_LIMIT = 12
/** 普通文本知识允许的扩展名。 */
const TEXT_EXTENSIONS = new Set(['.md', '.mdx', '.txt'])
/** 允许作为配置知识入库的文件名。 */
const ALLOWED_CONFIG_NAMES = [
  /^package\.json$/i,
  /^tsconfig(?:\.[^.]+)?\.json$/i,
  /^bunfig\.toml$/i,
  /^vite\.config\.(?:[cm]?[jt]s)$/i,
  /^electron\.vite\.config\.(?:[cm]?[jt]s)$/i,
  /^tailwind\.config\.(?:[cm]?[jt]s)$/i,
  /^eslint\.config\.(?:[cm]?[jt]s)$/i,
  /^docker-compose(?:\.[^.]+)?\.ya?ml$/i,
  /^\.env\.example$/i,
] as const
const DEFAULT_HIDDEN_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.cache',
  '.turbo',
  '.next',
  '.vite',
  '.idea',
  '.vscode',
  'node_modules',
  'dist',
  'build',
  'coverage',
])

/** 代码候选选择输入。 */
interface CodeCandidateInput {
  workspaceRoot: string
  pathHints: string[]
  symbolHints: string[]
  limit?: number
}

/** 带排序分数的代码候选。 */
interface PathSearchCandidate {
  candidate: KnowledgeWorkspaceCodeCandidate
  score: number
}

/** 从 path hint 推导出的代码关系信号。 */
interface CodeSignalContext {
  directHintPaths: Set<string>
  importedTargetPaths: Set<string>
}

/** 工作区中可索引文件的文件系统快照。 */
interface KnowledgeWorkspaceFileEntry {
  workspaceRoot: string
  absolutePath: string
  path: string
  sourceKind: KnowledgeSourceKind
  fileSize: number
  modifiedAt: number
}

/** 已读取并转换为 KnowledgeUpsertInput 的文档。 */
interface KnowledgeWorkspacePreparedDocument {
  file: KnowledgeWorkspaceFileEntry
  document: KnowledgeUpsertInput
  contentHash: string
}

/** 代码候选和普通 prepared document 结构一致，只是来源和选择策略不同。 */
interface KnowledgeWorkspaceCodeCandidate extends KnowledgeWorkspacePreparedDocument {}

/** 判断已索引文件是否仍存在且可索引的结果。 */
interface KnowledgeIndexedFileInspection {
  exists: boolean
  indexable: boolean
}

/**
 * 知识工作区存储。
 *
 * 负责扫描工作区文件、读取文本内容、构造文档摘要/标签，
 * 以及根据 path/symbol/import 信号选择少量代码文件作为搜索候选。
 */
class KnowledgeWorkspace {
  constructor(
    private readonly codeIntelligence?: KnowledgeCodeIntelligenceApi,
    private readonly indexingPolicy?: KnowledgeIndexingPolicy
  ) {}

  /** 扫描普通文档文件。 */
  public async listDocumentFiles(workspaceRoot: string): Promise<KnowledgeWorkspaceFileEntry[]> {
    const resolvedRoot = resolve(workspaceRoot)
    const files: KnowledgeWorkspaceFileEntry[] = []

    await this.collectDocumentFiles(resolvedRoot, resolvedRoot, 0, files)
    return files
  }

  /** 读取普通文档并转换成知识写入结构。 */
  public async prepareDocument(
    file: KnowledgeWorkspaceFileEntry
  ): Promise<Nullable<KnowledgeWorkspacePreparedDocument>> {
    const contentBuffer = await readFile(file.absolutePath).catch(() => null)
    if (!contentBuffer || !isLikelyTextFile(contentBuffer)) {
      // 二进制或读取失败文件跳过，避免乱码进入索引。
      return null
    }

    const content = contentBuffer.toString('utf-8').trim()
    if (isBlank(content)) return null

    return {
      file,
      document: {
        workspaceRoot: file.workspaceRoot,
        path: file.path,
        title: this.buildDocumentTitle(file.path, content),
        summary: this.buildDocumentSummary(content, file.path),
        content,
        sourceKind: file.sourceKind,
        tags: this.buildDocumentTags(file.path, file.sourceKind),
      },
      contentHash: this.buildContentHash(content),
    }
  }

  /** 根据路径/符号提示选择代码候选并读取成知识文档。 */
  public async listCodeCandidates(input: CodeCandidateInput): Promise<KnowledgeWorkspaceCodeCandidate[]> {
    const workspaceRoot = resolve(input.workspaceRoot)
    const providerCandidates = await this.listCodeCandidatesViaProvider(workspaceRoot, input)
    if (providerCandidates.length > 0) return providerCandidates
    // 用户传入的路径提示统一转成工作区内 portable 相对路径。
    const pathHints = unique(input.pathHints
      .map((hint) => toPortablePathText(hint.trim()).replace(/^\.?\//, ''))
      .filter((hint) => !isBlank(hint)))
    const symbolHints = unique(input.symbolHints
      .map((hint) => hint.trim())
      .filter((hint) => !isBlank(hint)))
    const signalContext = await this.buildCodeSignalContext(workspaceRoot, pathHints)
    const candidates: PathSearchCandidate[] = []
    const limit = input.limit ?? DEFAULT_CODE_CANDIDATE_LIMIT
    const scanState = { scannedFiles: 0 }

    await this.collectCodeCandidates({
      workspaceRoot,
      currentPath: workspaceRoot,
      depth: 0,
      pathHints,
      symbolHints,
      signalContext,
      limit,
      candidates,
      scanState,
    })

    return candidates
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.candidate.document.path.length - right.candidate.document.path.length ||
          left.candidate.document.path.localeCompare(right.candidate.document.path, 'en')
      )
      .slice(0, limit)
      .map((candidate) => candidate.candidate)
  }

  private async listCodeCandidatesViaProvider(
    workspaceRoot: string,
    input: CodeCandidateInput
  ): Promise<KnowledgeWorkspaceCodeCandidate[]> {
    const api = this.codeIntelligence
    if (!api?.isProjectEnabled(workspaceRoot)) return []

    const limit = input.limit ?? DEFAULT_CODE_CANDIDATE_LIMIT
    const pathHints = input.pathHints
      .map((hint) => toPortablePathText(hint.trim()).replace(/^\.?\//, ''))
      .filter((hint) => !isBlank(hint))
    const symbolHints = input.symbolHints
      .map((hint) => hint.trim())
      .filter((hint) => !isBlank(hint))

    const nodeIds = new Set<string>()
    const nodes: Array<{
      id: string
      filePath: string
      name: string
      kind: string
      range: { startLine: number; endLine: number }
    }> = []

    const symbolHitGroups = await Promise.all(
      symbolHints.slice(0, 8).map((hint) =>
        api.searchNodes({ projectRoot: workspaceRoot, query: hint, limit: 8 })
      )
    )
    for (const hits of symbolHitGroups) {
      for (const hit of hits) {
        if (!nodeIds.has(hit.node.id)) {
          nodeIds.add(hit.node.id)
          nodes.push(hit.node)
        }
      }
    }

    if (isEmpty(symbolHints) && !isEmpty(pathHints)) {
      const subgraph = await api.findRelevantContext({
        projectRoot: workspaceRoot,
        query: pathHints.join(' '),
        maxNodes: limit,
      })
      for (const node of subgraph.nodes) {
        if (!nodeIds.has(node.id)) {
          nodeIds.add(node.id)
          nodes.push(node)
        }
      }
    }

    const fileNodeGroups = await Promise.all(
      pathHints.slice(0, 6).map((pathHint) =>
        api.getNodesInFile({ projectRoot: workspaceRoot, path: pathHint })
      )
    )
    for (const fileNodes of fileNodeGroups) {
      for (const node of fileNodes) {
        if (!nodeIds.has(node.id)) {
          nodeIds.add(node.id)
          nodes.push(node)
        }
      }
    }

    const candidates = await Promise.all(nodes.slice(0, limit).map(async (node) => {
      const code = await api.getCodeForNode({
        projectRoot: workspaceRoot,
        nodeId: node.id,
      })
      const content =
        code ??
        (await readFile(resolve(workspaceRoot, node.filePath), 'utf-8').catch(() => ''))
      if (isBlank(content)) return null
      const absolutePath = resolve(workspaceRoot, node.filePath)
      const fileStats = await stat(absolutePath).catch(() => null)
      return {
        file: {
          workspaceRoot,
          absolutePath,
          path: node.filePath,
          sourceKind: 'code',
          fileSize: fileStats?.size ?? content.length,
          modifiedAt: fileStats?.mtimeMs ?? Date.now(),
        },
        document: {
          workspaceRoot,
          path: node.filePath,
          title: `${node.name} (${node.kind})`,
          summary: `${node.kind} ${node.name} in ${node.filePath}`,
          content,
          sourceKind: 'code',
          tags: [
            'code',
            `symbol:${node.name}`,
            `codegraph-node:${node.id}`,
            `lines:${node.range.startLine}-${node.range.endLine}`,
          ],
        },
        contentHash: this.buildContentHash(content),
      } satisfies KnowledgeWorkspaceCodeCandidate
    }))

    return compact(candidates)
  }

  /** 检查数据库里记录的文件是否仍存在且可索引。 */
  public async inspectIndexedFile(
    workspaceRoot: string,
    relativePath: string,
    sourceKind: KnowledgeSourceKind
  ): Promise<KnowledgeIndexedFileInspection> {
    const normalizedPath = toPortablePathText(relativePath)
      .replace(/^\.?\//, '')
    if (isBlank(normalizedPath) || !this.isWorkspacePathVisible(normalizedPath)) return {
        exists: false,
        indexable: false,
      }

    const absolutePath = resolve(workspaceRoot, normalizedPath)
    const normalizedResolvedPath = this.toRelativeWorkspacePath(workspaceRoot, absolutePath)
    if (!normalizedResolvedPath || normalizedResolvedPath !== normalizedPath) {
      // 防止相对路径逃出 workspaceRoot。
      return {
        exists: false,
        indexable: false,
      }
    }

    const fileStats = await stat(absolutePath).catch(() => null)
    if (!fileStats?.isFile()) return {
        exists: false,
        indexable: false,
      }

    const fileName = basename(normalizedPath)
    // code 和 document 使用不同的纳入规则。
    const indexable =
      sourceKind === 'code'
        ? this.shouldIncludeCodeFile(fileName)
        : this.shouldIncludeDocumentFile(fileName)

    return {
      exists: true,
      indexable,
    }
  }

  /** 递归收集普通文档文件。 */
  private async collectDocumentFiles(
    workspaceRoot: string,
    currentPath: string,
    depth: number,
    files: KnowledgeWorkspaceFileEntry[]
  ): Promise<void> {
    if (depth > MAX_SCAN_DEPTH) return

    const entries = await readdir(currentPath, { withFileTypes: true }).catch(() => null)
    if (!entries) return

    const sortedEntries = [...entries].sort((left, right) =>
      left.name.localeCompare(right.name, 'en')
    )
    for (const entry of sortedEntries) {
      const entryPath = join(currentPath, entry.name)
      if (!this.shouldIncludeEntry(workspaceRoot, entryPath, entry.name, entry.isDirectory())) {
        // 跳过 node_modules、.git、隐藏缓存等系统目录/文件。
        continue
      }
      if (entry.isSymbolicLink()) {
        // 不跟随符号链接，避免循环或越界扫描。
        continue
      }

      if (entry.isDirectory()) {
        await this.collectDocumentFiles(workspaceRoot, entryPath, depth + 1, files)
        continue
      }

      if (!entry.isFile() || !this.shouldIncludeDocumentFile(entry.name)) {
        continue
      }

      const fileStats = await stat(entryPath).catch(() => null)
      if (!fileStats?.isFile() || fileStats.size <= 0 || fileStats.size > MAX_DOCUMENT_BYTES) {
        // 空文件和过大文件都不入库。
        continue
      }

      files.push({
        workspaceRoot,
        absolutePath: entryPath,
        path: toPortablePathText(relative(workspaceRoot, entryPath)),
        sourceKind: this.resolveSourceKind(entryPath),
        fileSize: fileStats.size,
        modifiedAt: Math.trunc(fileStats.mtimeMs),
      })
    }
  }

  /** 递归扫描代码文件并插入候选池。 */
  private async collectCodeCandidates(args: {
    workspaceRoot: string
    currentPath: string
    depth: number
    pathHints: string[]
    symbolHints: string[]
    signalContext: CodeSignalContext
    limit: number
    candidates: PathSearchCandidate[]
    scanState: { scannedFiles: number }
  }): Promise<void> {
    if (args.depth > MAX_SCAN_DEPTH || args.scanState.scannedFiles >= MAX_CODE_SCAN_FILES) return

    const entries = await readdir(args.currentPath, { withFileTypes: true }).catch(() => null)
    if (!entries) return

    const sortedEntries = [...entries].sort((left, right) =>
      left.name.localeCompare(right.name, 'en')
    )
    for (const entry of sortedEntries) {
      if (args.scanState.scannedFiles >= MAX_CODE_SCAN_FILES) return
      const entryPath = join(args.currentPath, entry.name)
      if (!this.shouldIncludeEntry(args.workspaceRoot, entryPath, entry.name, entry.isDirectory())) {
        continue
      }
      if (entry.isSymbolicLink()) {
        continue
      }

      if (entry.isDirectory()) {
        await this.collectCodeCandidates({
          ...args,
          currentPath: entryPath,
          depth: args.depth + 1,
        })
        continue
      }

      if (!entry.isFile() || !this.shouldIncludeCodeFile(entry.name)) {
        continue
      }

      args.scanState.scannedFiles += 1
      const candidate = await this.readCodeCandidate(
        args.workspaceRoot,
        entryPath,
        args.pathHints,
        args.symbolHints,
        args.signalContext
      )
      if (!candidate) {
        continue
      }

      // 候选池只保留排名靠前的一小批，控制后续 embedding/索引成本。
      this.insertCandidate(args.candidates, candidate, args.limit)
    }
  }

  /** 判断普通文档文件是否允许进入知识库。 */
  private shouldIncludeDocumentFile(name: string): boolean {
    const extension = extname(name).toLowerCase()
    if (TEXT_EXTENSIONS.has(extension)) return true

    return ALLOWED_CONFIG_NAMES.some((pattern) => pattern.test(name))
  }

  /** 判断代码文件是否允许作为候选。 */
  private shouldIncludeCodeFile(name: string): boolean {
    const extension = extname(name).replace(/^\./, '').toLowerCase()
    if (!getCodeExtensions().includes(extension)) return false

    // 声明文件和压缩产物通常信息密度低或体积异常，默认排除。
    return !name.endsWith('.d.ts') && !name.endsWith('.min.js')
  }

  /** 读取并评分单个代码候选。 */
  private async readCodeCandidate(
    workspaceRoot: string,
    absolutePath: string,
    pathHints: string[],
    symbolHints: string[],
    signalContext: CodeSignalContext
  ): Promise<Nullable<PathSearchCandidate>> {
    const fileStats = await stat(absolutePath).catch(() => null)
    if (!fileStats?.isFile() || fileStats.size <= 0 || fileStats.size > MAX_CODE_FILE_BYTES) return null

    const relativePath = relative(workspaceRoot, absolutePath).replaceAll('\\', '/')
    const pathScore = this.scorePathHints(relativePath, absolutePath, pathHints)
    const relationScore = this.scoreRelationHints(relativePath, signalContext)
    const needsSymbolInspection = !isEmpty(symbolHints) || pathScore > 0 || relationScore > 0
    if (!needsSymbolInspection) {
      // 和本次搜索线索完全无关的代码文件不读内容，减少 I/O。
      return null
    }

    const contentBuffer = await readFile(absolutePath).catch(() => null)
    if (!contentBuffer || !isLikelyTextFile(contentBuffer)) return null

    const content = contentBuffer.toString('utf-8').trim()
    if (isBlank(content)) return null

    const symbols = extractSymbols(relativePath, content)
    const symbolScore = this.scoreSymbolHints(content, symbols, symbolHints)
    const importScore = this.scoreImportRelation(
      absolutePath,
      content,
      workspaceRoot,
      signalContext
    )
    if (pathScore <= 0 && symbolScore <= 0 && relationScore <= 0 && importScore <= 0) {
      // 读取后仍没有任何相关信号，就不作为候选。
      return null
    }

    return {
      candidate: {
        file: {
          workspaceRoot,
          absolutePath,
          path: relativePath,
          sourceKind: 'code',
          fileSize: fileStats.size,
          modifiedAt: Math.trunc(fileStats.mtimeMs),
        },
        document: {
          workspaceRoot,
          path: relativePath,
          title: basename(relativePath),
          summary: this.buildCodeSummary(relativePath, symbols, content),
          content,
          sourceKind: 'code',
          tags: this.buildCodeTags(relativePath, symbols),
        },
        contentHash: this.buildContentHash(content),
      },
      score: pathScore + relationScore + importScore + symbolScore,
    }
  }

  /** 根据路径提示提取直接路径和相邻 import 目标，给代码候选选择提供关系信号。 */
  private async buildCodeSignalContext(
    workspaceRoot: string,
    pathHints: string[]
  ): Promise<CodeSignalContext> {
    const directHintPaths = new Set<string>()
    const importedTargetPaths = new Set<string>()

    for (const pathHint of pathHints.slice(0, 10)) {
      const absoluteHintPath = this.resolveHintPath(workspaceRoot, pathHint)
      if (!absoluteHintPath) {
        continue
      }

      const relativeHintPath = this.toRelativeWorkspacePath(workspaceRoot, absoluteHintPath)
      if (!relativeHintPath) {
        continue
      }
      directHintPaths.add(relativeHintPath)

      if (!this.shouldIncludeCodeFile(basename(relativeHintPath))) {
        // 非代码 hint 只作为直接路径信号，不继续解析 imports。
        continue
      }

      const fileStats = await stat(absoluteHintPath).catch(() => null)
      if (!fileStats?.isFile() || fileStats.size <= 0 || fileStats.size > MAX_CODE_FILE_BYTES) {
        continue
      }

      const contentBuffer = await readFile(absoluteHintPath).catch(() => null)
      if (!contentBuffer || !isLikelyTextFile(contentBuffer)) {
        continue
      }

      const content = contentBuffer.toString('utf-8').trim()
      if (isBlank(content)) {
        continue
      }

      for (const importRecord of extractImports(
        absoluteHintPath,
        content
      )) {
        if (!importRecord.isRelative) {
          continue
        }

        // 相对 import 的目标文件往往和 hint 文件强相关，也加入候选信号。
        for (const candidatePath of createImportTargetCandidates(
          importRecord.specifier,
          absoluteHintPath,
          workspaceRoot
        )) {
          const relativeCandidatePath = this.toRelativeWorkspacePath(workspaceRoot, candidatePath)
          if (relativeCandidatePath) {
            importedTargetPaths.add(relativeCandidatePath)
          }
        }
      }
    }

    return {
      directHintPaths,
      importedTargetPaths,
    }
  }

  /** 根据扩展名解析知识来源类型。 */
  private resolveSourceKind(path: string): KnowledgeSourceKind {
    const extension = extname(path).toLowerCase()
    if (extension === '.json') return 'json'
    if (TEXT_EXTENSIONS.has(extension)) return extension === '.md' || extension === '.mdx' ? 'markdown' : 'text'
    return 'config'
  }

  /** 优先使用 markdown 一级标题作为文档标题，否则使用文件名。 */
  private buildDocumentTitle(path: string, content: string): string {
    const heading = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /^#{1,6}\s+\S+/.test(line))

    if (heading) return truncate(heading
        .replace(/^#{1,6}\s+/, '')
        .trim(), 120)

    return truncate(basename(path), 120)
  }

  /** 从正文中取第一段有信息量的文本作为摘要。 */
  private buildDocumentSummary(content: string, path: string): string {
    const lines = content
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => !isBlank(line))
      .filter((line) => !/^#{1,6}\s+/.test(line))
      .filter((line) => !/^```/.test(line))

    const summary = lines.find((line) => line.length >= 24) ?? first(lines) ?? path

    return truncate(summary, 220)
  }

  /** 根据路径和来源类型生成文档标签。 */
  private buildDocumentTags(path: string, sourceKind: KnowledgeSourceKind): string[] {
    const segments = path.split('/').filter(Boolean)
    const filename = last(segments) ?? path
    const extension = extname(filename).replace(/^\./, '').toLowerCase()

    return unique(compact([
      'workspace-knowledge',
      sourceKind,
      extension || null,
      (toNullable(first(segments))),
      filename.replace(extname(filename), '').toLowerCase(),
    ]))
  }

  /** 根据导出符号或首个有效代码行生成代码摘要。 */
  private buildCodeSummary(
    relativePath: string,
    symbols: KnowledgeCodeSymbol[],
    content: string
  ): string {
    const exportedSymbols = symbols.filter((symbol) => symbol.exported)
    // 导出符号通常更能代表模块能力，优先展示。
    const preferredSymbols = (!isEmpty(exportedSymbols) ? exportedSymbols : symbols)
      .slice(0, 6)
      .map((symbol) => `${symbol.name}:${symbol.kind}`)

    if (!isEmpty(preferredSymbols)) return truncate(`代码符号：${preferredSymbols.join(', ')}`, 220)

    const firstMeaningfulLine = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => !isBlank(line) && !line.startsWith('//'))

    return truncate((firstMeaningfulLine ?? relativePath), 220)
  }

  /** 生成代码标签，包含路径信息和符号信息。 */
  private buildCodeTags(relativePath: string, symbols: KnowledgeCodeSymbol[]): string[] {
    const segments = relativePath.split('/').filter(Boolean)
    const filename = last(segments) ?? relativePath
    const extension = extname(filename).replace(/^\./, '').toLowerCase()
    const symbolTags = symbols
      .slice(0, 12)
      // 同一个符号同时保存裸名、kind:name 和 export:name，方便不同 hint 方式命中。
      .flatMap((symbol) => [
        symbol.name,
        `${symbol.kind}:${symbol.name}`,
        symbol.exported ? `export:${symbol.name}` : null,
      ])

    return unique(compact([
      'workspace-knowledge',
      'code',
      extension || null,
      (toNullable(first(segments))),
      filename.replace(extname(filename), '').toLowerCase(),
      ...symbolTags,
    ]))
  }

  /** 根据路径 hint 对代码文件评分。 */
  private scorePathHints(relativePath: string, absolutePath: string, pathHints: string[]): number {
    if (isEmpty(pathHints)) return 0

    let bestScore = 0
    for (const hint of pathHints) {
      const normalizedHint = toPortablePathText(hint.trim())
        .replace(/^\.?\//, '')
      if (relativePath === normalizedHint) {
        // 精确路径匹配直接给满分。
        bestScore = Math.max(bestScore, 1)
        continue
      }

      const score = scorePathMatch(relativePath, [hint])
      if (score > 0) {
        bestScore = Math.max(bestScore, Math.min(score / 10, 1))
      }
    }

    return clamp(bestScore, 0, 1)
  }

  /** 根据直接路径和 import 关系信号评分。 */
  private scoreRelationHints(relativePath: string, signalContext: CodeSignalContext): number {
    let score = 0
    if (signalContext.directHintPaths.has(relativePath)) {
      score += 0.3
    }
    if (signalContext.importedTargetPaths.has(relativePath)) {
      score += 0.22
    }
    return clamp(score, 0, 0.6)
  }

  /** 根据符号 hint 对代码内容评分。 */
  private scoreSymbolHints(
    content: string,
    symbols: KnowledgeCodeSymbol[],
    symbolHints: string[]
  ): number {
    if (isEmpty(symbolHints)) return 0

    const normalizedContent = content.toLowerCase()
    let score = 0
    for (const hint of symbolHints) {
      const normalizedHint = hint.trim().toLowerCase()
      if (isBlank(normalizedHint)) {
        continue
      }

      if (symbols.some((symbol) => symbol.name.toLowerCase() === normalizedHint)) {
        // 符号精确命中最强。
        score += 0.38
        continue
      }
      if (symbols.some((symbol) => symbol.name.toLowerCase().includes(normalizedHint))) {
        score += 0.2
        continue
      }
      if (normalizedContent.includes(normalizedHint)) {
        // 文本包含作为兜底弱信号。
        score += 0.12
      }
    }

    return clamp(score, 0, 0.9)
  }

  /** 如果当前文件 import 了 path hint 文件，也视为相关代码。 */
  private scoreImportRelation(
    absolutePath: string,
    content: string,
    workspaceRoot: string,
    signalContext: CodeSignalContext
  ): number {
    let score = 0
    for (const importRecord of extractImports(absolutePath, content)) {
      if (!importRecord.isRelative) {
        continue
      }

      for (const candidatePath of createImportTargetCandidates(
        importRecord.specifier,
        absolutePath,
        workspaceRoot
      )) {
        const relativeCandidatePath = this.toRelativeWorkspacePath(workspaceRoot, candidatePath)
        if (relativeCandidatePath && signalContext.directHintPaths.has(relativeCandidatePath)) {
          score += 0.18
          break
        }
      }
    }

    return clamp(score, 0, 0.45)
  }

  /** 插入候选池并按分数裁剪。 */
  private insertCandidate(
    candidates: PathSearchCandidate[],
    candidate: PathSearchCandidate,
    limit: number
  ): void {
    const existingIndex = candidates.findIndex(
      (entry) => entry.candidate.document.path === candidate.candidate.document.path
    )
    if (existingIndex >= 0) {
      if (candidates[existingIndex].score >= candidate.score) {
        // 已有同路径且分数更高的候选，保留旧候选。
        return
      }
      candidates.splice(existingIndex, 1)
    }

    candidates.push(candidate)
    candidates.sort((left, right) => right.score - left.score)
    if (candidates.length > limit * 2) {
      // 保留 limit 的两倍作为缓冲，最终排序后再截断。
      candidates.length = limit * 2
    }
  }

  /** 把 path hint 解析为工作区内绝对路径。 */
  private resolveHintPath(workspaceRoot: string, pathHint: string): Nullable<string> {
    const normalizedHint = toPortablePathText(pathHint.trim())
    if (isBlank(normalizedHint)) return null

    const absolutePath = resolve(workspaceRoot, normalizedHint)
    const relativePath = this.toRelativeWorkspacePath(workspaceRoot, absolutePath)
    return relativePath ? absolutePath : null
  }

  /** 将绝对路径安全转换为工作区内 portable 相对路径。 */
  private toRelativeWorkspacePath(workspaceRoot: string, absolutePath: string): Nullable<string> {
    const relativePath = getRelativePathInsideRoot(workspaceRoot, absolutePath)
    if (!relativePath || relativePath === '.') return null
    return toPortableRelativePath(relativePath)
  }

  /** 判断相对路径每一级是否都属于可见工作区内容。 */
  private isWorkspacePathVisible(relativePath: string): boolean {
    const segments = relativePath.split('/').filter(Boolean)
    if (isEmpty(segments)) return false

    return segments.every((segment, index) =>
      this.shouldIncludeEntry(
        '',
        segments.slice(0, index + 1).join('/'),
        segment,
        index < segments.length - 1
      )
    )
  }

  private shouldIncludeEntry(
    workspaceRoot: string,
    absolutePath: string,
    name: string,
    isDirectory: boolean
  ): boolean {
    const relativePath = workspaceRoot
      ? toPortablePathText(relative(workspaceRoot, absolutePath))
      : toPortablePathText(absolutePath)
    const hostDecision = this.indexingPolicy?.shouldIncludeEntry?.({
      name,
      isDirectory,
      relativePath,
    })
    if (isFalse(hostDecision)) return false

    if (isDirectory && (name.startsWith('.') || DEFAULT_HIDDEN_DIRECTORIES.has(name))) return false
    return name !== '.DS_Store' && !name.endsWith('.map')
  }

  /** 内容 hash 使用 trim 后文本，减少纯空白变化触发重建。 */
  private buildContentHash(content: string): string {
    return createHash('sha1').update(content.trim()).digest('hex')
  }
}

export type {
  KnowledgeIndexedFileInspection,
  KnowledgeWorkspaceCodeCandidate,
  KnowledgeWorkspaceFileEntry,
  KnowledgeWorkspacePreparedDocument,
}

export { KnowledgeWorkspace, KnowledgeWorkspace as KnowledgeWorkspaceStore }
