// 本文件由 scripts/code-surface/generate-declarations.mjs 从能力包源码生成，不要手改。
// 命名空间 system：7 个方法、54 个类型。
// 改源码里带 @AgentView 的东西就是改模型可观测面，重算用 `bun run generate:code-surface`。

declare const TextEncodings: readonly ['utf8', 'utf8-bom', 'utf16le', 'utf16be', 'utf16le-nobom', 'utf16be-nobom', 'gb18030']

/** 一批最多 20 项；一次调用总共最多返回 20 万字符，按顺序分给各文件。 */
type SystemReadInput = {
  files: SystemReadFileInput[]
}

/** files 与入参的 files 一一对应。字符预算用完之后的文件根本没读，那一项是失败条目；note 说明哪个文件被截短、从第几个起没读。 */
interface SystemReadResult {
  files: Array<SystemReadFileResult | SystemFileFailure>
  note?: string
}

/** 一批最多 10 张。 */
type SystemViewInput = {
  files: SystemViewFileInput[]
}

/** files 与入参的 files 一一对应；modelContent 按同样的顺序放每张图，每块前面一行文字说明是哪个文件，失败的文件没有内容块。 */
interface SystemViewResult {
  files: Array<SystemViewFileResult | SystemFileFailure>
  modelContent: ToolResultModelContentPart[]
}

/** 一批最多 20 项，全成或全不成。 */
type SystemEditInput = {
  files: SystemEditFileInput[]
}

/**
 * files 与入参的 files 一一对应。
 * 任何一处定不下来就整个报错、一个文件都不写，错误的 cause.details.problems 逐条给出是第几个文件第几处、为什么；
 * 某处 oldText 在范围里匹配到多处时带出每处的锚点，把选中那处的 range 填回去再发一次就是二次确认。
 */
interface SystemEditResult {
  files: SystemEditFileResult[]
}

/**
 * 不传 cwd 用宿主给的默认目录，不传 shell 用环境报告里的默认 shell。
 * parallel 与 allowRepeat 不改变命令本身，只是给调度器的提示：这条只读、可以和别的命令同时跑；这次是故意再跑一遍完全一样的命令。
 */
type SystemRunInput = {
  command: string
  cwd?: string
  shell?: SystemShellKind
  timeoutMs?: number
  background?: boolean
  interactive?: boolean
  maxOutputChars?: number
  parallel?: boolean
  allowRepeat?: boolean
}

/** 要了 interactive 却没拿到控制台时，note 说明怎么把命令改成不用输入的写法。 */
interface SystemRunResult extends SystemCommandResult {
  note?: string
}

/** create 用 source、network、ignored，diff 用 maxFiles，apply 用 paths；除 create 外都要 sandboxId。不传 source 就镜像默认工作目录。 */
type SystemSandboxInput = {
  action: 'create' | 'diff' | 'apply' | 'discard'
  source?: string
  network?: boolean
  ignored?: SandboxIgnoredMode
  sandboxId?: string
  paths?: string[]
  maxFiles?: number
}

/** create、diff、apply、discard 各自的回执，按 action 决定是哪一种。 */
type SystemSandboxResult = SystemSandboxCreated | SandboxDiff | SystemSandboxApplied | SandboxDiscardResult

/** 刷新之后的 shell 环境：`shell` 是重新选定的那个默认 shell 的可执行文件路径，`runtime` 是它的完整描述。 */
interface SystemShellEnvironmentRefreshResult {
  shell: string
  variableCount: number
  refreshedAt: number
  runtime?: SystemShellDescriptor
  /** 刷新之后本机可用的全部 shell，按挑选优先顺序，第一个就是 `runtime` 那个默认的。刚装上的 shell 在这里就看得到，不必等下一个回合的环境报告。 */
  shells?: SystemShellDescriptor[]
  /** 这次选定的 shell 环境的版本号；变了说明之前缓存的 shell 选择已作废。 */
  revision?: string
  /** Windows 上重读用户与系统环境变量失败时的原因；成功或不是 Windows 时没有。 */
  reason?: string
}

