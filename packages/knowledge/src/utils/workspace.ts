/** 工作区扫描的公共判定：哪些文件能入库、标题摘要标签怎么生成、代码候选怎么评分与取舍。 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, relative, resolve } from 'node:path'

import { clamp, compact, first, isBlank, isEmpty, last, toNullable, truncate, unique } from '@velaros-ai/core'

import { KnowledgeIndexStatuses } from '../contract/constants.js'
import type { KnowledgeCodeSymbol } from '../types/code.js'
import type {
  KnowledgeCodeSignalContext,
  KnowledgeDocumentFileSystem,
  KnowledgePathSearchCandidate,
  KnowledgeWorkspaceFileEntry,
} from '../types/ingestion.js'
import type {
  KnowledgeIndexRuntime,
  KnowledgeRecord,
  KnowledgeSourceKind,
} from '../types/knowledge.js'
import type { KnowledgeFileIndexRecord } from '../types/storage.js'

import {
  createImportTargetCandidates,
  extractImports,
  extractSymbols,
  getCodeExtensions,
  isLikelyTextFile,
  scorePathMatch,
} from './code.js'
import { buildNormalizedContentHash } from './indexing.js'
import { getRelativePathInsideRoot, toPortablePathText, toPortableRelativePath } from './paths.js'
import { KnowledgeTuning } from './tuning.js'

/** 允许作为普通文本知识入库的扩展名。 */
const TextExtensions = new Set(['.md', '.mdx', '.txt'])

