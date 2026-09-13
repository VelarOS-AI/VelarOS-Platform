import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import * as path from 'node:path'

import { isEmpty, isTrue } from '@velaros-ai/core'

import type { ProjectFileAccess } from '../types/file-access.js'
import type { FileListEntry, ObserveInput } from '../types/io.js'
import type { CommandProvider } from '../types/provider.js'
import type { FileFilterInput } from '../types/provider.js'
import {
  type GitignoreRule,
  isGitignored,
  readAncestorGitignoreRules,
  readGitignoreRules,
} from '../utils/gitignore.js'
import { matchesAny } from '../utils/glob.js'
import { normalizeRel } from '../utils/path.js'

interface ListingDependencies {
  readonly root: string
  readonly command: CommandProvider
  readonly authorize: ProjectFileAccess['authorize']
  readonly allowed: (
    path: string,
    action: FileFilterInput['action'],
    options?: { skipFileFilter?: boolean },
  ) => Promise<boolean>
}

/** listFiles 发现阶段通过全部过滤的条目；children 只在该目录被深入时填充。 */
export interface ListingNode {
  readonly entry: FileListEntry
  readonly included: boolean
  readonly children: ListingNode[]
}

/** 待读取的目录：读到的条目挂到 children 下；rules 是从根目录累积到它父目录的 gitignore 规则。 */
export interface ListingDirectory {
  readonly abs: string
  readonly rel: string
  readonly children: ListingNode[]
  readonly rules: readonly GitignoreRule[]
}

/** 一个目录读到的条目，连同判定它们所用的规则（根目录到该目录逐级累积）。 */
export interface ListedDirectory {
  readonly directory: ListingDirectory
  readonly rules: readonly GitignoreRule[]
  readonly entries: ReadonlyArray<{ entry: Dirent; abs: string; rel: string }>
}

export function normalizeFilterList(values: LooseOptional<readonly string[]>): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))]
}

