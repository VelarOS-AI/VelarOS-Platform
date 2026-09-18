/**
 * 可移植数据：演练沙箱经过宿主端口流动的数据形状（建、看差量、落回、丢弃），以及按路径筛出来的三列。
 * system 与 project 两个空间、宿主的沙箱实现共用这一份。不 import 任何东西，不带函数，浏览器和渲染进程都能用；从 `@velaros-ai/velar/sandbox/contracts` 取。
 */

/** @AgentView 镜像时 gitignore 忽略的目录怎么处理：link 链接到真实目录（能读、写不进），copy 复制过来，skip 不要。忽略的文件一律不复制。 */
export type SandboxIgnoredMode = 'link' | 'copy' | 'skip'

/** 建沙箱的选项：source 缺省是宿主的默认目录（系统空间是默认工作目录，项目空间是项目根）；network 缺省 false，镜像里的命令连不上网；ignored 缺省 link。 */
export interface SandboxCreateOptions {
  source?: string
  network?: boolean
  ignored?: SandboxIgnoredMode
}

/** @AgentView 一个沙箱：id 就是目录名，root 是镜像根（cwd 落在它之内的命令一律受约束），source 是被镜像的真实目录。 */
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

/** 看差量的选项：三列永远完整；paths 只给这些文件附文本差量（不给就给全部），textDiffs 为 false 时一个都不附（落回前算差量用）。 */
export interface SandboxDiffOptions {
  sandboxId: string
  paths?: string[]
  textDiffs?: boolean
}

/** @AgentView 一个文本文件的统一差量；只有超过 5000000 字符时才截断，truncated 为真。 */
export interface SandboxTextDiff {
  path: string
  diff: string
  truncated: boolean
}

/**
 * @AgentView
 * 镜像相对创建时的变化：三列相对路径永远完整；新增与修改的文本文件附统一差量，omittedDiffs 是没附差量的文件数（二进制、太大、源目录那份也变了没有基线），
 * note 说为什么；gitChanged 表示 .git 里有东西变了。
 */
export interface SandboxDiff {
  sandboxId: string
  source: string
  created: string[]
  modified: string[]
  deleted: string[]
  gitChanged: boolean
  textDiffs: SandboxTextDiff[]
  omittedDiffs: number
  note?: string
  /** 这份差量的指纹：三列的完整路径与镜像里对应文件的印记算出来的摘要；落回时交回来，镜像在这之后又变过就整批不落。 */
  fingerprint?: string
}

/** 落回源目录的选项：paths 只落这些相对路径，不给就全部；fingerprint 是落回前核对的那份差量的指纹，给了就先核对，镜像又变过就整批不落。 */
export interface SandboxApplyOptions {
  sandboxId: string
  paths?: string[]
  fingerprint?: string
}

/** @AgentView 落回的结果：三列是真正写进源目录的相对路径；skippedGit 表示 .git 里的变化没有落（永远不落）。 */
export interface SandboxApplyResult {
  sandboxId: string
  created: string[]
  modified: string[]
  deleted: string[]
  skippedGit: boolean
}

/** @AgentView 丢弃的结果：沙箱本来就不在时 removed 为 false。 */
export interface SandboxDiscardResult {
  sandboxId: string
  removed: boolean
}

// ── 代码面 sandbox 命名空间 ──────────────────────────────────────
// 模型写的入参与它拿到的结果。作用域（source 相对哪个根解析、越界算不算）由宿主端口决定，不在这里，
// 所以这一套形状 system 与 project 共用，模型面只有一份说明。

/** @AgentView 建沙箱：source 相对宿主给的根解析，不给就是那个根；network 不给时镜像里的命令连不上网；ignored 不给按 link。 */
export interface SandboxCreateInput {
  source?: string
  network?: boolean
  ignored?: SandboxIgnoredMode
}

/** @AgentView 在镜像里跑一条命令：工作目录钉在镜像根，写到镜像外会失败；timeoutMs 不给用宿主的缺省，最多 600000，超了按上限跑。 */
export interface SandboxRunInput {
  id: string
  command: string
  timeoutMs?: number
}

/** @AgentView 一条命令跑完的回执：命令自己失败（非零退出、超时）也是正常回执，不抛错；exitCode 为 null 表示进程被信号打断。stdout、stderr 是全部输出，只有超过 5000000 字符时才只留末尾，truncated 为真。 */
export interface SandboxCommandOutcome {
  exitCode: Nullable<number>
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
  truncated: boolean
  success: boolean
}

/** @AgentView 在镜像里跑完一条命令：回执加上是哪个沙箱、跑的哪条命令。 */
export interface SandboxRunResult extends SandboxCommandOutcome {
  id: string
  command: string
}

/** 宿主在镜像里跑一条命令的选项：工作目录由宿主钉在镜像根，命令自己失败写进回执、不抛错。 */
export interface SandboxRunOptions {
  sandboxId: string
  command: string
  timeoutMs?: number
  maxOutputChars?: number
}

/** @AgentView 看差量：paths 只给这些文件附文本差量（相对路径，照三列里的写），不给就给全部。 */
export interface SandboxDiffInput {
  id: string
  paths?: string[]
}

/** @AgentView 把镜像里的变化落回源目录：paths 只落这些相对路径，不给就全部。 */
export interface SandboxApplyInput {
  id: string
  paths?: string[]
}

/** @AgentView 丢弃镜像；沙箱本来就不在也不算错。 */
export interface SandboxDiscardInput {
  id: string
}

/** 按调用方点名的路径筛出来的三列；点名了、三列里都没有的路径放在 unknown。 */
export interface SandboxSelection {
  created: string[]
  modified: string[]
  deleted: string[]
  unknown: string[]
}
