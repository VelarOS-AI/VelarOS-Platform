/**
 * 可移植数据：经过宿主端口（`ProjectToolApi`、`ProjectSandboxPort`）流动的数据形状，以及宿主实现代码查询要认的查询形状。
 * 不 import 任何东西（只从常量表 import type），不带函数，浏览器和渲染进程都能用；从 `@velaros-ai/project/contracts` 取。
 */

import type { ProjectCodeLanguageActions } from '../contract/constants.js'

// ── 命令 ──────────────────────────────────────────────────────────

/** 缺命令时给用户的一个替代做法：id 与三段中英文案（按钮标签、说明、填进输入框的草稿）。 */
export interface ProjectToolInstallAlternative {
  id: string
  label: {
    'zh-CN': string
    'en-US': string
  }
  description: {
    'zh-CN': string
    'en-US': string
  }
  draft: {
    'zh-CN': string
    'en-US': string
  }
}

/** 命令因为缺工具失败时附带的安装建议：缺的是哪个命令、哪个包、能不能一键安装、由哪次命令触发，以及替代做法。 */
export interface ProjectToolInstallSuggestion {
  id: string
  toolId: string
  label: string
  command: string
  packageName: string
  reason: string
  installCommand: Nullable<string>
  installAvailable: boolean
  detectedAt: number
  triggeredBy: {
    scope: 'project' | 'system'
    command: string
  }
  alternatives?: ProjectToolInstallAlternative[]
}

/** 会话风险确认自动批准了一次项目修改时，给界面显示的一条记录：改的是哪条路径、为什么放行、什么时候。 */
export interface ProjectAutoApprovalNotice {
  id: string
  path: string
  reason: string
  action: 'add' | 'mutation'
  message: string
  approvedAt: number
}

/** 宿主 runCommand 的选项：工作目录、超时、是否后台、输出上限，以及发起命令的会话。 */
export interface ProjectRunCommandOptions {
  cwd?: string
  timeoutMs?: number
  background?: boolean
  maxOutputChars?: number
  sessionId?: string
}

/** 后台命令起来之后宿主报告的进程事实：任务号、进程号、日志、占用端口，以及结束它的命令。 */
export interface ProjectBackgroundProcessInfo {
  taskId: Nullable<string>
  sessionId: Nullable<string>
  pid: Nullable<number>
  logPath: Nullable<string>
  ports: number[]
  reason: Nullable<string>
  terminateCommand: Nullable<string>
  forceTerminateCommand: Nullable<string>
  fallbackTerminateCommand: Nullable<string>
  requested: boolean
  autoStarted: boolean
}

/** 项目宿主报告的输出采集事实，不依赖具体系统执行器。 */
export interface ProjectCommandOutputCapture {
  status: 'complete' | 'truncated' | 'failed'
  encoding: 'utf-8'
  totalBytes: number
  storedBytes: number
  omittedBytes: number
  decodeErrors: number
  error?: string
}

/** 一条命令跑完的结果：退出码与信号、输出、耗时、是否超时或中止、输出是否截断，按命令类型归纳的验证结论，缺工具时的安装建议。 */
export interface ProjectCommandResult {
  command: string
  cwd: string
  exitCode: Nullable<number>
  signal: Nullable<string>
  stdout: string
  stderr: string
  logPath?: LooseOptional<string>
  durationMs: number
  timedOut: boolean
  aborted: boolean
  truncated: boolean
  capture?: ProjectCommandOutputCapture
  cleanupIncomplete?: boolean
  ownership?: { backend: 'windows-job' | 'process-tree'; parentDeathCleanup: boolean; reason: string }
  success: boolean
  backgroundProcess?: LooseOptional<ProjectBackgroundProcessInfo>
  verification: ProjectVerificationSummary
  systemToolSuggestion?: LooseOptional<ProjectToolInstallSuggestion>
}

/** 命令属于哪类验证：构建、代码检查、测试、类型检查，认不出是 unknown。 */
export type ProjectVerificationKind = 'build' | 'lint' | 'test' | 'typecheck' | 'unknown'

