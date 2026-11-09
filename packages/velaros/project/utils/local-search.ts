/**
 * 搜索：逐行文本匹配、路径名匹配、系统搜索跳过哪些目录。.gitignore 的解析与判定在 `@velaros-ai/core/path-rules`。
 */

import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { DiscoverySkippedDirectoryNames } from '@velaros-ai/core/path-rules/contracts'

import type { FileSearchOptions } from '../types/local-search.js'
import type { FileSearchProtectedDirectoryInput } from '../types/local-search.js'

import { createGuardedRegexMatcher } from './regex-guard.js'

/** 按搜索词生成逐行匹配函数，列号从 1 开始；正则按剩余额度在时限内扫描，失败抛 VALIDATION，字面搜索仍由调用方按额度惰性取用。 */
export function buildLineMatcher(input: {
  pattern: string
  regex?: boolean
  caseSensitive?: boolean
}): (line: string, limit: number) => Iterable<number> {
  if (input.regex) {
    const flags = input.caseSensitive ? 'g' : 'gi'
    const scan = createGuardedRegexMatcher(input.pattern, flags, 'code-unit')
    const matchLine = (line: string, limit: number): number[] => {
      try {
        return scan(line, limit).map((match) => match.index + 1)
      } catch (error) {
        throw new AppError('VALIDATION', AppError.getMessage(error))
      }
    }
    matchLine('', 1)
    return matchLine
  }

  const needle = input.caseSensitive ? input.pattern : input.pattern.toLowerCase()
  // 空 needle 会让游标永不推进而无限 yield。入参 schema 有 `min(1)` 兜着，但**依赖外层校验的
  // 防御不是防御**——本函数是内部可复用件，schema 只守工具入口那一条路。这里挡住，让空模式
  // 退化成"零匹配"而不是挂死进程。
  if (isEmpty(needle)) return () => []
  return function* matchLiteral(line: string) {
    const haystack = input.caseSensitive ? line : line.toLowerCase()
    let index = 0
    while (true) {
      const foundIndex = haystack.indexOf(needle, index)
      if (foundIndex === -1) return
      yield foundIndex + 1
      index = foundIndex + needle.length
    }
  }
}

/** macOS 上受隐私保护、搜索时跳过的主目录子目录名。 */
export const MacosTccProtectedSearchDirectoryNames: string[] = [
  'Music',
  'Pictures',
  'Movies',
  'Library',
]

const SearchSkippedDirectoryNameSet = new Set(DiscoverySkippedDirectoryNames)

/** 判断系统搜索是否跳过这个条目：隐藏文件，以及依赖、构建产物、缓存这类目录；不受限模式一律不跳过。 */
export function shouldSkipSearchEntry(
  name: string,
  isDirectory: boolean,
  includeHidden: boolean,
  unrestricted = false
): boolean {
  if (unrestricted) return false
  if (!includeHidden && name.startsWith('.')) return true
  return isDirectory && SearchSkippedDirectoryNameSet.has(name)
}

/** 判断是否跳过 macOS 上受隐私保护的主目录子目录（音乐、图片、影片、资源库），避免触发系统授权弹窗。 */
export function shouldSkipProtectedSearchDirectory(
  input: FileSearchProtectedDirectoryInput
): boolean {
  if (input.platform !== 'darwin') return false

  const rootPath = normalizePolicyPath(input.rootPath)
  const candidatePath = normalizePolicyPath(input.candidatePath)
  if (candidatePath === rootPath) return false

  const homeDir = normalizePolicyPath(input.homeDir)
  return MacosTccProtectedSearchDirectoryNames.some(
    (name) => candidatePath === normalizePolicyPath(`${homeDir}/${name}`)
  )
}

/** 把路径统一成 `/` 分隔，去掉重复和末尾的分隔符，便于比较。 */
function normalizePolicyPath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/\/+/gu, '/')
  return normalized.length <= 1 ? normalized : normalized.replace(/\/+$/u, '')
}

/** 按匹配方式判断相对路径是否命中搜索词：exact 要求完全相同；fuzzy 要求搜索词的字符按顺序出现；默认 contains 为包含，后两者不区分大小写。 */
export function matchesSearchPath(
  path: string,
  query: string,
  mode: FileSearchOptions['pathMatchMode']
): boolean {
  if (mode === 'exact') return path === query
  if (mode === 'fuzzy') {
    let index = 0
    const lowerPath = path.toLowerCase()
    for (const char of query.toLowerCase()) {
      index = lowerPath.indexOf(char, index)
      if (index === -1) return false
      index += 1
    }
    return true
  }
  return path.toLowerCase().includes(query.toLowerCase())
}

/** 把扩展名列表规整成小写、带点的集合，例如 `TS` 变成 `.ts`。 */
export function normalizeExtensions(extensions: LooseOptional<string[]>): Set<string> {
  return new Set(
    (extensions ?? []).map((extension) =>
      extension.startsWith('.') ? extension.toLowerCase() : `.${extension.toLowerCase()}`
    )
  )
}
