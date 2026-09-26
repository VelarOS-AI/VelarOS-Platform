/**
 * 内核查询面（ProjectQueries）用的纯函数：搜索范围的缺省排除、搜索命中的次序、符号去重、证据窗口的目标范围、有上限的 Map。
 */
import { isPresent, isUndefined, optionalWhen } from '@velaros-ai/core'

import type { ProjectSymbol } from '../../types/adapter.js'
import type { Range } from '../../types/common.js'
import type { SearchHit, SearchInput } from '../../types/io.js'
import type { ResolvedTarget } from '../../types/target.js'

/** 搜整个项目时默认跳过的目录：依赖、git 仓库、构建产物、覆盖率报告。 */
const DefaultImplicitSearchExcludeGlobs = [
  'node_modules/**',
  '.git/**',
  'dist/**',
  'coverage/**',
] as const

/** 调用方没说要不要排除 gitignore 的文件时的缺省：点名搜某个子目录时不排除，搜整个项目时不表态、交给列举层。 */
export function defaultExcludeGitignoredForRoot(root?: string): boolean | undefined {
  const normalizedRoot = root?.trim()
  // 显式搜索子目录时默认保留 ignored 子项，避免用户点名的目录被整体跳过。
  return optionalWhen(normalizedRoot && normalizedRoot !== '.', false)
}

/** 这次搜索的排除 glob：搜整个项目时先加上默认跳过的目录，再加调用方给的 exclude。 */
export function resolveSearchExcludeGlobs(input: SearchInput): string[] {
  return [...defaultImplicitSearchExcludeGlobs(input.root), ...(input.exclude ?? [])]
}

/** 默认跳过的目录只在搜整个项目时套用；点名搜子目录时一个都不加。 */
function defaultImplicitSearchExcludeGlobs(root?: string): string[] {
  const normalizedRoot = root?.trim()
  if (normalizedRoot && normalizedRoot !== '.') return []
  return [...DefaultImplicitSearchExcludeGlobs]
}

/**
 * 搜索命中的次序：分高的在前，同分按路径、再按行列。ripgrep 多线程交回的次序每次不一样，
 * 不在这里定下来，同一份内容搜两遍结果就不一样：模型看着乱，进了上下文的结果也坏了前缀缓存。
 */
export function compareSearchHits(a: SearchHit, b: SearchHit): number {
  return (
    b.score - a.score ||
    (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
    (a.range?.startLine ?? 0) - (b.range?.startLine ?? 0) ||
    (a.range?.startColumn ?? 0) - (b.range?.startColumn ?? 0)
  )
}

/** 证据包对准的目标范围：存过的目标用它自己的范围，否则用入参给的范围（起止行都给了才算）。 */
export function resolveEvidenceTargetRange(
  storedTarget?: ResolvedTarget,
  inputRange?: Partial<Range>
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

/** 符号的身份：路径、种类、容器、名字加起点，多个适配器报的同一个符号按它去重。 */
function symbolIdentityKey(symbol: ProjectSymbol): string {
  const start = isPresent(symbol.range.startOffset)
    ? String(symbol.range.startOffset)
    : `${symbol.range.startLine}:${symbol.range.startColumn ?? ''}`
  return [symbol.path, symbol.kind, symbol.container ?? '', symbol.name, start].join('\u0000')
}

/** 按身份去掉重复的符号，保留第一次出现的那个和原来的顺序。 */
export function uniqueSymbols(symbols: ProjectSymbol[]): ProjectSymbol[] {
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

/** 按插入顺序淘汰最旧的条目，把 Map 体积约束在上限内（Map 保留插入顺序）。 */
export function capInsertionOrderedMap(map: Map<string, unknown>, maxSize: number): void {
  while (map.size > maxSize) {
    const oldest = map.keys().next().value
    if (isUndefined(oldest)) break
    map.delete(oldest)
  }
}