/** 验证命令的结论：通过、失败、超时、中止，判断不了是 unknown。 */
export type ProjectVerificationStatus = 'aborted' | 'failed' | 'passed' | 'timed-out' | 'unknown'

/** 按命令类型从输出里归纳的验证结论与问题清单。 */
export interface ProjectVerificationSummary {
  kind: ProjectVerificationKind
  status: ProjectVerificationStatus
  issues: string[]
}

// ── 项目修改授权 ──────────────────────────────────────────────────

/** 项目写操作授权请求；这是全仓唯一权威定义。 */
export interface ProjectMutationAuthorizationInput {
  /** 可选当前工作目录。 */
  cwd?: string
  /** 操作名称，用于生成确认文案。 */
  operation: string
  /** 目标路径；为空时按 cwd 或当前 root 判断。 */
  targetPath?: LooseOptional<string>
  /** 授权通过后是否激活该 root。 */
  activate?: boolean
}

/** 项目变更的授权范围。 */
export type ProjectMutationAuthorizationScope = 'operation' | 'project'

/** 项目变更授权决策结果。 */
export interface ProjectAuthorizationDecision {
  /** 用户/策略是否允许本次操作。 */
  approved: boolean
  /** 本次决策对应的项目 root。 */
  rootPath: string
  /** 是否发生了 active root 切换。 */
  switched: boolean
  /** 目标 root 是否原本就已授权。 */
  alreadyAuthorized: boolean
  /** 拒绝时给工具/模型看的原因。 */
  rejectionMessage: Nullable<string>
  /** 成功或拒绝的可读说明。 */
  message: string
  /** 本次没有立即激活，而是发出了非阻塞提示。 */
  deferred?: boolean
  /** 会话风险确认自动批准触发时的可见 UI 记录。 */
  projectAutoApprovalNotice?: ProjectAutoApprovalNotice
  /** 本次确认是否由会话风险确认策略完成。 */
  autoApproved?: boolean
  /** 授权范围。 */
  authorizationScope?: ProjectMutationAuthorizationScope
}

// ── 演练沙箱（与 @velaros-ai/system 的形状一致，两边互不引用；仓库层有镜像一致性测试） ──

/** 镜像时 gitignore 忽略的目录怎么处理：link 链接到真实目录（能读、写不进），copy 复制过来，skip 不要。忽略的文件一律不复制。 */
export type ProjectSandboxIgnoredMode = 'link' | 'copy' | 'skip'

/** 建沙箱的请求：source 是工具解析好的项目内绝对路径；network 为 false 时镜像里的命令连不上网。 */
export interface ProjectSandboxCreateRequest {
  source: string
  network: boolean
  ignored: ProjectSandboxIgnoredMode
}

/** 一个沙箱：id 就是目录名，root 是镜像根，source 是被镜像的项目目录。 */
export interface ProjectSandboxRecord {
  id: string
  root: string
  source: string
  createdAt: number
  network: boolean
  ignored: ProjectSandboxIgnoredMode
  fileCount: number
  bytes: number
  /** 链接到真实目录的忽略目录（相对路径）。 */
  linkedDirectories: string[]
  /** 源目录是 git 仓库：镜像里的 .git 已把推送地址改掉。 */
  git: boolean
}

/** 在镜像里跑一条命令：宿主把它约束在镜像根之内。 */
export interface ProjectSandboxRunOptions {
  sandboxId: string
  command: string
  timeoutMs?: number
  maxOutputChars?: number
}

/** 看差量的选项：maxFiles 限制新增与修改各列最多列多少条（默认 200），删除列不受限。 */
export interface ProjectSandboxDiffOptions {
  sandboxId: string
  maxFiles?: number
}

/** 一个文本文件的统一差量；超过预算时 truncated 为真、diff 被截断。 */
export interface ProjectSandboxTextDiff {
  path: string
  diff: string
  truncated: boolean
}