export async function listProjectFiles(
  input: ObserveInput,
  dependencies: ListingDependencies,
): Promise<FileListEntry[]> {
  const out: FileListEntry[] = []
  const max = input.maxFiles ?? 5000
  const recursive = !!input.recursive
  const maxDepth = input.maxDepth ?? (recursive ? 3 : 1)
  const include = normalizeFilterList(input.include)
  const exclude = normalizeFilterList(input.exclude)
  const startPathInput = input.path?.trim()
  const hasExplicitStartPath = !!startPathInput && startPathInput !== '.'
  const startAccess = startPathInput
    ? await dependencies.authorize(startPathInput, 'observe', '列出', { skipFileFilter: true })
    : { abs: dependencies.root, rel: '.' }
  const startDir = startAccess.abs
  const startRel = startAccess.rel || '.'
  let gitCheckIgnoreUnavailable = false

  const gitCheckIgnoredPaths = async (paths: string[]): Promise<Nullable<Set<string>>> => {
    const candidates = [...new Set(paths.map((item) => normalizeRel(item)).filter(Boolean))]
    if (gitCheckIgnoreUnavailable || isEmpty(candidates)) return null

    try {
      // 优先使用 git 自己的 ignore 引擎，它比本地解析更能覆盖边界情况。-z 只有和 --stdin
      // 共用才生效：路径以 NUL 分隔经 stdin 传入，也不受命令行长度限制。
      const result = await dependencies.command.run({
        command: 'git',
        args: ['check-ignore', '--no-index', '--stdin', '-z'],
        cwd: dependencies.root,
        stdin: candidates.join('\0'),
        timeoutMs: 10_000,
      })

      // 退出码 1 表示没有任何路径被忽略，不是失败。
      if (result.exitCode === 1) return new Set()
      if (result.exitCode !== 0) {
        gitCheckIgnoreUnavailable = true
        return null
      }

      return new Set(
        result.stdout
          .split('\0')
          .filter(Boolean)
          .map((item) => normalizeRel(item).replace(/\/$/, '')),
      )
    } catch {
      // arch-guard:silent-catch-ok git check-ignore 不可用时回退到本地 gitignore 解析。
      gitCheckIgnoreUnavailable = true
      return null
    }
  }

  // 一批路径只起一次 git check-ignore；git 不可用时按每条路径所在目录累积的本地规则判定。
  const ignoredAmong = async (
    candidates: ReadonlyArray<{ rel: string; rules: readonly GitignoreRule[] }>,
  ): Promise<Set<string>> => {
    const gitIgnored = await gitCheckIgnoredPaths(candidates.map(({ rel }) => rel))
    return (
      gitIgnored ??
      new Set(candidates.filter(({ rel, rules }) => isGitignored(rel, rules)).map(({ rel }) => rel))
    )
  }

  const requestsGitignoreExclusion = input.excludeGitignored ?? true
  const ancestorGitignoreRules = requestsGitignoreExclusion
    ? await readAncestorGitignoreRules(dependencies.root, startRel)
    : []
  const startIgnored =
    requestsGitignoreExclusion &&
    startRel !== '.' &&
    (await ignoredAmong([{ rel: startRel, rules: ancestorGitignoreRules }])).has(startRel)
  if (startIgnored && isTrue(input.excludeGitignored)) return out
  const excludeGitignored = requestsGitignoreExclusion && !startIgnored

  // 发现：按层读取目录，每层全部条目的忽略判定合成一次 git 调用——逐目录各起一个 git 进程会让
  // 递归列举慢一个数量级。被忽略、被排除或不可见的目录不再深入；已发现的可输出条目够 maxFiles
  // 后不再读下一层，工作量随请求的输出规模收敛。
  const topLevel: ListingNode[] = []
  let level: ListingDirectory[] = [
    { abs: startDir, rel: startRel, children: topLevel, rules: ancestorGitignoreRules },
  ]
  let discovered = 0
  for (let depth = 1; depth <= maxDepth && !isEmpty(level) && discovered < max; depth += 1) {
    const listed: ListedDirectory[] = []
    for (const directory of level) {
      let entries: Dirent[]
      try {
        entries = await readdir(directory.abs, { withFileTypes: true })
      } catch {
        // arch-guard:silent-catch-ok 目录读取失败时跳过该子树，保持 listFiles best-effort。
        continue
      }
      const rules = excludeGitignored
        ? [...directory.rules, ...(await readGitignoreRules(dependencies.root, directory.rel))]
        : []
      listed.push({
        directory,
        rules,
        entries: entries.map((entry) => {
          const abs = path.join(directory.abs, entry.name)
          return { entry, abs, rel: normalizeRel(path.relative(dependencies.root, abs)) }
        }),
      })
    }
    const ignored = excludeGitignored
      ? await ignoredAmong(
          listed.flatMap(({ rules, entries }) => entries.map(({ rel }) => ({ rel, rules }))),
        )
      : new Set<string>()
    const nextLevel: ListingDirectory[] = []
    for (const { directory, rules, entries } of listed) {
      for (const { entry, abs, rel } of entries) {
        if (ignored.has(rel)) continue
        if (!isEmpty(exclude) && matchesAny(rel, exclude)) continue
        const action = entry.isDirectory() ? 'observe' : 'search'
        let outputRel = rel
        if (entry.isSymbolicLink()) {
          const access = await dependencies
            .authorize(rel, action, entry.isDirectory() ? '遍历' : '搜索', {
              skipFileFilter: hasExplicitStartPath,
            })
            .catch(() => null)
          if (!access) continue
          outputRel = access.rel
        } else if (
          !(await dependencies.allowed(rel, action, { skipFileFilter: hasExplicitStartPath }))
        ) {
          continue
        }
        const node: ListingNode = {
          entry: { path: outputRel, type: entry.isDirectory() ? 'directory' : 'file' },
          included: isEmpty(include) || matchesAny(rel, include),
          children: [],
        }
        directory.children.push(node)
        if (node.included) discovered += 1
        if (entry.isDirectory() && recursive && depth < maxDepth) {
          nextLevel.push({ abs, rel, children: node.children, rules })
        }
      }
    }
    level = nextLevel
  }

  // 输出：按深度优先顺序（目录后紧跟其内容）收集命中 include 的条目，满 maxFiles 即止。
  const emit = (nodes: readonly ListingNode[]): void => {
    for (const node of nodes) {
      if (out.length >= max) return
      if (node.included) out.push(node.entry)
      emit(node.children)
    }
  }
  emit(topLevel)
  return out
}