/** 给 taskId 就精确查那一条，limit 不再起作用；不传 limit 默认列 50 条。 */
type SystemListTasksInput = {
  limit?: number
  onlyRunning?: boolean
  taskId?: string
}

/** 后台任务表：最新启动的在前，count 是这次列出了几条。 */
type SystemListTasksResult = {
  count: number
  tasks: SystemBackgroundTaskRecord[]
}

/** 给 version 就读改动前留下的那个版本；只有本次运行里 edit 留下的几份还在，找不到算这个文件失败。 */
interface SystemReadFileInput {
  path: string
  offset?: number
  maxChars?: number
  version?: string
}

/** content 是 range 这段的原文；hasMore 时把 range.end 当下一次的 offset 接着读。version 是这份内容的版本号，read 与 edit 都收它。 */
interface SystemReadFileResult {
  path: string
  version: string
  content: string
  range: SystemTextRange
  totalChars: number
  hasMore: boolean
  encoding: TextEncoding
}

/** 一批里某个文件读不了或看不了：只有它这一项是失败，其余文件照常返回；全部失败时整个调用才报错。path 照传入的原样。 */
interface SystemFileFailure {
  path: string
  error: {
    code: string
    message: string
  }
}

/** 一张图片。 */
interface SystemViewFileInput {
  path: string
}

/** 看到的一张图片的元数据。 */
interface SystemViewFileResult {
  path: string
  mediaType: string
  bytes: number
}

/**
 * Provider-neutral content blocks that a tool result can expose directly to the next model turn.
 * Binary data is base64 encoded and kept outside the ordinary textual result so serialization and
 * context compaction never turn media bytes into JSON text.
 */
type ToolResultModelContentPart =
  | { type: 'text'; text: string }
  | { type: 'image-data'; data: string; mediaType: string }
  | { type: 'file-data'; data: string; mediaType: string; filename?: string }

/**
 * 三种改法只用一种：newText 当整个文件写进去，不存在就连同上级目录新建，已有的二进制文件拒改；
 * edits 在 read 读到的范围里改几处，一次最多 50 处、各处不能重叠；restore 回到改动前留下的那个版本。
 * version 是 read 返回的版本号，给了就先核对文件现在还是这个版本，被改过就整批不写并给出当前版本；不给就不核对。
 */
interface SystemEditFileInput {
  path: string
  newText?: string
  edits?: SystemTextEdit[]
  restore?: string
  version?: string
}

/** 一个文件写完的结果，按 action 分辨是哪一种。 */
type SystemEditFileResult = SystemEditWrittenResult | SystemEditReplacedResult | SystemEditRestoredResult

/** 实际选中的命令语言。Windows 按 Git Bash、PowerShell 7、Windows PowerShell、CMD 的顺序挑选。 */
type SystemShellKind = 'git-bash' | 'pwsh' | 'powershell' | 'cmd' | 'posix'

/**
 * `success` 只看退出码为 0 且没有超时、没有被取消——命令自己失败不算这次调用失败。
 * `outputWindow` 一定给出；`outputContinuation` 只在宿主留了会话终端日志（`logPath`）时才有。
 */
interface SystemCommandResult {
  command: string
  cwd: string
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  logPath?: string
  durationMs: number
  timedOut: boolean
  aborted: boolean
  truncated: boolean
  capture?: SystemCommandOutputCapture
  shell?: SystemShellDescriptor
  cleanupIncomplete?: boolean
  ownership?: SystemProcessOwnership
  outputWindow?: SystemCommandOutputWindow
  outputContinuation?: SystemCommandOutputContinuation
  success: boolean
  confinement?: SystemProcessConfinementEvidence
  backgroundProcess?: SystemBackgroundProcessInfo
  verification: SystemVerificationSummary
}

/** 镜像时 gitignore 忽略的目录怎么处理：link 链接到真实目录（能读、写不进），copy 复制过来，skip 不要。忽略的文件一律不复制。 */
type SandboxIgnoredMode = 'link' | 'copy' | 'skip'

/** 建好的沙箱；note 是一句怎么用这个镜像的提醒。 */
interface SystemSandboxCreated extends SandboxRecord {
  note: string
}

