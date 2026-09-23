/**
 * glob 匹配：`PathMatcher`。接口 `PathMatcherApi` 在本文件的类上方，由 `contract/provides.ts` 登记。
 * 整个进程一份 `pathMatcher`；编译好的匹配器缓存在实例里，没有模块级的可变状态。
 */

import picomatch from 'picomatch'

import { isUndefined } from '@velaros-ai/core'

import type { PathMatchOptions } from '../types/path-rules.js'
import { directoryGlobBase, hasGlobMagic } from '../utils/glob.js'
import { isUnderPathText, normalizeRelativePath, samePathText } from '../utils/path.js'
import { PathRulesTuning } from '../utils/tuning.js'

/**
 * 路径与 glob 规则的匹配，实例是 `pathMatcher`。规则按三种写法解释：
 *
 *  1. 以 `/` 结尾 → 按目录前缀匹配；
 *  2. 不含通配特殊字符 → 精确相等，或按目录前缀匹配（`src` 命中 `src/a.ts`）；
 *  3. 其余（含 `*`、`?`、`[ ]`、`{ }`、`!` 等）→ 交给 picomatch，点开头的文件也匹配；`dir/**` 这种「目录下面的一切」连目录自己一起命中。
 *
 * 缺省区分大小写；大小写不敏感的盘上按路径身份判定时传 `caseSensitive: false`。
 */
export interface PathMatcherApi {
  /** 路径是否命中任一条规则；规则为空时不命中。 */
  matchesAny(path: string, patterns?: readonly string[], options?: PathMatchOptions): boolean
  /** 路径是否命中这一条规则。 */
  matches(path: string, pattern: string, options?: PathMatchOptions): boolean
}

export class PathMatcher implements PathMatcherApi {
  /** 按 pattern 与大小写敏感与否缓存编译好的 picomatch 匹配器，容量见 `PathRulesTuning.glob.matcherCacheEntries`。 */
  private readonly matchers = new Map<string, (input: string) => boolean>()

  public matchesAny(
    path: string,
    patterns: readonly string[] = [],
    options?: PathMatchOptions
  ): boolean {
    if (patterns.length === 0) return false
    const target = normalizeRelativePath(path)
    return patterns.some((pattern) => this.matchesNormalized(target, pattern, options))
  }

  public matches(path: string, pattern: string, options?: PathMatchOptions): boolean {
    return this.matchesNormalized(normalizeRelativePath(path), pattern, options)
  }

  /** 判定的正体：目标已经规整过，按三种写法分支。 */
  private matchesNormalized(target: string, pattern: string, options?: PathMatchOptions): boolean {
    const normalized = normalizeRelativePath(pattern)
    const caseSensitive = options?.caseSensitive ?? true
    if (normalized.endsWith('/'))
      return isUnderPathText(target, normalized.slice(0, -1), caseSensitive)
    const directoryBase = directoryGlobBase(normalized)
    if (directoryBase)
      return (
        samePathText(target, directoryBase, caseSensitive) ||
        isUnderPathText(target, directoryBase, caseSensitive)
      )
    if (!hasGlobMagic(normalized))
      return (
        samePathText(target, normalized, caseSensitive) ||
        isUnderPathText(target, normalized, caseSensitive)
      )
    return this.matcherFor(normalized, caseSensitive)(target)
  }

  /** 取编译好的 picomatch 匹配器：命中的挪到队尾，超容量时淘汰最久没用的。 */
  private matcherFor(pattern: string, caseSensitive: boolean): (input: string) => boolean {
    const key = `${caseSensitive ? 's' : 'i'}\u0000${pattern}`
    const cached = this.matchers.get(key)
    if (cached) {
      this.matchers.delete(key)
      this.matchers.set(key, cached)
      return cached
    }

    // 先编译再淘汰：pattern 写错抛出来时不该冲掉一个还能用的匹配器。
    const matcher = picomatch(pattern, { dot: true, nocase: !caseSensitive })
    if (this.matchers.size >= PathRulesTuning.glob.matcherCacheEntries) {
      const oldest = this.matchers.keys().next().value
      if (!isUndefined(oldest)) this.matchers.delete(oldest)
    }
    this.matchers.set(key, matcher)
    return matcher
  }
}

/** 整个进程唯一的 glob 匹配器。 */
export const pathMatcher: PathMatcherApi = new PathMatcher()
