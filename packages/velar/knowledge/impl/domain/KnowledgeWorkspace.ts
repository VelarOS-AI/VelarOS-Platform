import { readFile, stat } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'

import { compact, isBlank, isEmpty, isFalse } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type {
  KnowledgeCodeIntelligenceApi,
  KnowledgeIndexingPolicy,
} from '../../contract/requires.js'
import type {
  KnowledgeCodeCandidateInput,
  KnowledgeCodeScanState,
  KnowledgeCodeSignalContext,
  KnowledgeDocumentFileSystem,
  KnowledgeIndexedFileInspection,
  KnowledgePathSearchCandidate,
  KnowledgeWorkspaceCodeCandidate,
  KnowledgeWorkspaceFileEntry,
  KnowledgeWorkspacePreparedDocument,
} from '../../types/ingestion.js'
import type { KnowledgeSourceKind } from '../../types/knowledge.js'
import { isLikelyTextFile } from '../../utils/code.js'
import { buildNormalizedContentHash } from '../../utils/indexing.js'
import { toPortablePathText } from '../../utils/paths.js'
import { KnowledgeTuning } from '../../utils/tuning.js'
import {
  buildCodeSignalContext,
  buildDocumentSummary,
  buildDocumentTags,
  buildDocumentTitle,
  createNodeDocumentFileSystem,
  insertCandidate,
  isDefaultIncludedEntry,
  isWorkspacePathVisible,
  readCodeCandidate,
  resolveSourceKind,
  shouldIncludeCodeFile,
  shouldIncludeDocumentFile,
  toRelativeWorkspacePath,
} from '../../utils/workspace.js'

/**
 * 知识工作区扫描器：列可索引文件、读文本正文、拼标题摘要标签，
 * 再按路径、符号与 import 信号挑出少量代码文件作为检索候选。
 *
 * 它只碰工作区根里面的东西：列文件只列根内的，根外的路径提示一律丢掉。
 * 实例由知识库运行时持有。
 */
export interface KnowledgeWorkspaceApi {
  /** 扫描工作区里可以入库的普通文档文件。 */
  listDocumentFiles(workspaceRoot: string): Promise<KnowledgeWorkspaceFileEntry[]>
  /** 读一份普通文档并转换成知识写入结构；二进制或空文件返回 null。 */
  prepareDocument(
    file: KnowledgeWorkspaceFileEntry
  ): Promise<Nullable<KnowledgeWorkspacePreparedDocument>>
  /** 按路径与符号提示挑出代码候选并读成知识文档。 */
  listCodeCandidates(
    input: KnowledgeCodeCandidateInput
  ): Promise<KnowledgeWorkspaceCodeCandidate[]>
  /** 检查数据库里记着的文件是不是还在、还能不能索引。 */
  inspectIndexedFile(
    workspaceRoot: string,
    relativePath: string,
    sourceKind: KnowledgeSourceKind
  ): Promise<KnowledgeIndexedFileInspection>
}

/** 见 {@link KnowledgeWorkspaceApi}。 */
export class KnowledgeWorkspace implements KnowledgeWorkspaceApi {
  constructor(
    private readonly codeIntelligence?: KnowledgeCodeIntelligenceApi,
    private readonly indexingPolicy?: KnowledgeIndexingPolicy,
    private readonly documentFileSystem: KnowledgeDocumentFileSystem = createNodeDocumentFileSystem()
  ) {}

  public async listDocumentFiles(workspaceRoot: string): Promise<KnowledgeWorkspaceFileEntry[]> {
    const resolvedRoot = resolve(workspaceRoot)
    const files: KnowledgeWorkspaceFileEntry[] = []

    await this.collectDocumentFiles(resolvedRoot, resolvedRoot, 0, files)
    return files
  }