/** 允许作为配置知识入库的文件名；改这份名单和改「什么算项目配置」是一回事。 */
const AllowedConfigNames = [
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

/** 默认跳过的目录名：依赖、版本控制、缓存与构建产物。 */
const DefaultHiddenDirectories = new Set([
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

/** 造一份走 Node 文件系统的目录读取口。 */
export function createNodeDocumentFileSystem(): KnowledgeDocumentFileSystem {
  return {
    listDirectory: (path) => readdir(path, { withFileTypes: true }),
    read: (path) => readFile(path),
    inspect: (path) => stat(path),
  }
}

/** 按默认名单判断一项该不该进索引；宿主策略先于它生效。 */
export function isDefaultIncludedEntry(name: string, isDirectory: boolean): boolean {
  if (isDirectory && (name.startsWith('.') || DefaultHiddenDirectories.has(name))) return false
  return name !== '.DS_Store' && !name.endsWith('.map')
}

/** 这个普通文档文件允不允许进知识库。 */
export function shouldIncludeDocumentFile(name: string): boolean {
  const extension = extname(name).toLowerCase()
  if (TextExtensions.has(extension)) return true

  return AllowedConfigNames.some((pattern) => pattern.test(name))
}

/** 这个代码文件允不允许作为候选；声明文件与压缩产物默认排除。 */
export function shouldIncludeCodeFile(name: string): boolean {
  const extension = extname(name).replace(/^\./, '').toLowerCase()
  if (!getCodeExtensions().includes(extension)) return false

  return !name.endsWith('.d.ts') && !name.endsWith('.min.js')
}

/** 按扩展名判断知识来源类型。 */
export function resolveSourceKind(path: string): KnowledgeSourceKind {
  const extension = extname(path).toLowerCase()
  if (extension === '.json') return 'json'
  if (TextExtensions.has(extension)) return extension === '.md' || extension === '.mdx' ? 'markdown' : 'text'
  return 'config'
}

/** 优先拿 markdown 的一级标题当文档标题，没有就用文件名。 */
export function buildDocumentTitle(path: string, content: string): string {
  const heading = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^#{1,6}\s+\S+/.test(line))

  if (heading) return truncate(heading
      .replace(/^#{1,6}\s+/, '')
      .trim(), KnowledgeTuning.documents.titleMaxChars)

  return truncate(basename(path), KnowledgeTuning.documents.titleMaxChars)
}

/** 从正文里取第一段有信息量的文本当摘要。 */
export function buildDocumentSummary(content: string, path: string): string {
  const lines = content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => !isBlank(line))
    .filter((line) => !/^#{1,6}\s+/.test(line))
    .filter((line) => !/^```/.test(line))

  const summary =
    lines.find((line) => line.length >= KnowledgeTuning.documents.summaryMinLineChars)
    ?? first(lines)
    ?? path

  return truncate(summary, KnowledgeTuning.documents.summaryMaxChars)
}

/** 按路径与来源类型生成文档标签。 */
export function buildDocumentTags(path: string, sourceKind: KnowledgeSourceKind): string[] {
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

/** 按导出符号或首个有效代码行生成代码摘要。 */
export function buildCodeSummary(
  relativePath: string,
  symbols: KnowledgeCodeSymbol[],
  content: string
): string {
  const exportedSymbols = symbols.filter((symbol) => symbol.exported)
  // 导出符号更能代表这个模块的能力，优先展示。
  const preferredSymbols = (!isEmpty(exportedSymbols) ? exportedSymbols : symbols)
    .slice(0, KnowledgeTuning.documents.codeSummarySymbols)
    .map((symbol) => `${symbol.name}:${symbol.kind}`)

  if (!isEmpty(preferredSymbols)) return truncate(
    `代码符号：${preferredSymbols.join(', ')}`,
    KnowledgeTuning.documents.summaryMaxChars
  )

  const firstMeaningfulLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => !isBlank(line) && !line.startsWith('//'))

  return truncate((firstMeaningfulLine ?? relativePath), KnowledgeTuning.documents.summaryMaxChars)
}

/** 生成代码标签：路径信息加符号信息，同一个符号存三种写法方便不同提示命中。 */
export function buildCodeTags(relativePath: string, symbols: KnowledgeCodeSymbol[]): string[] {
  const segments = relativePath.split('/').filter(Boolean)
  const filename = last(segments) ?? relativePath
  const extension = extname(filename).replace(/^\./, '').toLowerCase()
  const symbolTags = symbols
    .slice(0, KnowledgeTuning.documents.codeTagSymbols)
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

/** 把一个绝对路径安全转成工作区内的可移植相对路径；逃出根就返回 null。 */
export function toRelativeWorkspacePath(
  workspaceRoot: string,
  absolutePath: string
): Nullable<string> {
  const relativePath = getRelativePathInsideRoot(workspaceRoot, absolutePath)
  if (!relativePath || relativePath === '.') return null
  return toPortableRelativePath(relativePath)
}

/** 把一条路径提示解析成工作区内的绝对路径；逃出根就返回 null。 */
export function resolveHintPath(workspaceRoot: string, pathHint: string): Nullable<string> {
  const normalizedHint = toPortablePathText(pathHint.trim())
  if (isBlank(normalizedHint)) return null

  const absolutePath = resolve(workspaceRoot, normalizedHint)
  return toRelativeWorkspacePath(workspaceRoot, absolutePath) ? absolutePath : null
}

/** 按路径提示给一个代码文件打分。 */
export function scorePathHints(relativePath: string, pathHints: string[]): number {
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
      bestScore = Math.max(
        bestScore,
        Math.min(score / KnowledgeTuning.codeCandidates.pathScoreDivisor, 1)
      )
    }
  }

  return clamp(bestScore, 0, 1)
}

/** 按直接路径与 import 关系信号打分。 */
export function scoreRelationHints(
  relativePath: string,
  signalContext: KnowledgeCodeSignalContext
): number {
  let score = 0
  if (signalContext.directHintPaths.has(relativePath)) {
    score += KnowledgeTuning.codeCandidates.directHintScore
  }
  if (signalContext.importedTargetPaths.has(relativePath)) {
    score += KnowledgeTuning.codeCandidates.importedTargetScore
  }
  return clamp(score, 0, KnowledgeTuning.codeCandidates.relationScoreCap)
}

/** 按符号提示给代码内容打分：符号精确命中最强，正文包含最弱。 */
export function scoreSymbolHints(
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
      score += KnowledgeTuning.codeCandidates.symbolExactScore
      continue
    }
    if (symbols.some((symbol) => symbol.name.toLowerCase().includes(normalizedHint))) {
      score += KnowledgeTuning.codeCandidates.symbolPartialScore
      continue
    }
    if (normalizedContent.includes(normalizedHint)) {
      score += KnowledgeTuning.codeCandidates.symbolContentScore
    }
  }

  return clamp(score, 0, KnowledgeTuning.codeCandidates.symbolScoreCap)
}

/** 当前文件 import 了提示文件时也算相关代码。 */
export function scoreImportRelation(
  absolutePath: string,
  content: string,
  workspaceRoot: string,
  signalContext: KnowledgeCodeSignalContext
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
      const relativeCandidatePath = toRelativeWorkspacePath(workspaceRoot, candidatePath)
      if (relativeCandidatePath && signalContext.directHintPaths.has(relativeCandidatePath)) {
        score += KnowledgeTuning.codeCandidates.importRelationScore
        break
      }
    }
  }

  return clamp(score, 0, KnowledgeTuning.codeCandidates.importScoreCap)
}

/** 把一个候选放进候选池并按分数裁剪，同路径只留分高的那个。 */
export function insertCandidate(
  candidates: KnowledgePathSearchCandidate[],
  candidate: KnowledgePathSearchCandidate,
  limit: number
): void {
  const existingIndex = candidates.findIndex(
    (entry) => entry.candidate.document.path === candidate.candidate.document.path
  )
  if (existingIndex >= 0) {
    if (candidates[existingIndex].score >= candidate.score) return
    candidates.splice(existingIndex, 1)
  }

  candidates.push(candidate)
  candidates.sort((left, right) => right.score - left.score)
  const bufferedLimit = limit * KnowledgeTuning.codeCandidates.bufferMultiplier
  if (candidates.length > bufferedLimit) {
    // 先留出缓冲，最终排序后再截断。
    candidates.length = bufferedLimit
  }
}

/** 读取并评分单个代码候选；和本次线索完全无关的文件不读内容。 */
export async function readCodeCandidate(
  workspaceRoot: string,
  absolutePath: string,
  pathHints: string[],
  symbolHints: string[],
  signalContext: KnowledgeCodeSignalContext
): Promise<Nullable<KnowledgePathSearchCandidate>> {
  const fileStats = await stat(absolutePath).catch(() => null)
  if (
    !fileStats?.isFile()
    || fileStats.size <= 0
    || fileStats.size > KnowledgeTuning.documents.maxCodeFileBytes
  ) return null

  const relativePath = relative(workspaceRoot, absolutePath).replaceAll('\\', '/')
  const pathScore = scorePathHints(relativePath, pathHints)
  const relationScore = scoreRelationHints(relativePath, signalContext)
  const needsSymbolInspection = !isEmpty(symbolHints) || pathScore > 0 || relationScore > 0
  if (!needsSymbolInspection) return null

  const contentBuffer = await readFile(absolutePath).catch(() => null)
  if (!contentBuffer || !isLikelyTextFile(contentBuffer)) return null

  const content = contentBuffer.toString('utf-8').trim()
  if (isBlank(content)) return null

  const symbols = extractSymbols(relativePath, content)
  const symbolScore = scoreSymbolHints(content, symbols, symbolHints)
  const importScore = scoreImportRelation(absolutePath, content, workspaceRoot, signalContext)
  if (pathScore <= 0 && symbolScore <= 0 && relationScore <= 0 && importScore <= 0) {
    // 读完仍没有任何相关信号，就不作为候选。
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
        summary: buildCodeSummary(relativePath, symbols, content),
        content,
        sourceKind: 'code',
        tags: buildCodeTags(relativePath, symbols),
      },
      contentHash: buildNormalizedContentHash(content),
    },
    score: pathScore + relationScore + importScore + symbolScore,
  }
}

/** 从路径提示里提取直接路径与相邻 import 目标，给代码候选选择提供关系信号。 */
export async function buildCodeSignalContext(
  workspaceRoot: string,
  pathHints: string[]
): Promise<KnowledgeCodeSignalContext> {
  const directHintPaths = new Set<string>()
  const importedTargetPaths = new Set<string>()

  for (const pathHint of pathHints.slice(0, KnowledgeTuning.codeCandidates.signalPathHints)) {
    const absoluteHintPath = resolveHintPath(workspaceRoot, pathHint)
    if (!absoluteHintPath) {
      continue
    }

    const relativeHintPath = toRelativeWorkspacePath(workspaceRoot, absoluteHintPath)
    if (!relativeHintPath) {
      continue
    }
    directHintPaths.add(relativeHintPath)

    if (!shouldIncludeCodeFile(basename(relativeHintPath))) {
      // 非代码提示只作为直接路径信号，不继续解析 imports。
      continue
    }

    const fileStats = await stat(absoluteHintPath).catch(() => null)
    if (
      !fileStats?.isFile()
      || fileStats.size <= 0
      || fileStats.size > KnowledgeTuning.documents.maxCodeFileBytes
    ) {
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

    for (const importRecord of extractImports(absoluteHintPath, content)) {
      if (!importRecord.isRelative) {
        continue
      }

      // 相对 import 的目标文件往往和提示文件强相关，也加入候选信号。
      for (const candidatePath of createImportTargetCandidates(
        importRecord.specifier,
        absoluteHintPath,
        workspaceRoot
      )) {
        const relativeCandidatePath = toRelativeWorkspacePath(workspaceRoot, candidatePath)
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

/** 文件系统元信息和上次快照是不是一致：来源类型、大小、修改时间都得对上。 */
export function matchesFileSnapshot(
  file: KnowledgeWorkspaceFileEntry,
  snapshot: KnowledgeFileIndexRecord,
  sourceKind: KnowledgeSourceKind
): boolean {
  return (
    snapshot.sourceKind === sourceKind &&
    snapshot.sourceKind === file.sourceKind &&
    snapshot.fileSize === file.fileSize &&
    snapshot.modifiedAt === file.modifiedAt
  )
}

/** 内容或分块快照是不是坏了；嵌入 profile 切换不算重建条件。 */
export function needsContentReindex(
  existing: KnowledgeRecord,
  snapshot: Nullable<KnowledgeFileIndexRecord>,
  runtime: KnowledgeIndexRuntime
): boolean {
  return (
    existing.indexStatus !== KnowledgeIndexStatuses.READY ||
    existing.chunkCount <= 0 ||
    isBlank(existing.indexTextHash) ||
    (!!snapshot && snapshot.indexRuntimeKey !== runtime.indexRuntimeKey)
  )
}

/** 判断一条相对路径的每一级是不是都属于可见的工作区内容。 */
export function isWorkspacePathVisible(
  relativePath: string,
  isEntryIncluded: (name: string, isDirectory: boolean, relativePath: string) => boolean
): boolean {
  const segments = relativePath.split('/').filter(Boolean)
  if (isEmpty(segments)) return false

  return segments.every((segment, index) =>
    isEntryIncluded(
      segment,
      index < segments.length - 1,
      segments.slice(0, index + 1).join('/')
    )
  )
}
