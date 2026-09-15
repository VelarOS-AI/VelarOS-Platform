/**
 * 可移植数据：演练沙箱经过宿主端口流动的数据形状（建、看差量、落回、丢弃），以及按路径筛出来的三列。
 * system 与 project 两个空间、宿主的沙箱实现共用这一份。不 import 任何东西，不带函数，浏览器和渲染进程都能用；从 `@velaros-ai/rehearsal-sandbox/contracts` 取。
 */

/** 镜像时 gitignore 忽略的目录怎么处理：link 链接到真实目录（能读、写不进），copy 复制过来，skip 不要。忽略的文件一律不复制。 */
export type SandboxIgnoredMode = 'link' | 'copy' | 'skip'

/** 建沙箱的选项：source 缺省是宿主的默认目录（系统空间是默认工作目录，项目空间是项目根）；network 缺省 false，镜像里的命令连不上网；ignored 缺省 link。 */
export interface SandboxCreateOptions {
  source?: string
  network?: boolean
  ignored?: SandboxIgnoredMode
}

/** 一个沙箱：id 就是目录名，root 是镜像根（cwd 落在它之内的命令一律受约束），source 是被镜像的真实目录。 */
export interface SandboxRecord {
  id: string
  root: string
  source: string
  createdAt: number
  network: boolean
  ignored: SandboxIgnoredMode
  fileCount: number
  bytes: number
  /** 链接到真实目录的忽略目录（相对路径）。 */
  linkedDirectories: string[]
  /** 源目录是 git 仓库：镜像里的 .git 已把推送地址改掉（嵌套仓库、子模块的也改）。 */
  git: boolean
  /** 没放进镜像的 `.git` 链接文件（相对路径）：它们指向源目录外的真实仓库（git worktree、单独镜像的子模块），放进来镜像里的 git 会直接读写那个仓库。 */
  detachedGitLinks?: string[]
}

/** 看差量的选项：maxFiles 限制新增与修改各列最多列多少条，删除列不受限；textDiffs 为 false 时不附文本差量（落回前算完整差量用）。 */
export interface SandboxDiffOptions {
  sandboxId: string
  maxFiles?: number
  textDiffs?: boolean
}

/** 一个文本文件的统一差量；超过预算时 truncated 为真、diff 被截断。 */
export interface SandboxTextDiff {
  path: string
  diff: string
  truncated: boolean
}

/** 镜像相对创建时的变化：三列相对路径（删除列永远完整，truncated 说明另外两列被截），文本差量有界，omittedDiffs 是没附差量的文件数；gitChanged 表示 .git 里有东西变了。 */
export interface SandboxDiff {
  sandboxId: string
  source: string
  created: string[]
  modified: string[]
  deleted: string[]
  truncated: boolean
  gitChanged: boolean
  textDiffs: SandboxTextDiff[]
  omittedDiffs: number
  note?: string
  /** 这份差量的指纹：三列的完整路径与镜像里对应文件的印记算出来的摘要，不受 maxFiles 截断影响；落回时交回来，镜像在确认之后又变过就整批不落。 */
  fingerprint?: string
}

/** 落回源目录的选项：paths 只落这些相对路径，不给就全部；fingerprint 是确认时看到的差量指纹，给了就先核对，镜像又变过就整批不落。 */
export interface SandboxApplyOptions {
  sandboxId: string
  paths?: string[]
  fingerprint?: string
}

/** 落回的结果：三列是真正写进源目录的相对路径；skippedGit 表示 .git 里的变化没有落（永远不落）。 */
export interface SandboxApplyResult {
  sandboxId: string
  created: string[]
  modified: string[]
  deleted: string[]
  skippedGit: boolean
}

/** 丢弃的结果：沙箱本来就不在时 removed 为 false。 */
export interface SandboxDiscardResult {
  sandboxId: string
  removed: boolean
}

/** 按调用方点名的路径筛出来的三列；点名了、三列里都没有的路径放在 unknown。 */
export interface SandboxSelection {
  created: string[]
  modified: string[]
  deleted: string[]
  unknown: string[]
}