/** 镜像相对创建时的变化：三列相对路径（删除列永远完整，truncated 说明另外两列被截），文本差量有界，omittedDiffs 是没附差量的文件数；gitChanged 表示 .git 里有东西变了。 */
interface SandboxDiff {
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

/** 真正落回源目录的三列；什么都没落或只落了指定路径时 note 说明。 */
interface SystemSandboxApplied extends SandboxApplyResult {
  note?: string
}

/** 丢弃的结果：沙箱本来就不在时 removed 为 false。 */
interface SandboxDiscardResult {
  sandboxId: string
  removed: boolean
}

/** `readiness` 为 `detected` 表示只发现了可执行文件，`ready` 表示已通过启动、版本与 UTF-8 自检。 */
interface SystemShellDescriptor {
  kind: SystemShellKind
  name: string
  shellPath: string
  args: string[]
  readiness: 'detected' | 'ready'
  version: string | null
  recommendation: SystemShellRecommendation | null
}

/**
 * 一条后台任务：`id` 就是 run 返回的 `taskId`。
 * 终止命令三档（普通、强制、兜底）是给 run 直接执行的现成命令。
 */
interface SystemBackgroundTaskRecord {
  exitCode?: number | null | undefined
  signal?: string | null | undefined
  finishedAt?: number
  cleanupIncomplete?: boolean
  id: string
  runId: string
  sessionId: string | null
  command: string
  cwd: string
  pid: number
  logPath: string | null
  ports: number[]
  reason: string | null
  terminateCommand: string | null
  forceTerminateCommand: string | null
  fallbackTerminateCommand: string | null
  requested: boolean
  autoStarted: boolean
  startedAt: number
  updatedAt: number
  status: SystemBackgroundTaskStatus
  /** 这条任务输出的末尾 4000 字符。 */
  recentOutput: string | null
  /** 交互式任务的控制台；不是交互式任务时缺席。 */
  console?: SystemConsoleSessionInfo
}

/** 文件里的一段字符范围，end 不含。read 返回它，edit 原样收回去。 */
interface SystemTextRange {
  offset: number
  end: number
}

/** 一种磁盘文本编码，取值见常量表 `TextEncodings`。 */
type TextEncoding = (typeof TextEncodings)[number]

/** 只在 range 这段里改，不在整个文件里找：给 oldText 就只换这段里唯一的那一处，不给就把整段换成 newText，range 是空段就是在那个位置插入。 */
interface SystemTextEdit {
  range: SystemTextRange
  oldText?: string
  newText: string
}

/** previousVersion 是改动前留下的版本，新建或没留下时为 null；path 是解析后的绝对路径，它是符号链接时 target 是真正被写的那个文件。 */
interface SystemEditWrittenResult {
  path: string
  target?: string
  action: 'written'
  created: boolean
  version: string
  previousVersion: string | null
  bytes: number
  totalChars: number
}

/** windows 每处给一段新文本前后各 200 字符；盖住所有改动那段（各处 range 的并集）不超过 2 万字符时，content 和 range 把整段给出，不用再读一遍确认。 */
interface SystemEditReplacedResult {
  path: string
  target?: string
  action: 'replaced'
  edits: number
  version: string
  previousVersion: string | null
  bytes: number
  totalChars: number
  windows: SystemEditWindow[]
  content?: string
  range?: SystemTextRange
}

/** 文件回到 version 那个版本；回滚前的内容留成 previousVersion，回滚本身也能再回滚。 */
interface SystemEditRestoredResult {
  path: string
  target?: string
  action: 'restored'
  version: string
  previousVersion: string | null
  bytes: number
  totalChars: number
}

/** 各项字节数都按解码后的 UTF-8 文本算。 */
interface SystemCommandOutputCapture {
  status: 'complete' | 'truncated' | 'failed'
  encoding: 'utf-8'
  totalBytes: number
  storedBytes: number
  omittedBytes: number
  decodeErrors: number
  error?: string
}

/** 子进程树由谁负责在父进程退出时清理，以及实际能不能做到。 */
interface SystemProcessOwnership {
  backend: 'windows-job' | 'process-tree'
  parentDeathCleanup: boolean
  reason: string
}

/** 输出窗口留的是完整输出的末尾，不是开头。 */
interface SystemCommandOutputWindow {
  retained: 'tail'
  /** false 表示完整输出更长；不影响已返回的这段末尾的真实性。 */
  complete: boolean
  /** 进程结束后窗口的末端就是完整输出的末端。 */
  endPreserved: true
}

/** 输出被截断时去哪里找完整内容：它在会话的终端日志里，不是一个能直接读的文件。 */
interface SystemCommandOutputContinuation {
  kind: 'session-terminal-log'
  query: string
  tool: 'context:recall'
  args: { query: string; kind: 'terminal' }
}

/** 这次进程启动真实生效的约束，不是请求的那个。 */
interface SystemProcessConfinementEvidence {
  mode: SystemProcessConfinementMode
  enforcement: SystemProcessConfinementEnforcement
  backend: SystemProcessConfinementBackend
  reason: string
  /** 受约束模式下真实批准的写根；`danger-full-access` 为空表示不采用 allowlist。 */
  writableRoots: string[]
}

/** 命令进了后台时的回执；`autoStarted` 表示不是调用方要的后台，是按命令本身判出来自动转的。 */
interface SystemBackgroundProcessInfo {
  taskId: string | null
  sessionId: string | null
  pid: number | null
  logPath: string | null
  ports: number[]
  reason: string | null
  terminateCommand: string | null
  forceTerminateCommand: string | null
  fallbackTerminateCommand: string | null
  requested: boolean
  autoStarted: boolean
  /** 交互式任务的控制台：命令正在等用户输入，用户在聊天里的控制台卡片里打字。不是交互式任务时缺席。 */
  console?: SystemConsoleSessionInfo
  /** 把这个 taskId 交给 listTasks 就查得到这条任务的状态。 */
  statusContinuation?: {
    tool: 'system:list-tasks'
    args: { taskId: string }
  }
}

/** 成功命令的 stdout / stderr 不会被当作 issue；失败、超时、取消时把输出末尾摘进 issues。 */
interface SystemVerificationSummary {
  kind: 'build' | 'lint' | 'test' | 'typecheck' | 'unknown'
  status: 'aborted' | 'failed' | 'passed' | 'timed-out' | 'unknown'
  issues: string[]
}

/** 一个沙箱：id 就是目录名，root 是镜像根（cwd 落在它之内的命令一律受约束），source 是被镜像的真实目录。 */
interface SandboxRecord {
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

/** 一个文本文件的统一差量；超过预算时 truncated 为真、diff 被截断。 */
interface SandboxTextDiff {
  path: string
  diff: string
  truncated: boolean
}

/** 落回的结果：三列是真正写进源目录的相对路径；skippedGit 表示 .git 里的变化没有落（永远不落）。 */
interface SandboxApplyResult {
  sandboxId: string
  created: string[]
  modified: string[]
  deleted: string[]
  skippedGit: boolean
}

/** 当前机器缺少推荐的 shell 时给用户的安装建议。 */
interface SystemShellRecommendation {
  code: 'INSTALL_GIT_BASH'
  message: string
  url: string
}

/** 后台任务状态；进程是否真的还在，拿不准时报 `unknown` 而不是猜。 */
type SystemBackgroundTaskStatus = 'running' | 'exited' | 'unknown'

/** 一个交互式任务的控制台。 */
interface SystemConsoleSessionInfo {
  /** 和 `backgroundProcess.taskId` 是同一个。 */
  taskId: string
  /** 管道下没有回显，只读 tty 的密码提示可能根本不出现。 */
  channel: SystemConsoleChannel
  /** 进程退出后为 false。 */
  acceptsInput: boolean
  /** 一句话说明：任务正在控制台里等用户，别再等这次调用的输出。 */
  note: string
}

/** edit 是 edits 里第几处；content 是新文本前后各带 200 字符，range 是这段在新文件里的位置。 */
interface SystemEditWindow {
  edit: number
  range: SystemTextRange
  content: string
}

/** 命令在操作系统进程层实际采用的文件副作用边界。 */
type SystemProcessConfinementMode =
  | 'read-only'
  | 'workspace-write'
  | 'danger-full-access'

/** 约束强度；`partial` 不等于 `full`，别把它当成绝对边界。 */
type SystemProcessConfinementEnforcement = 'none' | 'partial' | 'full'

/** 实际承担约束的后端：macOS 是 Seatbelt，Linux 是 bubblewrap，`host` 表示宿主注入的实现。 */
type SystemProcessConfinementBackend =
  | 'none'
  | 'bubblewrap'
  | 'seatbelt'
  | 'host'

/** 控制台后面接的是什么：真正的终端（宿主提供 PTY，有回显和终端尺寸）还是一根保持打开的 stdin 管道。 */
type SystemConsoleChannel = 'pty' | 'pipe'

declare const system: {
/**
   * 读文本文件。每个文件从 offset 起最多 maxChars 个字符，两个都不传就一次读到上限；不切开代理对。路径是符号链接时读它指向的文件。
   * 读私钥、云凭证这类文件会先问用户。
   * 图片要改用 view；PDF 与其他文档、其他二进制文件、目录、设备文件、超过 20 MB 的文件，都算这个文件失败。
   */
  read(input: SystemReadInput): Promise<SystemReadResult>
/**
   * 看图片：整张图交给模型，效果和用户上传一样。
   * 只认 PNG、JPEG、GIF、WebP，单张最大 5 MB；PDF 与其他文档、文本文件、其他二进制文件、目录、设备文件、超过 20 MB 的文件，都算这个文件失败。
   */
  view(input: SystemViewInput): Promise<SystemViewResult>
/**
   * 写文件。写系统敏感路径与凭证文件会先问用户，被拒也是整批不写；等用户确认那段时间里文件被别人改过，同样整批不写。
   * 路径先解开符号链接：判重、审批、写入都按它指向的那个文件，链接本身不会被换成普通文件。路径是管道、设备、套接字，或文件有多个硬链接时不碰。
   * 沿用原文件的编码；edits 写进去的文本跟着原文的换行风格走（CRLF 文件里的裸 LF 换成 CRLF），newText 整个写入原样写。新文本编不成原编码（孤立代理项、GB18030 表示不了的字符）就整批不写。
   * 写的过程中出错时前面的文件已经落盘，错误的 context.applied 里点名是哪几个，这时不能整批重发。
   */
  edit(input: SystemEditInput): Promise<SystemEditResult>
/**
   * 跑一条命令。background 或 interactive 的命令立刻返回，之后用 listTasks 看它跑到哪了；interactive 一定跑在后台，它要开着等用户在控制台里输入。
   * 要确认的命令先问过用户才跑；危险命令每次都由用户亲自裁决。换个 shell 写也照样问——判定认全部五种 shell 的语法。
   * shell 只能填本机有的那几个，填了没有的在执行之前就被拒，一个进程都不起。
   */
  run(input: SystemRunInput): Promise<SystemRunResult>
/**
   * 演练沙箱的四个动作，除 create 外都要 sandboxId。镜像里的命令写不到镜像外，apply 之前源目录一个字节都没变。
   * apply 每次都要用户亲自确认，确认之后镜像又变过就整批不落；paths 里有没变化的路径，问用户之前就先拒绝。
   */
  sandbox(input: SystemSandboxInput): Promise<SystemSandboxResult>
/**
   * 重新选定本机能用的 shell 并读一遍它的环境变量；Windows 上还会重读用户与系统环境变量写回本进程，没成功时结果的 reason 说明原因。
   * 只改本进程的环境，不动用户的 shell 配置文件，也不装任何东西：刷过一次还缺的命令就是没装。
   */
  refreshEnvironment(): Promise<SystemShellEnvironmentRefreshResult>
/**
   * 列出 run 起在后台的任务，最新的在前。宿主按会话隔离时只看得到本会话起的那些。
   * 要停掉一条，用 run 执行它条目里的 terminateCommand 或 forceTerminateCommand，别自己拼 pid。
   */
  listTasks(input: SystemListTasksInput): Promise<SystemListTasksResult>
}