/** 镜像相对创建时的变化：三列相对路径（删除列永远完整），文本差量有界；gitChanged 表示 .git 里有东西变了。 */
export interface ProjectSandboxDiff {
  sandboxId: string
  source: string
  created: string[]
  modified: string[]
  deleted: string[]
  truncated: boolean
  gitChanged: boolean
  textDiffs: ProjectSandboxTextDiff[]
  omittedDiffs: number
  note?: string
}

/** 落回项目的选项：paths 只落这些相对路径，不给就全部。 */
export interface ProjectSandboxApplyOptions {
  sandboxId: string
  paths?: string[]
}

/** 落回的结果：三列是真正写进项目的相对路径；skippedGit 表示 .git 里的变化没有落（永远不落）。 */
export interface ProjectSandboxApplyResult {
  sandboxId: string
  created: string[]
  modified: string[]
  deleted: string[]
  skippedGit: boolean
}

/** 丢弃的结果：沙箱本来就不在时 removed 为 false。 */
export interface ProjectSandboxDiscardResult {
  sandboxId: string
  removed: boolean
}

// ── 宿主代码查询（ProjectToolApi.queryCode 收到的查询） ─────────────────
// project:code 的入参由本包翻译成下面的查询交给宿主：语言服务类动作（find_symbols 等七个）由宿主的语言服务执行，
// 其余是代码索引类动作，宿主有代码图谱时执行。缺省值已经填好，数字已经钳在范围之内。

/** 代码查询共用的范围：语言、工作目录、条数上限（1–200）、扩展名（最多 20 个）、目录深度（0–16）。模型的 project:code 入参与宿主收到的语言服务查询共用它。 */
export interface ProjectCodeScope {
  language?: string
  cwd?: string
  limit?: number
  extensions?: string[]
  maxDepth?: number
}

/** 代码索引类查询：按名字搜符号、按任务收集上下文、展开节点、追调用链、看影响面、找环与死代码、路由清单、建索引与看索引状态。 */
export type ProjectCodeIndexQuery =
  | { action: 'search_symbols'; query: string; kind?: string; limit: number }
  | { action: 'build_context'; task: string; maxNodes: number }
  | { action: 'explore'; nodeIds: string[] }
  | { action: 'trace'; fromSymbol: string; toSymbol: string }
  | { action: 'read_node'; nodeId: string }
  | { action: 'callers'; nodeId: string; depth: number }
  | { action: 'callees'; nodeId: string; depth: number }
  | { action: 'impact'; nodeId: string; depth: number }
  | { action: 'type_hierarchy'; nodeId: string }
  | { action: 'file_dependencies'; path: string }
  | { action: 'find_cycles'; maxFiles?: number }
  | { action: 'find_dead_code'; limit: number }
  | { action: 'routing_manifest'; framework?: string }
  | { action: 'build_index'; force: boolean }
  | { action: 'index_status' }

/** 语言服务类查询：找符号、列导出、看一个文件引了谁、看谁引了它、找引用、诊断、符号改动的影响面。 */
export type ProjectCodeLanguageQuery = ProjectCodeScope & (
  | { action: 'find_symbols'; query?: string; path?: string; exportedOnly?: boolean; kinds?: string[]; exact?: boolean }
  | { action: 'list_exports'; path?: string; query?: string; includeReExports?: boolean }
  | { action: 'find_imports'; path?: string; specifier?: string; kind?: string; includeExternal?: boolean }
  | { action: 'find_importers'; targetPath?: string; specifier?: string; path?: string; includeReExports?: boolean }
  | { action: 'find_references'; symbol: string; path?: string; exactWord?: boolean }
  | { action: 'language_diagnostics'; path: string }
  | { action: 'analyze_symbol_impact'; symbol: string; path?: string; declarationPath?: string; kinds?: string[] }
)

/** 语言服务类动作的名字，和常量表 `ProjectCodeLanguageActions` 一一对应。 */
export type ProjectCodeLanguageAction = (typeof ProjectCodeLanguageActions)[number]

/** 宿主 queryCode 收到的一条查询：语言服务类或代码索引类。 */
export type ProjectCodeQuery = ProjectCodeLanguageQuery | ProjectCodeIndexQuery
