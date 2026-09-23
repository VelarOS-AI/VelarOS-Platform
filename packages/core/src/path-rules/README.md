# @velaros-ai/core/path-rules

路径命中规则：glob 匹配、.gitignore 的解析与判定、遍历目录时哪些条目该跳过。给列目录、搜索、做镜像这类要遍历文件树的 Node 宿主与能力包用；它只回答「这条路径命不命中规则」，路径能不能碰由调用方自己判。

## 用法

```ts
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import {
  createIgnorePolicy,
  gitignoreRules,
  pathMatcher,
  type GitCheckIgnoreRunner,
  type IgnorePolicyApi,
} from '@velaros-ai/core/path-rules'
import { DiscoverySkippedDirectoryNames } from '@velaros-ai/core/path-rules/contracts'

// glob：`/` 结尾按目录前缀，不含通配按精确或目录前缀，其余交给 picomatch；缺省区分大小写
pathMatcher.matchesAny('src/api.generated.ts', ['**/*.generated.*']) // true
pathMatcher.matchesAny('.ENV', ['.env'], { caseSensitive: false }) // true

// 一份 .gitignore 正文：最后命中的规则说了算，! 把路径捞回来
const rules = gitignoreRules.parse('*.log\n!keep.log\n')
gitignoreRules.isIgnored('logs/keep.log', rules, false) // false

// 问 git 由宿主起进程（在 rootPath 里跑 git check-ignore --no-index --stdin -z）；git 用不了时返回 null
declare const gitCheckIgnore: GitCheckIgnoreRunner
const skippedNames = new Set(DiscoverySkippedDirectoryNames)

async function walk(directory: string, policy: IgnorePolicyApi, files: string[]): Promise<void> {
  const candidates = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => !(entry.isDirectory() && skippedNames.has(entry.name)))
    .map((entry) => ({ absolutePath: join(directory, entry.name), isDirectory: entry.isDirectory() }))
  // 一批一起判：有 git 执行口时整批只问一次，返回被忽略条目的 absolutePath 原串
  const ignored = await policy.ignoredAmong(candidates)
  for (const candidate of candidates) {
    if (ignored.has(candidate.absolutePath)) continue
    if (candidate.isDirectory) await walk(candidate.absolutePath, policy, files)
    else files.push(candidate.absolutePath)
  }
}

// 一次遍历一份策略：读过的 .gitignore、git 还能不能用都记在它里面
const files: string[] = []
await walk('/work/repo', createIgnorePolicy('/work/repo', { rulesFrom: 'repository', gitCheckIgnore }), files)
```

## 入口

| 入口 | 运行环境 | 内容 |
| --- | --- | --- |
| `@velaros-ai/core/path-rules` | Node | glob 匹配 `pathMatcher`、.gitignore 判定 `gitignoreRules`、遍历忽略策略 `createIgnorePolicy`，问 git 的执行口类型 `GitCheckIgnoreRunner` |
| `@velaros-ai/core/path-rules/contracts` | 任何进程 | 默认跳过的目录名 `DiscoverySkippedDirectoryNames`，规则、匹配选项、遍历条目这些数据 |

## 约定

- 本包不抛自己的错：`.gitignore` 读不了当作没有规则；规则根自己和根外的条目一律不跳，`unrestricted` 什么都不跳，`rulesFrom: 'repository'` 找不到版本库根、或给的根自己被忽略时整次不跳。
- git 执行口返回 `null` 之后这份策略不再问 git，改按本地规则判；执行口自己抛的错、picomatch 对写坏的 pattern 抛的错都原样透出。
- 本地规则只认规则根到父目录的各级 `.gitignore`；`.git/info/exclude`、全局 `core.excludesFile` 只有 git 认得，要完整语义就注入执行口。
- `DiscoverySkippedDirectoryNames` 是按名字一刀切的那层，跟 .gitignore 无关，由遍历方自己套；根内约束、拒读拒写这些归调用方。
