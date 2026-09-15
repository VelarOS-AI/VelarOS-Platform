/**
 * 搜索：逐行文本匹配、路径名匹配、gitignore 规则、系统搜索跳过哪些目录。
 */

import { readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { GitIgnoreRule, SystemSearchProtectedDirectoryInput } from '../types/files.js'
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
      throw new AppError('VALIDATION', `Invalid regex pattern: ${message}`)
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

/** 从某个路径往上找最近的 git 仓库根目录；找不到返回 null。 */
export async function findSystemSearchRepoRoot(startPath: string): Promise<Nullable<string>> {
  let currentPath = resolve(startPath)
  const startStats = await stat(currentPath).catch(() => null)
  if (startStats?.isFile()) currentPath = dirname(currentPath)

  while (true) {
    const gitMarker = await stat(`${currentPath}${sep}.git`).catch(() => null)
    if (gitMarker) return currentPath

    const parentPath = dirname(currentPath)
    if (parentPath === currentPath) return null
    currentPath = parentPath
  }
}

/** 读出一个 .gitignore 文件的各行；文件不存在返回空列表。 */
export async function readIgnoreLines(path: string): Promise<string[]> {
  const content = await readFile(path, 'utf-8').catch(() => '')
  if (isEmpty(content)) return []
  return content.split(/\r?\n/u)
}

/** 把 .gitignore 的一行解析成匹配规则；空行与注释返回 null。 */
export function parseGitIgnoreRule(rawLine: string, baseRelativePath: string): Nullable<GitIgnoreRule> {
  let line = rawLine.trimEnd()
  if (isEmpty(line) || line.startsWith('#')) return null

  let negative = false
  if (line.startsWith('!')) {
    negative = true
    line = line.slice(1)
  } else if (line.startsWith('\\#') || line.startsWith('\\!')) {
    line = line.slice(1)
  }

  const directoryOnly = line.endsWith('/')
  line = line.replace(/^\/+/u, '').replace(/\/+$/u, '')
  if (isEmpty(line)) return null

  const anchored = rawLine.startsWith('/') || line.includes('/')
  return {
    baseRelativePath,
    negative,
    directoryOnly,
    anchored,
    segments: line.split('/').filter((segment) => segment.length > 0),
  }
}

/** 判断一条 gitignore 规则是否命中某个相对路径。 */
export function matchesGitIgnoreRule(
  rule: GitIgnoreRule,
  candidateRelativePath: string,
  isDirectory: boolean
): boolean {
  const candidateSegments = candidateRelativePath.split('/').filter((segment) => segment.length > 0)
  if (isEmpty(candidateSegments)) return false

  const baseSegments =
    isEmpty(rule.baseRelativePath) || rule.baseRelativePath === '.'
      ? []
      : rule.baseRelativePath.split('/').filter((segment) => segment.length > 0)
  if (!startsWithSegments(candidateSegments, baseSegments)) return false

  const scopedSegments = candidateSegments.slice(baseSegments.length)
  if (isEmpty(scopedSegments)) return false

  if (rule.anchored) {
    if (!startsWithSegments(scopedSegments, rule.segments)) return false
    return !rule.directoryOnly || isDirectory || scopedSegments.length > rule.segments.length
  }

  for (let index = 0; index < scopedSegments.length; index += 1) {
    const segment = scopedSegments[index] ?? ''
    if (!matchesGitIgnoreSegment(rule.segments[0] ?? '', segment)) continue
    return !rule.directoryOnly || isDirectory || index < scopedSegments.length - 1
  }

  return false
}

/** 判断一段 gitignore 通配模式是否匹配一个路径片段。 */
function matchesGitIgnoreSegment(pattern: string, value: string): boolean {
  if (pattern === value) return true
  const expression = new RegExp(`^${gitIgnoreSegmentPatternToRegex(pattern)}$`, 'u')
  return expression.test(value)
}

/** 把 gitignore 片段里的 `*` 与 `?` 通配转成正则表达式文本。 */
function gitIgnoreSegmentPatternToRegex(pattern: string): string {
  let expression = ''
  for (const char of pattern) {
    switch (char) {
      case '*':
        expression += '[^/]*'
        break
      case '?':
        expression += '[^/]'
        break
      default:
        expression += escapeRegexChar(char)
        break
    }
  }
  return expression
}

/** 转义正则表达式里的特殊字符。 */
function escapeRegexChar(char: string): string {
  return /[.+^${}()|[\]\\]/u.test(char) ? `\\${char}` : char
}

/** 列出从根目录到某个目录之间的每一级目录，由浅到深。 */
export function directoriesBetween(rootPath: string, directoryPath: string): string[] {
  const directories: string[] = []
  let currentPath = resolve(directoryPath)

  while (isInsidePath(currentPath, rootPath)) {
    directories.push(currentPath)
    if (currentPath === rootPath) break
    currentPath = dirname(currentPath)
  }

  directories.reverse()
  return directories
}

/** 判断一串路径片段是否以另一串片段开头。 */
function startsWithSegments(candidate: string[], prefix: string[]): boolean {
  if (prefix.length > candidate.length) return false
  return prefix.every((segment, index) => candidate[index] === segment)
}

/** 判断一个路径是否在根目录之内（含根目录本身）。 */
export function isInsidePath(candidatePath: string, rootPath: string): boolean {
  const resolvedCandidate = resolve(candidatePath)
  const resolvedRoot = resolve(rootPath)
  if (resolvedCandidate === resolvedRoot) return true
  if (!isAbsolute(resolvedCandidate) || !isAbsolute(resolvedRoot)) return false
  return resolvedCandidate.startsWith(`${resolvedRoot}${sep}`)
}

/** 算出相对路径，并统一用 `/` 分隔。 */
export function toPortableRelativePath(rootPath: string, candidatePath: string): string {
  return relative(rootPath, candidatePath).replaceAll('\\', '/')
}

/** 系统搜索默认跳过的目录名：版本库、依赖、虚拟环境、构建产物、缓存与编辑器配置。 */
export const SystemSearchSkippedDirectoryNames: string[] = [
  '.codegraph',
  '.git',
  '.hg',
  '.jj',
  '.svn',
  'node_modules',
  'vendor',
  '.venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.data',
  'dist',
  'build',
  'out',
  'coverage',
  '.idea',
  '.vscode',
  'Library',
]

/** macOS 上受隐私保护、搜索时跳过的主目录子目录名。 */
export const MacosTccProtectedSearchDirectoryNames: string[] = [
  'Music',
  'Pictures',
  'Movies',
  'Library',
]

const SystemSearchSkippedDirectoryNameSet =
  new Set(SystemSearchSkippedDirectoryNames)

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

/** 读出从仓库根到某个目录之间各级 .gitignore 里的规则，按从上到下的顺序排好；读不到的文件当作没有规则。 */
export async function readGitIgnoreRulesBetween(repoRootPath: string, directoryPath: string): Promise<GitIgnoreRule[]> {
  const rules: GitIgnoreRule[] = []
  for (const directory of directoriesBetween(repoRootPath, directoryPath)) {
    const baseRelativePath = toPortableRelativePath(repoRootPath, directory)
    for (const line of await readIgnoreLines(`${directory}${sep}.gitignore`)) {
      const rule = parseGitIgnoreRule(line, baseRelativePath)
      if (rule) rules.push(rule)
    }
  }
  return rules
}
