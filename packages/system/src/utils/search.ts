/**
 * 搜索：逐行文本匹配、路径名匹配、系统搜索跳过哪些目录。.gitignore 的解析与判定在 `@velaros-ai/path-rules`。
 */

import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { DiscoverySkippedDirectoryNames } from '@velaros-ai/path-rules/contracts'

import type { SystemSearchProtectedDirectoryInput } from '../types/paths.js'
import type { SystemGlobalSearchOptions } from '../types/system.js'

/** 按搜索词生成逐行匹配函数，返回一行里每处命中的列号（从 1 开始），支持正则与区分大小写；正则写错时抛 VALIDATION，空的字面搜索词匹配不到任何东西。 */
export function buildLineMatcher(input: { pattern: string; regex?: boolean; caseSensitive?: boolean }): (line: string) => Iterable<number> {
  if (input.regex) {
    const flags = input.caseSensitive ? 'g' : 'gi'
    let expression: RegExp
    try {
      expression = new RegExp(input.pattern, flags)
    } catch (err) {
      const message = AppError.getMessage(err)
      throw new AppError('VALIDATION', `正则写得不对：${message}`)
    }
    return (line) => {
      const starts: number[] = []
      expression.lastIndex = 0
      let match = expression.exec(line)
      while (match) {
        starts.push(match.index + 1)
        if (isEmpty(match[0])) {
          expression.lastIndex += 1
        }
        match = expression.exec(line)
      }
      return starts
    }
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

const SystemSearchSkippedDirectoryNameSet = new Set(DiscoverySkippedDirectoryNames)

/** 判断系统搜索是否跳过这个条目：隐藏文件，以及依赖、构建产物、缓存这类目录；不受限模式一律不跳过。 */
export function shouldSkipSystemSearchEntry(
  name: string,
  isDirectory: boolean,
  includeHidden: boolean,
  unrestricted = false,
): boolean {
  if (unrestricted) return false
  if (!includeHidden && name.startsWith('.')) return true
  return isDirectory && SystemSearchSkippedDirectoryNameSet.has(name)
}

/** 判断是否跳过 macOS 上受隐私保护的主目录子目录（音乐、图片、影片、资源库），避免触发系统授权弹窗。 */
export function shouldSkipSystemSearchProtectedDirectory(
  input: SystemSearchProtectedDirectoryInput,
): boolean {
  if (input.platform !== 'darwin') return false

  const rootPath = normalizePolicyPath(input.rootPath)
  const candidatePath = normalizePolicyPath(input.candidatePath)
  if (candidatePath === rootPath) return false

  const homeDir = normalizePolicyPath(input.homeDir)
  return MacosTccProtectedSearchDirectoryNames.some(
    (name) => candidatePath === normalizePolicyPath(`${homeDir}/${name}`),
  )
}

/** 把路径统一成 `/` 分隔，去掉重复和末尾的分隔符，便于比较。 */
function normalizePolicyPath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/\/+/gu, '/')
  return normalized.length <= 1 ? normalized : normalized.replace(/\/+$/u, '')
}

/** 按匹配方式判断相对路径是否命中搜索词：exact 要求完全相同；fuzzy 要求搜索词的字符按顺序出现；默认 contains 为包含，后两者不区分大小写。 */
export function matchesSearchPath(path: string, query: string, mode: SystemGlobalSearchOptions['pathMatchMode']): boolean {
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
