import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import * as path from 'node:path'

import { isEmpty, isTrue } from '@velaros-ai/core'
import type { GitCheckIgnoreRunner } from '@velaros-ai/path-rules'
import { createIgnorePolicy } from '@velaros-ai/path-rules'

import { ProjectFileLimits } from '../../contract/constants.js'
import type { CommandProvider } from '../../contract/requires.js'
import type { ListedDirectory, ListingDependencies, ListingDirectory, ListingNode } from '../../types/files.js'
import type { FileListEntry, ObserveInput } from '../../types/io.js'
import { matchesAny } from '../glob.js'
import { normalizeRel } from '../path.js'
import { ProjectTuning } from '../tuning.js'

/** git check-ignore 的 `-z`：传进去的路径与读回来的输出都以 NUL 分隔。 */
const NulSeparator = '\0'

/**
 * 用宿主的命令口批量问 git 哪些相对路径被忽略：git 自己的引擎比本地解析更能覆盖边界情况（父目录被忽略则子项取不回来等）。
 * `-z` 只有和 `--stdin` 共用才生效：路径以 NUL 分隔经 stdin 传入，也不受命令行长度限制。退出码 1 表示一条都没被忽略，不是失败；
 * git 不在、跑不起来、退出码不是 0 或 1 时返回 null，由公共件回退到本地 .gitignore 规则。
 */
function gitCheckIgnoreWith(command: CommandProvider): GitCheckIgnoreRunner {
  return async (root, relativePaths) => {
    const candidates = [...new Set(relativePaths.map((item) => normalizeRel(item)).filter(Boolean))]
    if (isEmpty(candidates)) return new Set()
    try {
      const result = await command.run({
        command: 'git',
        args: ['check-ignore', '--no-index', '--stdin', '-z'],
        cwd: root,
        stdin: candidates.join(NulSeparator),
        timeoutMs: ProjectTuning.files.gitTimeoutMs,
      })
      if (result.exitCode === 1) return new Set()
      if (result.exitCode !== 0) return null
      return new Set(
        result.stdout
          .split(NulSeparator)
          .filter(Boolean)
          .map((item) => normalizeRel(item).replace(/\/$/, '')),
      )
    } catch {
      // arch-guard:silent-catch-ok git check-ignore 不可用时回退到本地 gitignore 解析。
      return null
    }
  }
}

/** 整理 include、exclude 名单：去掉首尾空白、空项和重复。 */
export function normalizeFilterList(values: LooseOptional<readonly string[]>): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))]
}

/**
 * 按路径、include、exclude、深度与条数列出文件和目录：一层层读目录，每层条目的 gitignore 判定合成一次 git check-ignore
 * （git 不可用时按逐级累积的本地 .gitignore 规则判断）；被忽略、被排除或不可见的目录不再深入，输出按深度优先、满 maxFiles 即止。
 */
export async function listProjectFiles(
  input: ObserveInput,
  dependencies: ListingDependencies,
): Promise<FileListEntry[]> {
  const out: FileListEntry[] = []
  const max = input.maxFiles ?? ProjectTuning.files.listMaxFiles
  const recursive = !!input.recursive
  const maxDepth = input.maxDepth ?? (recursive ? ProjectFileLimits.listDepthDefault : 1)
  const include = normalizeFilterList(input.include)
  const exclude = normalizeFilterList(input.exclude)
  const startPathInput = input.path?.trim()
  const hasExplicitStartPath = !!startPathInput && startPathInput !== '.'
  const startAccess = startPathInput
    ? await dependencies.authorize(startPathInput, 'observe', '列出', { skipFileFilter: true })
    : { abs: dependencies.root, rel: '.' }
  const startDir = startAccess.abs
  const startRel = startAccess.rel || '.'
  // 忽略判定交给公共件：一次列举一份策略，读过的 .gitignore 与「git 还能不能用」都记在它里面。
  const ignorePolicy = createIgnorePolicy(dependencies.root, {
    gitCheckIgnore: gitCheckIgnoreWith(dependencies.command),
  })

  const requestsGitignoreExclusion = input.excludeGitignored ?? true
  const startIgnored =
    requestsGitignoreExclusion && startRel !== '.' && (await ignorePolicy.shouldSkip(startDir, true))
  if (startIgnored && isTrue(input.excludeGitignored)) return out
  const excludeGitignored = requestsGitignoreExclusion && !startIgnored

  // 发现：按层读取目录，每层全部条目的忽略判定合成一次 git 调用——逐目录各起一个 git 进程会让
  // 递归列举慢一个数量级。被忽略、被排除或不可见的目录不再深入；已发现的可输出条目够 maxFiles
  // 后不再读下一层，工作量随请求的输出规模收敛。
  const topLevel: ListingNode[] = []
  let level: ListingDirectory[] = [{ abs: startDir, rel: startRel, children: topLevel }]
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
      listed.push({
        directory,
        entries: entries.map((entry) => {
          const abs = path.join(directory.abs, entry.name)
          return { entry, abs, rel: normalizeRel(path.relative(dependencies.root, abs)) }
        }),
      })
    }
    const ignored = excludeGitignored
      ? await ignorePolicy.ignoredAmong(
          listed.flatMap(({ entries }) =>
            entries.map(({ entry, abs }) => ({ absolutePath: abs, isDirectory: entry.isDirectory() })),
          ),
        )
      : new Set<string>()
    const nextLevel: ListingDirectory[] = []
    for (const { directory, entries } of listed) {
      for (const { entry, abs, rel } of entries) {
        if (ignored.has(abs)) continue
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
          nextLevel.push({ abs, rel, children: node.children })
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
