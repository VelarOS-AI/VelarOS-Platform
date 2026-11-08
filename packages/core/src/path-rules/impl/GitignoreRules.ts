/**
 * .gitignore 的解析与判定：`GitignoreRules`。接口 `GitignoreRulesApi` 在本文件的类上方，由 `contract/provides.ts` 登记。
 * 整个进程一份 `gitignoreRules`；规则由调用方持有，这里只缓存规则的派生匹配器。
 */

import { isEmpty } from '@velaros-ai/core'

import type { GitignoreRule } from '../types/path-rules.js'
import { readGitignoreContent } from '../utils/discovery.js'
import {
  buildGitignorePatterns,
  compileGitignorePattern,
  normalizeGitignorePath,
  trimGitignoreLine,
} from '../utils/gitignore.js'

/**
 * .gitignore 的解析与判定，实例是 `gitignoreRules`：取反（`!`）、锚定（`/` 开头或中间有 `/`）、目录限定（`/` 结尾）、
 * `**`、字符类、转义都认；同一批规则里后面的覆盖前面的。目录被忽略时它下面的一切跟着被忽略。
 *
 * 判定一律区分大小写——git 自己就是这么判的，跟盘区不区分大小写无关。
 */
export interface GitignoreRulesApi {
  /** 解析一份 .gitignore 的正文；`baseRelativePath` 是以 `/` 分隔的所在目录相对规则根路径（在根上给空串）。 */
  parse(content: string, baseRelativePath?: string): GitignoreRule[]
  /** 读某个目录下那份 .gitignore 并解析；没有这个文件或读不了时当作没有规则。 */
  readRules(rootPath: string, directoryRelativePath: string): Promise<GitignoreRule[]>
  /** 从规则根到 `directoryRelativePath` 的父目录逐级累积的规则（不含这个目录自己的那份）。 */
  readAncestorRules(rootPath: string, directoryRelativePath: string): Promise<GitignoreRule[]>
  /** 目标以 `/` 分隔；先核对每级祖先仍可达，再按顺序判断目标，反向规则不能越过排除的父目录。 */
  isIgnored(relativePath: string, rules: readonly GitignoreRule[], isDirectory: boolean): boolean
}

export class GitignoreRules implements GitignoreRulesApi {
  /** 只随调用方仍持有的只读规则存活，不让每次遍历留下全局规则历史。 */
  private readonly matchers = new WeakMap<GitignoreRule, ReadonlyArray<(path: string) => boolean>>()

  public parse(content: string, baseRelativePath = ''): GitignoreRule[] {
    const rules: GitignoreRule[] = []
    const base = normalizeGitignorePath(baseRelativePath)

    for (const rawLine of content.split('\n')) {
      let line = trimGitignoreLine(rawLine)
      if (!line || line.startsWith('#')) continue

      let negated = false
      if (line.startsWith('!')) {
        negated = true
        line = line.slice(1)
      }

      // 保留反斜杠到编译时：它是 Git 的转义字符，不是 Windows 路径分隔符。
      const directoryOnly = line.endsWith('/')
      const pattern = directoryOnly ? line.slice(0, -1) : line
      if (!pattern) continue

      const patterns = buildGitignorePatterns(pattern, base)
      if (isEmpty(patterns)) continue
      rules.push(Object.freeze({ negated, directoryOnly, patterns: Object.freeze(patterns) }))
    }

    return rules
  }

  public async readRules(
    rootPath: string,
    directoryRelativePath: string
  ): Promise<GitignoreRule[]> {
    const base = normalizeGitignorePath(directoryRelativePath)
    return this.parse(await readGitignoreContent(rootPath, base), base)
  }

  public async readAncestorRules(
    rootPath: string,
    directoryRelativePath: string
  ): Promise<GitignoreRule[]> {
    const segments = normalizeGitignorePath(directoryRelativePath)
      .split('/')
      .filter((segment) => segment && segment !== '.')
    const rules: GitignoreRule[] = []
    for (let depth = 0; depth < segments.length; depth += 1) {
      rules.push(...(await this.readRules(rootPath, segments.slice(0, depth).join('/'))))
    }
    return rules
  }

  public isIgnored(
    relativePath: string,
    rules: readonly GitignoreRule[],
    isDirectory: boolean
  ): boolean {
    const target = normalizeGitignorePath(relativePath)
    if (!target) return false
    const segments = target.split('/')
    for (let depth = 1; depth < segments.length; depth++)
      if (this.isDirectlyIgnored(segments.slice(0, depth).join('/'), rules, true)) return true
    return this.isDirectlyIgnored(target, rules, isDirectory)
  }

  /** 只判断这一级自己的最终状态；目录继承由调用方逐级处理，匹配器不附加目录前缀语义。 */
  private isDirectlyIgnored(
    target: string,
    rules: readonly GitignoreRule[],
    isDirectory: boolean
  ): boolean {
    let ignored = false
    for (const rule of rules) {
      if (rule.directoryOnly && !isDirectory) continue
      let matchers = this.matchers.get(rule)
      if (!matchers) {
        matchers = rule.patterns.map(compileGitignorePattern)
        this.matchers.set(rule, matchers)
      }
      if (matchers.some((matches) => matches(target))) ignored = !rule.negated
    }
    return ignored
  }
}

/** 整个进程唯一的 .gitignore 判定。 */
export const gitignoreRules: GitignoreRulesApi = new GitignoreRules()
