/**
 * 可移植数据：经过宿主端口（`ProjectToolApi`、`ProjectSandboxPort`）流动的数据形状，以及宿主实现代码查询要认的查询形状。
 * 不 import 任何东西（只从常量表 import type），不带函数，浏览器和渲染进程都能用；从 `@velaros-ai/project/contracts` 取。
 */

import type { ProjectCodeLanguageActions } from '../contract/constants.js'

// ── 命令 ──────────────────────────────────────────────────────────

/**
 * 用哪个 shell 跑一条命令。可移植文件只许从本包常量表 import，所以这里是 `@velaros-ai/shell-command` 的 `ShellCommandKind` 的同形副本；
 * 两边的形状由 `project:run` 的 schema 与入参类型在编译期对上，谁改一边没同步另一边，typecheck 立刻红。
 */
export type ProjectShellKind = 'git-bash' | 'pwsh' | 'powershell' | 'cmd' | 'posix'

/**
 * 宿主 runCommand 的选项：工作目录（相对项目根，工具已核对过在项目之内）、用哪个 shell、超时、是否后台、输出上限。
 *
 * `shell` 不给就用宿主自己挑的默认 shell。宿主必须在挑定的那个里执行：本机没有它就在执行之前拒绝（报错里点名可用的有哪些、哪个是默认），
 * 不许忽略它换默认 shell 照跑——模型是按挑定的那个 shell 的语法写的命令，换一个跑出来的是错的结果而不是报错。
 */
export interface ProjectRunCommandOptions {
  cwd?: string
  shell?: ProjectShellKind
  timeoutMs?: number
  background?: boolean
  maxOutputChars?: number
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

/** 一条命令跑完的结果：退出码与信号、输出、耗时、是否超时或中止、输出是否截断，以及按命令类型归纳的验证结论。 */
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

/** 项目写操作的授权请求：做什么、在哪个目录、会写哪些文件（相对项目根）。这是全仓唯一权威定义。 */
export interface ProjectMutationAuthorizationInput {
  /** 给用户看的操作名，如「编辑项目源码」。 */
  operation: string
  /** project:run 的工作目录（相对项目根，工具已核对过在项目之内）；文件改动不带。 */
  cwd?: string
  /** 这次会写入的文件（相对项目根）：文件改动在规划之后、提交之前填，命令不填。 */
  paths?: string[]
}

/** 一条路径的写治理判定：不许写时 reason 是合同错误原因（PERMISSION_DENIED、SCOPE_VIOLATION、PROTECTED_FILE、GENERATED_FILE）。 */
export interface ProjectWriteAuthorization {
  /** 判定的是哪条路径，原样回给调用方。 */
  path: string
  /** 项目允不允许写这条路径。 */
  allowed: boolean
  /** 不许写时的原因码。 */
  reason?: string
  /** 不许写时给模型看的说明。 */
  message?: string
}

/** 项目变更授权的决定：批不批准，以及给模型看的说明（被拒时就是拒绝原因）。宿主自己的实现可以多返回字段，结构上兼容。 */
export interface ProjectAuthorizationDecision {
  /** 用户或策略允不允许这次写操作。 */
  approved: boolean
  /** 给模型看的说明：批准时是放行理由，被拒时是拒绝原因，工具原样交给模型。 */
  message: string
}

// ── 改动回执（模型与界面共用的那几个字段） ───────────────────────────

/**
 * project:edit 的 apply 成功后的回执里，宿主界面可以依赖的字段：模型凭 changeRef 查看或撤销，
 * 界面按 changedFiles 与前后版本画改动摘要。回执里另有只给模型看的字段（files、diff、diffLines、notes、recode），
 * 它们跟着说明与上下文预算走，不进这份合同。
 */
export interface ProjectChangeReceipt {
  /** 凭它 inspect、undo；模型只用这个。 */
  changeRef: string
  /** 事务号，给界面当这次改动的标识。 */
  transactionId: string
  /** 真有改动时为 true；已是目标格式的 recode 这类没写任何字节的为 false。 */
  changed: boolean
  /** 改动涉及的文件，相对项目根。 */
  changedFiles: string[]
  /** 提交前每个文件的版本；这次新建的文件不在里面，界面据此认出新建。 */
  oldRevisions: Record<string, string>
  /** 提交后每个文件的版本；删掉的文件记为 'deleted'。 */
  newRevisions: Record<string, string>
}

// ── 演练沙箱（数据形状在 @velaros-ai/rehearsal-sandbox，这里只有项目空间独有的镜像里跑命令） ──

/** 在镜像里跑一条命令：宿主把它约束在镜像根之内。`shell` 与 `ProjectRunCommandOptions.shell` 同义、同一套规矩。 */
export interface ProjectSandboxRunOptions {
  sandboxId: string
  command: string
  shell?: ProjectShellKind
  timeoutMs?: number
  maxOutputChars?: number
}

// ── 宿主代码查询（ProjectToolApi.queryCode 收到的查询） ─────────────────
// project:code 的入参由本包翻译成下面的查询交给宿主：语言服务类动作（find_symbols 等七个）由宿主的语言服务执行，
// 其余是代码索引类动作，宿主有代码图谱时执行。缺省值已经填好，数字已经钳在范围之内。

/** 代码查询共用的范围：语言、条数上限（1–200）、扩展名（最多 20 个）、目录深度（0–16）。模型的 project:code 入参与宿主收到的语言服务查询共用它；路径一律相对项目根。 */
export interface ProjectCodeScope {
  language?: string
  limit?: number
  extensions?: string[]
  maxDepth?: number
}

/** 代码索引类查询：按名字搜符号、展开节点、追调用链、看影响面、找环与死代码、路由清单。索引本身的生命周期归宿主，本包不发这类查询。 */
export type ProjectCodeIndexQuery =
  | { action: 'search_symbols'; query: string; kind?: string; limit: number }
  | { action: 'explore'; nodeIds: string[] }
  | { action: 'trace'; fromSymbol: string; toSymbol: string }
  | { action: 'callers'; nodeId: string; depth: number }
  | { action: 'callees'; nodeId: string; depth: number }
  | { action: 'impact'; nodeId: string; depth: number }
  | { action: 'type_hierarchy'; nodeId: string }
  | { action: 'file_dependencies'; path: string }
  | { action: 'find_cycles'; maxFiles?: number }
  | { action: 'find_dead_code'; limit: number }
  | { action: 'routing_manifest'; framework?: string }

/** 语言服务类查询：找符号、列导出、看一个文件引了谁、看谁引了它、找引用、诊断、符号改动的影响面。 */
export type ProjectCodeLanguageQuery = ProjectCodeScope & (
  | { action: 'find_symbols'; query?: string; path?: string; kinds?: string[]; exact?: boolean }
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