  public async prepareDocument(
    file: KnowledgeWorkspaceFileEntry
  ): Promise<Nullable<KnowledgeWorkspacePreparedDocument>> {
    const contentBuffer = await this.documentFileSystem.read(file.absolutePath)
    if (!isLikelyTextFile(contentBuffer)) {
      // 已经成功读到的二进制文件不参与文本索引；读取失败必须交给同步方保留旧索引。
      return null
    }

    const content = contentBuffer.toString('utf-8').trim()
    if (isBlank(content)) return null

    return {
      file,
      document: {
        workspaceRoot: file.workspaceRoot,
        path: file.path,
        title: buildDocumentTitle(file.path, content),
        summary: buildDocumentSummary(content, file.path),
        content,
        sourceKind: file.sourceKind,
        tags: buildDocumentTags(file.path, file.sourceKind),
      },
      contentHash: buildNormalizedContentHash(content),
    }
  }

  public async listCodeCandidates(
    input: KnowledgeCodeCandidateInput
  ): Promise<KnowledgeWorkspaceCodeCandidate[]> {
    const workspaceRoot = resolve(input.workspaceRoot)
    const providerCandidates = await this.listCodeCandidatesViaProvider(workspaceRoot, input)
    if (providerCandidates.length > 0) return providerCandidates
    // 调用方传进来的路径提示统一转成工作区内的可移植相对路径。
    const pathHints = [...new Set(input.pathHints
      .map((hint) => toPortablePathText(hint.trim()).replace(/^\.?\//, ''))
      .filter((hint) => !isBlank(hint)))]
    const symbolHints = [...new Set(input.symbolHints
      .map((hint) => hint.trim())
      .filter((hint) => !isBlank(hint)))]
    const signalContext = await buildCodeSignalContext(workspaceRoot, pathHints)
    const candidates: KnowledgePathSearchCandidate[] = []
    const limit = input.limit ?? KnowledgeTuning.documents.defaultCodeCandidateLimit
    const scanState: KnowledgeCodeScanState = { scannedFiles: 0 }

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

  public async inspectIndexedFile(
    workspaceRoot: string,
    relativePath: string,
    sourceKind: KnowledgeSourceKind
  ): Promise<KnowledgeIndexedFileInspection> {
    const normalizedPath = toPortablePathText(relativePath)
      .replace(/^\.?\//, '')
    if (
      isBlank(normalizedPath)
      || !isWorkspacePathVisible(normalizedPath, (name, isDirectory, entryPath) =>
        this.shouldIncludeEntry('', entryPath, name, isDirectory))
    ) return {
        exists: false,
        indexable: false,
      }

    const absolutePath = resolve(workspaceRoot, normalizedPath)
    const normalizedResolvedPath = toRelativeWorkspacePath(workspaceRoot, absolutePath)
    if (!normalizedResolvedPath || normalizedResolvedPath !== normalizedPath) {
      // 防止相对路径逃出 workspaceRoot。
      return {
        exists: false,
        indexable: false,
      }
    }

    const fileStats = await this.documentFileSystem.inspect(absolutePath).catch(async (error: unknown) => {
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
      // 根目录暂时不可达，不能证明其中的每个文件都已删除。
      const rootStats = await this.documentFileSystem.inspect(resolve(workspaceRoot))
      if (!rootStats.isDirectory()) throw new AppError('UNAVAILABLE', '知识工作区目录暂不可用。')
      return null
    })
    if (!fileStats?.isFile()) return {
        exists: false,
        indexable: false,
      }

    const fileName = basename(normalizedPath)
    // 代码和文档用不同的纳入规则。
    const indexable =
      sourceKind === 'code'
        ? shouldIncludeCodeFile(fileName)
        : shouldIncludeDocumentFile(fileName)

    return {
      exists: true,
      indexable,
    }
  }

  /** 走宿主代码智能挑候选；没开启就返回空，交给正则扫描兜底。 */
  private async listCodeCandidatesViaProvider(
    workspaceRoot: string,
    input: KnowledgeCodeCandidateInput
  ): Promise<KnowledgeWorkspaceCodeCandidate[]> {
    const api = this.codeIntelligence
    if (!api?.isProjectEnabled(workspaceRoot)) return []

    const limit = input.limit ?? KnowledgeTuning.documents.defaultCodeCandidateLimit
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
      symbolHints.slice(0, KnowledgeTuning.codeCandidates.providerSymbolHints).map((hint) =>
        api.searchNodes({
          projectRoot: workspaceRoot,
          query: hint,
          limit: KnowledgeTuning.codeCandidates.providerSymbolHitLimit,
        })
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
      pathHints.slice(0, KnowledgeTuning.codeCandidates.providerPathHints).map((pathHint) =>
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
          summary: `${node.filePath} 中的 ${node.kind} ${node.name}`,
          content,
          sourceKind: 'code',
          tags: [
            'code',
            `symbol:${node.name}`,
            `codegraph-node:${node.id}`,
            `lines:${node.range.startLine}-${node.range.endLine}`,
          ],
        },
        contentHash: buildNormalizedContentHash(content),
      } satisfies KnowledgeWorkspaceCodeCandidate
    }))

    return compact(candidates)
  }

  /** 递归收集普通文档文件；必须完整取得目录视图，部分结果没有删除已有知识的权限。 */
  private async collectDocumentFiles(
    workspaceRoot: string,
    currentPath: string,
    depth: number,
    files: KnowledgeWorkspaceFileEntry[]
  ): Promise<void> {
    if (depth > KnowledgeTuning.documents.maxScanDepth) return

    const entries = await this.documentFileSystem.listDirectory(currentPath)

    const sortedEntries = [...entries].sort((left, right) =>
      left.name.localeCompare(right.name, 'en')
    )
    for (const entry of sortedEntries) {
      const entryPath = join(currentPath, entry.name)
      if (!this.shouldIncludeEntry(workspaceRoot, entryPath, entry.name, entry.isDirectory())) {
        // 跳过 node_modules、.git、隐藏缓存这类系统目录与文件。
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

      if (!entry.isFile() || !shouldIncludeDocumentFile(entry.name)) {
        continue
      }

      const fileStats = await this.documentFileSystem.inspect(entryPath)
      if (
        !fileStats.isFile()
        || fileStats.size <= 0
        || fileStats.size > KnowledgeTuning.documents.maxDocumentBytes
      ) {
        // 空文件和过大的文件都不入库。
        continue
      }

      files.push({
        workspaceRoot,
        absolutePath: entryPath,
        path: toPortablePathText(relative(workspaceRoot, entryPath)),
        sourceKind: resolveSourceKind(entryPath),
        fileSize: fileStats.size,
        modifiedAt: Math.trunc(fileStats.mtimeMs),
      })
    }
  }

  /** 递归扫描代码文件并把够格的放进候选池。 */
  private async collectCodeCandidates(args: {
    workspaceRoot: string
    currentPath: string
    depth: number
    pathHints: string[]
    symbolHints: string[]
    signalContext: KnowledgeCodeSignalContext
    limit: number
    candidates: KnowledgePathSearchCandidate[]
    scanState: KnowledgeCodeScanState
  }): Promise<void> {
    if (
      args.depth > KnowledgeTuning.documents.maxScanDepth
      || args.scanState.scannedFiles >= KnowledgeTuning.documents.maxCodeScanFiles
    ) return

    const entries = await this.documentFileSystem.listDirectory(args.currentPath).catch(() => null)
    if (!entries) return

    const sortedEntries = [...entries].sort((left, right) =>
      left.name.localeCompare(right.name, 'en')
    )
    for (const entry of sortedEntries) {
      if (args.scanState.scannedFiles >= KnowledgeTuning.documents.maxCodeScanFiles) return
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

      if (!entry.isFile() || !shouldIncludeCodeFile(entry.name)) {
        continue
      }

      args.scanState.scannedFiles += 1
      const candidate = await readCodeCandidate(
        args.workspaceRoot,
        entryPath,
        args.pathHints,
        args.symbolHints,
        args.signalContext
      )
      if (!candidate) {
        continue
      }

      // 候选池只保留排名靠前的一小批，控制后续嵌入与索引成本。
      insertCandidate(args.candidates, candidate, args.limit)
    }
  }

  /** 宿主可见性策略先判，再落到本包的默认名单。 */
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

    return isDefaultIncludedEntry(name, isDirectory)
  }
}
