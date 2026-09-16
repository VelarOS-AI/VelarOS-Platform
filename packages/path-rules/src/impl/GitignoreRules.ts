/**
 * .gitignore 的解析与判定：`GitignoreRules`。接口 `GitignoreRulesApi` 在本文件的类上方，由 `contract/provides.ts` 登记。
 * 整个进程一份 `gitignoreRules`；它不持状态，读到的规则由调用方自己攒。
 */

import { isEmpty } from '@velaros-ai/core'

import type { GitignoreRule } from '../types/path-rules.js'
import { readGitignoreContent } from '../utils/discovery.js'
import { buildGitignorePatterns, trimGitignoreLine, unescapeGitignoreLine } from '../utils/gitignore.js'
import { ancestorRelativePaths, toComparableRelativePath } from '../utils/path.js'

import type { PathMatcherApi } from './PathMatcher.js'
import { pathMatcher } from './PathMatcher.js'

/**
 * .gitignore 的解析与判定，实例是 `gitignoreRules`：取反（`!`）、锚定（`/` 开头或中间有 `/`）、目录限定（`/` 结尾）、
 * `**`、字符类、转义都认；同一批规则里后面的覆盖前面的。目录被忽略时它下面的一切跟着被忽略。
 *
 * 判定一律区分大小写——git 自己就是这么判的，跟盘区不区分大小写无关。
 */
export interface GitignoreRulesApi {
  /** 解析一份 .gitignore 的正文；`baseRelativePath` 是这份文件所在目录相对规则根的路径（在根上时给空串）。 */
  parse(content: string, baseRelativePath?: string): GitignoreRule[]
  /** 读某个目录下那份 .gitignore 并解析；没有这个文件或读不了时当作没有规则。 */
  readRules(rootPath: string, directoryRelativePath: string): Promise<GitignoreRule[]>
  /** 从规则根到 `directoryRelativePath` 的父目录逐级累积的规则（不含这个目录自己的那份）。 */
  readAncestorRules(rootPath: string, directoryRelativePath: string): Promise<GitignoreRule[]>
  /** 按顺序套用规则判断一条相对路径是否被忽略：最后一条命中的说了算，反向规则命中就不忽略。 */
  isIgnored(relativePath: string, rules: readonly GitignoreRule[], isDirectory: boolean): boolean
}

export class GitignoreRules implements GitignoreRulesApi {
  private readonly matcher: PathMatcherApi

  constructor(matcher: PathMatcherApi) {
    this.matcher = matcher
  }

  public parse(content: string, baseRelativePath = ''): GitignoreRule[] {
    const rules: GitignoreRule[] = []
    const base = toComparableRelativePath(baseRelativePath) === '.' ? '' : toComparableRelativePath(baseRelativePath)

    for (const rawLine of content.split('\n')) {
      let line = trimGitignoreLine(rawLine)
      if (!line || line.startsWith('#')) continue

      let negated = false
      if (line.startsWith('!')) {
        negated = true
        line = line.slice(1)
      }

      // 转义在判完注释与取反之后才还原：`\#foo`、`\!foo` 是字面量，不是注释、也不是反向规则。
      const body = unescapeGitignoreLine(line).replace(/\\/g, '/')
      const directoryOnly = body.endsWith('/')
      const pattern = body.replace(/\/+$/, '')
      if (!pattern) continue

      const patterns = buildGitignorePatterns(pattern, base)
      if (isEmpty(patterns)) continue
      rules.push({ negated, directoryOnly, patterns })
    }

    return rules
  }

  public async readRules(rootPath: string, directoryRelativePath: string): Promise<GitignoreRule[]> {
    const normalized = toComparableRelativePath(directoryRelativePath)
    const base = normalized === '.' ? '' : normalized
    return this.parse(await readGitignoreContent(rootPath, base), base)
  }

  public async readAncestorRules(rootPath: string, directoryRelativePath: string): Promise<GitignoreRule[]> {
    const segments = toComparableRelativePath(directoryRelativePath)
      .split('/')
      .filter((segment) => segment && segment !== '.')
    const rules: GitignoreRule[] = []
    for (let depth = 0; depth < segments.length; depth += 1) {
      rules.push(...(await this.readRules(rootPath, segments.slice(0, depth).join('/'))))
    }
    return rules
  }

  public isIgnored(relativePath: string, rules: readonly GitignoreRule[], isDirectory: boolean): boolean {
    const target = toComparableRelativePath(relativePath)
    if (!target || target === '.') return false
    // 各级上级目录只算一次：「目录被忽略则里面的一切跟着被忽略」要拿它们逐条比。
    const ancestors = ancestorRelativePaths(target)
    let ignored = false

    for (const rule of rules) {
      if (this.matchesRule(rule, target, ancestors, isDirectory)) ignored = !rule.negated
    }

    return ignored
  }

  /** 一条规则是否命中：规则本身命中（目录限定的只认目录），或者某一级上级目录命中——上级被忽略时里面的一切跟着被忽略。 */
  private matchesRule(
    rule: GitignoreRule,
    target: string,
    ancestors: readonly string[],
    isDirectory: boolean,
  ): boolean {
    if ((!rule.directoryOnly || isDirectory) && this.matcher.matchesAny(target, rule.patterns)) return true
    return ancestors.some((ancestor) => this.matcher.matchesAny(ancestor, rule.patterns))
  }
}

/** 整个进程唯一的 .gitignore 判定。 */
export const gitignoreRules: GitignoreRulesApi = new GitignoreRules(pathMatcher)
