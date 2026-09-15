/**
 * 全局搜索：`SystemGlobalSearch`，宿主端口 `globalSearch` 的本地实现。接口见 `contract/files.ts` 的 `SystemGlobalSearchApi`。
 * 本地内核持有一个；遍历时跳过哪些条目由 `GitIgnoreSystemSearchPolicy.ts` 判定。
 */

import { lstat, readdir } from 'node:fs/promises'
import { basename, extname, join, relative } from 'node:path'

import { AppError } from '@velaros-ai/core/error'

import type {
  SystemFileEntry,
  SystemGlobalSearchOptions,
  SystemGlobalSearchResult,
  SystemSearchMatch,
} from '../contract/system.js'
import type { SystemGlobalSearchApi } from '../interface/internal.js'
import {
  buildLineMatcher,
  matchesSearchPath,
  normalizeExtensions,
  shouldSkipSystemSearchEntry,
  shouldSkipSystemSearchProtectedDirectory,
} from '../utils/search.js'
import { readSystemTextFile } from '../utils/text-file.js'

import { GitIgnoreSystemSearchPolicy } from './GitIgnoreSystemSearchPolicy.js'

const DefaultSearchLimit = 60
const DefaultSearchMaxDepth = 6
/** 内容搜索跳过大于这个字节数的文件。 */
const MaxSearchFileBytes = 1024 * 1024

export class SystemGlobalSearch implements SystemGlobalSearchApi {
  private readonly platform: NodeJS.Platform
  private readonly homeDir: string

  constructor(options: { platform: NodeJS.Platform; homeDir: string }) {
    this.platform = options.platform
    this.homeDir = options.homeDir
  }

  public async search(
    rootPath: string,
    options: SystemGlobalSearchOptions,
    abortSignal?: AbortSignal
  ): Promise<SystemGlobalSearchResult> {
    abortSignal?.throwIfAborted()
    const rootStats = await lstat(rootPath).catch(() => null)
    if (!rootStats) {
      throw new AppError('NOT_FOUND', `Search root not found: ${rootPath}`)
    }
    return options.mode === 'content'
      ? this.searchContent(rootPath, options, abortSignal)
      : this.searchPaths(rootPath, options, abortSignal)
  }

  /** 按相对路径搜：条目类型和扩展名先筛一遍，再按匹配方式比对，结果按路径排序。 */
  private async searchPaths(
    rootPath: string,
    options: SystemGlobalSearchOptions,
    abortSignal?: AbortSignal
  ): Promise<SystemGlobalSearchResult> {
    const query = options.query.trim()
    const limit = options.limit ?? DefaultSearchLimit
    const entries: SystemFileEntry[] = []
    const extensions = normalizeExtensions(options.extensions)
    const entryTypes = new Set(options.entryTypes ?? ['file', 'directory'])
    let matched = 0

    await this.walk(rootPath, options, abortSignal, async (absolutePath, type) => {
      if (!entryTypes.has(type)) return false
      if (type === 'file' && extensions.size > 0 && !extensions.has(extname(absolutePath).toLowerCase())) return false

      const relativePath = relative(rootPath, absolutePath) || '.'
      if (!matchesSearchPath(relativePath, query, options.pathMatchMode ?? 'contains')) return false
      matched += 1
      if (entries.length < limit) {
        entries.push({ path: relativePath, type })
      }
      return entries.length >= limit
    })

    entries.sort((left, right) => left.path.localeCompare(right.path, 'en'))
    return {
      mode: 'paths',
      rootPath,
      count: entries.length,
      truncated: matched > entries.length,
      entries,
    }
  }

  /** 按内容搜：逐个文件逐行匹配，跳过过大或读不出文本的文件，每个文件最多 maxResultsPerFile 条。 */
  private async searchContent(
    rootPath: string,
    options: SystemGlobalSearchOptions,
    abortSignal?: AbortSignal
  ): Promise<SystemGlobalSearchResult> {
    const limit = options.limit ?? DefaultSearchLimit
    const maxResultsPerFile = options.maxResultsPerFile ?? 5
    const extensions = normalizeExtensions(options.extensions)
    const matches: SystemSearchMatch[] = []
    const matcher = buildLineMatcher({
      pattern: options.query.trim(),
      regex: options.regex,
      caseSensitive: options.caseSensitive,
    })

    const truncated = await this.walk(rootPath, options, abortSignal, async (absolutePath, type) => {
      if (type !== 'file') return false
      if (extensions.size > 0 && !extensions.has(extname(absolutePath).toLowerCase())) return false
      const stats = await lstat(absolutePath).catch(() => null)
      if (!stats || stats.size > MaxSearchFileBytes) return false

      abortSignal?.throwIfAborted()
      const textFile = await readSystemTextFile(absolutePath).catch(() => null)
      if (!textFile) return false

      let perFileMatches = 0
      const lines = textFile.content.split(/\r?\n/)
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        abortSignal?.throwIfAborted()
        const line = lines[lineIndex] ?? ''
        for (const column of matcher(line)) {
          matches.push({
            path: relative(rootPath, absolutePath) || basename(absolutePath),
            line: lineIndex + 1,
            column,
            excerpt: line.trim(),
          })
          perFileMatches += 1
          if (matches.length >= limit || perFileMatches >= maxResultsPerFile) break
        }
        if (matches.length >= limit || perFileMatches >= maxResultsPerFile) break
      }

      return matches.length >= limit
    })

    return {
      mode: 'content',
      rootPath,
      count: matches.length,
      truncated: truncated || matches.length >= limit,
      matches,
    }
  }

  /**
   * 深度优先遍历搜索根：按名字排序、不跟随符号链接、最深 maxDepth 层；跳过隐藏项与依赖目录、gitignore 忽略的条目、受系统保护的目录。
   * onEntry 返回 true 表示已经够了，遍历立刻停下并返回 true。
   */
  private async walk(
    rootPath: string,
    options: SystemGlobalSearchOptions,
    abortSignal: Optional<AbortSignal>,
    onEntry: (absolutePath: string, type: SystemFileEntry['type']) => Promise<boolean>
  ): Promise<boolean> {
    abortSignal?.throwIfAborted()
    const maxDepth = options.maxDepth ?? DefaultSearchMaxDepth
    const ignorePolicy = new GitIgnoreSystemSearchPolicy(rootPath, { unrestricted: options.unrestricted })
    const visit = async (currentPath: string, depth: number): Promise<boolean> => {
      abortSignal?.throwIfAborted()
      if (depth > maxDepth) return false
      const stats = await lstat(currentPath).catch(() => null)
      if (!stats || stats.isSymbolicLink()) return false

      const type = stats.isDirectory() ? 'directory' : 'file'
      if (currentPath !== rootPath) {
        if (shouldSkipSystemSearchEntry(basename(currentPath), type === 'directory', !!options.includeHidden, !!options.unrestricted)) return false
        if (await ignorePolicy.shouldSkip(currentPath, type === 'directory')) return false
        if (type === 'directory' && shouldSkipSystemSearchProtectedDirectory({
          platform: this.platform,
          homeDir: this.homeDir,
          rootPath,
          candidatePath: currentPath,
        })) return false
        if (await onEntry(currentPath, type)) return true
      }
      if (type !== 'directory') return false

      const names = await readdir(currentPath).catch(() => [])
      names.sort((left, right) => left.localeCompare(right, 'en'))
      for (const name of names) {
        abortSignal?.throwIfAborted()
        if (await visit(join(currentPath, name), depth + 1)) return true
      }
      return false
    }

    return visit(rootPath, 0)
  }
}
