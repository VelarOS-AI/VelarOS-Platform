/**
 * 搜索可见性：`GitIgnoreSystemSearchPolicy` 按从仓库根到条目所在目录的各级 .gitignore 判断要不要跳过。接口见 `interface/internal.ts` 的 `SystemSearchIgnorePolicy`。
 * 全局搜索每次遍历按搜索根新建一个；不在仓库里、搜索根本身被忽略、或 unrestricted 时什么都不跳过。
 */

import { stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { isEmpty } from '@velaros-ai/core'

import type { GitIgnoreRule, SystemSearchIgnorePolicyOptions } from '../contract/files.js'
import type { SystemSearchIgnorePolicy } from '../interface/internal.js'
import {
  findSystemSearchRepoRoot,
  isInsidePath,
  matchesGitIgnoreRule,
  readGitIgnoreRulesBetween,
  toPortableRelativePath,
} from '../utils/search.js'

export class GitIgnoreSystemSearchPolicy implements SystemSearchIgnorePolicy {
  private readonly rulesByDirectoryPath = new Map<string, Promise<GitIgnoreRule[]>>()
  private readonly rootPath: string
  private readonly unrestricted: boolean
  private repoRootPath: Nullable<string> = null
  private ready: Optional<Promise<boolean>>

  constructor(rootPath: string, options: SystemSearchIgnorePolicyOptions = {}) {
    this.rootPath = resolve(rootPath)
    this.unrestricted = !!options.unrestricted
  }

  public async shouldSkip(candidatePath: string, isDirectory: boolean): Promise<boolean> {
    if (this.unrestricted) return false
    this.ready ??= this.prepare()
    if (!(await this.ready)) return false
    const resolvedCandidatePath = resolve(candidatePath)
    if (resolvedCandidatePath === this.rootPath) return false
    return this.isIgnored(resolvedCandidatePath, isDirectory)
  }

  /**
   * 第一次判定前准备一次：找到搜索根所在的 git 仓库，并看搜索根本身是否被忽略。
   * 返回 false 表示整次搜索都不按 gitignore 过滤：不在仓库里，或者搜索根本身被忽略（例如直接在 node_modules 里搜）。
   */
  private async prepare(): Promise<boolean> {
    this.repoRootPath = await findSystemSearchRepoRoot(this.rootPath)
    if (!this.repoRootPath) return false
    if (this.rootPath === this.repoRootPath) return true
    const rootStats = await stat(this.rootPath).catch(() => null)
    return !(await this.isIgnored(this.rootPath, !!rootStats?.isDirectory()))
  }

  /** 按从仓库根到条目所在目录的各级规则依次判断，后面的规则覆盖前面的，取反规则可以把条目捞回来。 */
  private async isIgnored(candidatePath: string, isDirectory: boolean): Promise<boolean> {
    const repoRootPath = this.repoRootPath
    if (!repoRootPath || !isInsidePath(candidatePath, repoRootPath)) return false

    const ruleDirectoryPath = isDirectory ? candidatePath : dirname(candidatePath)
    const rules = await this.loadRulesForDirectory(repoRootPath, ruleDirectoryPath)
    if (isEmpty(rules)) return false

    const candidateRelativePath = toPortableRelativePath(repoRootPath, candidatePath)
    let ignored = false
    for (const rule of rules) {
      if (matchesGitIgnoreRule(rule, candidateRelativePath, isDirectory)) {
        ignored = !rule.negative
      }
    }
    return ignored
  }

  /** 取某个目录生效的全部规则：从仓库根到它的各级 .gitignore，每个目录只读一次。 */
  private loadRulesForDirectory(repoRootPath: string, directoryPath: string): Promise<GitIgnoreRule[]> {
    const resolvedDirectoryPath = resolve(directoryPath)
    const existing = this.rulesByDirectoryPath.get(resolvedDirectoryPath)
    if (existing) return existing

    const promise = readGitIgnoreRulesBetween(repoRootPath, resolvedDirectoryPath)
    this.rulesByDirectoryPath.set(resolvedDirectoryPath, promise)
    return promise
  }
}
