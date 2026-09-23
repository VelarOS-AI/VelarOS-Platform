/**
 * 遍历时的忽略判定：`IgnorePolicy`，由 `createIgnorePolicy` 建。接口 `IgnorePolicyApi` 在本文件的类上方，由 `contract/provides.ts` 登记。
 * 一次遍历一份实例：读过的 .gitignore、git 还能不能用都记在实例里，遍历结束一起丢。
 */

import { dirname, resolve } from 'node:path'

import { isEmpty, isNotNull, isNull } from '@velaros-ai/core'

import type { IgnorePolicyOptions } from '../types/options.js'
import type { GitignoreRule, IgnoreCandidate } from '../types/path-rules.js'
import { findRepositoryRoot } from '../utils/discovery.js'
import { relativeInsideRoot } from '../utils/path.js'

import type { GitignoreRulesApi } from './GitignoreRules.js'
import { gitignoreRules } from './GitignoreRules.js'

/**
 * 遍历时某个条目要不要跳过，实例由 `createIgnorePolicy` 建、一次遍历用一份。
 *
 * 规则根按 `rulesFrom` 定：`root` 就是给的根（工作区遍历用），`repository` 先往上找版本库根（全局搜索用，不在版本库里、或者根自己就被忽略时什么都不跳）。
 * 有注入的 git 执行口就先问 git（它自己的引擎覆盖得最全），问不到再按各级 .gitignore 判；`unrestricted` 时一律不跳。规则根自己永远不跳。
 */
export interface IgnorePolicyApi {
  /** 这个条目是否被忽略、应该跳过。 */
  shouldSkip(absolutePath: string, isDirectory: boolean): Promise<boolean>
  /** 一批条目一起判（问 git 时合成一次调用）；返回其中被忽略的那些条目的 `absolutePath` 原串。 */
  ignoredAmong(entries: readonly IgnoreCandidate[]): Promise<ReadonlySet<string>>
}

export class IgnorePolicy implements IgnorePolicyApi {
  private readonly rootPath: string
  private readonly options: IgnorePolicyOptions
  private readonly rules: GitignoreRulesApi
  /** 规则根：`repository` 时是版本库根，找不到或根自己被忽略时是 null（这一次遍历什么都不跳）。 */
  private rulesRoot: Optional<Promise<Nullable<string>>>
  /** 每个目录累积到它为止的规则，每个目录只读一次。 */
  private readonly rulesByDirectory = new Map<string, Promise<GitignoreRule[]>>()
  /** 问过一次 git 没问成之后就不再问，免得每一层都白起一个进程。 */
  private gitUnavailable = false

  constructor(rootPath: string, options: IgnorePolicyOptions, rules: GitignoreRulesApi) {
    this.rootPath = resolve(rootPath)
    this.options = options
    this.rules = rules
  }

  public async shouldSkip(absolutePath: string, isDirectory: boolean): Promise<boolean> {
    const ignored = await this.ignoredAmong([{ absolutePath, isDirectory }])
    return ignored.has(absolutePath)
  }

  public async ignoredAmong(entries: readonly IgnoreCandidate[]): Promise<ReadonlySet<string>> {
    const ignored = new Set<string>()
    if (this.options.unrestricted || isEmpty(entries)) return ignored
    const rulesRoot = await this.resolveRulesRoot()
    if (isNull(rulesRoot)) return ignored

    // 规则根自己不判；根之外的条目（跟着符号链接走出去的）也不判，规则对它们没有意义。
    const candidates: Array<IgnoreCandidate & { relativePath: string }> = []
    for (const entry of entries) {
      const relativePath = relativeInsideRoot(rulesRoot, entry.absolutePath)
      if (isNull(relativePath) || relativePath === '.') continue
      candidates.push({ ...entry, relativePath })
    }
    if (isEmpty(candidates)) return ignored

    const fromGit = await this.askGit(
      rulesRoot,
      candidates.map(({ relativePath }) => relativePath)
    )
    for (const candidate of candidates) {
      const isIgnored = isNotNull(fromGit)
        ? fromGit.has(candidate.relativePath)
        : this.rules.isIgnored(
            candidate.relativePath,
            await this.rulesFor(rulesRoot, candidate.relativePath),
            candidate.isDirectory
          )
      if (isIgnored) ignored.add(candidate.absolutePath)
    }
    return ignored
  }

  /** 规则根，只算一次：`root` 就是给的根；`repository` 往上找版本库根，不在版本库里、或者根自己被忽略时返回 null。 */
  private resolveRulesRoot(): Promise<Nullable<string>> {
    this.rulesRoot ??= this.discoverRulesRoot()
    return this.rulesRoot
  }

  /** 第一次判定前准备一次：找版本库根，并看给的根自己是不是就被忽略了（例如直接在 node_modules 里搜）。 */
  private async discoverRulesRoot(): Promise<Nullable<string>> {
    if (this.options.rulesFrom !== 'repository') return this.rootPath
    const repositoryRoot = await findRepositoryRoot(this.rootPath)
    if (isNull(repositoryRoot) || repositoryRoot === this.rootPath) return repositoryRoot
    const relativePath = relativeInsideRoot(repositoryRoot, this.rootPath)
    if (isNull(relativePath)) return null
    const ignored = this.rules.isIgnored(
      relativePath,
      await this.rulesFor(repositoryRoot, relativePath),
      true
    )
    return ignored ? null : repositoryRoot
  }

  /** 一条相对路径适用的规则：从规则根到它父目录逐级累积（父目录自己那份 .gitignore 算在内，它自己那份不算）。 */
  private rulesFor(rulesRoot: string, relativePath: string): Promise<GitignoreRule[]> {
    const directory = dirname(relativePath)
    const key = directory === '.' ? '' : directory
    const cached = this.rulesByDirectory.get(key)
    if (cached) return cached

    const loading = this.loadRules(rulesRoot, key)
    this.rulesByDirectory.set(key, loading)
    return loading
  }

  /** 读一个目录累积到它为止的全部规则：先要它各级上级的，再加它自己那份。 */
  private async loadRules(
    rulesRoot: string,
    directoryRelativePath: string
  ): Promise<GitignoreRule[]> {
    const inherited = isEmpty(directoryRelativePath)
      ? []
      : await this.rulesFor(rulesRoot, directoryRelativePath)
    return [...inherited, ...(await this.rules.readRules(rulesRoot, directoryRelativePath))]
  }

  /** 问 git 哪些被忽略；没给执行口、之前问失败过、或者这次没问成都返回 null，由本地规则接手。 */
  private async askGit(
    rulesRoot: string,
    relativePaths: readonly string[]
  ): Promise<Nullable<ReadonlySet<string>>> {
    const runner = this.options.gitCheckIgnore
    if (!runner || this.gitUnavailable) return null
    const answer = await runner(rulesRoot, relativePaths)
    if (isNull(answer)) this.gitUnavailable = true
    return answer
  }
}

/** 建一份遍历用的忽略策略；一次遍历一份，读过的规则随它一起丢。 */
export function createIgnorePolicy(
  rootPath: string,
  options: IgnorePolicyOptions = {}
): IgnorePolicyApi {
  return new IgnorePolicy(rootPath, options, gitignoreRules)
}
