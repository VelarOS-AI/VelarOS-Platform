// 本文件由 scripts/code-surface/generate-declarations.mjs 从能力包源码生成，不要手改。
// 命名空间 system：5 个方法、49 个类型。
// 改源码里带 @modelVisible 的东西就是改模型可观测面，重算用 `bun run generate:code-surface`。

declare const TextEncodings: readonly ['utf8', 'utf8-bom', 'utf16le', 'utf16be', 'utf16le-nobom', 'utf16be-nobom', 'gb18030']

/** 读文本文件的入参：files 里每项一个文件，一个文件就一项，一批就多项；一次调用总共最多返回 20 万字符。 */
type SystemReadInput = {
  files: SystemReadFileInput[]
}

/** 读文本文件的结果：files 与入参的 files 一一对应，每项是读到的内容或这个文件的失败；一次调用的字符预算不够时，被截短的文件 hasMore 为真，预算用完后的文件不读盘、那一项换成失败条目，note 说明从第几个文件起。 */
interface SystemReadResult {
  files: Array<SystemReadFileResult | SystemFileFailure>
  note?: string
}

/** 看图片的入参：files 每项一个文件，一个文件就一项，一批就多项。 */
type SystemViewInput = {
  files: SystemViewFileInput[]
}

/** 看图片的结果：files 与入参的 files 一一对应；modelContent 按同样的顺序放每张图的内容块（整张交给模型，效果和用户上传一样），每块前面一行文字说明是哪个文件，失败的文件没有内容块。 */
interface SystemViewResult {
  files: Array<SystemViewFileResult | SystemFileFailure>
  modelContent: ToolResultModelContentPart[]
}

/** 写文件的入参：files 每项一个文件，一个文件就一项，一批就多项，各自带各自的改法；一批全成或全不成。 */
type SystemEditInput = {
  files: SystemEditFileInput[]
}

/** 写文件的结果：files 与入参的 files 一一对应。一批全成或全不成：任何一处定不下来整个调用报错、什么都不写，问题列在失败回执的 details.problems 里。 */
interface SystemEditResult {
  files: SystemEditFileResult[]
}

/** system:run 的入参：命令、工作目录（不传用宿主给的默认目录）、用哪个 shell（不传用默认的）、超时、是否后台、是否交互式、输出上限，以及只给调度器看的 parallel 与 allowRepeat。 */
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

/** system:run 的结果：带输出窗口说明的命令结果；要了控制台却没拿到时 note 说明怎么改写命令。 */
interface SystemRunResult extends SystemCommandResult {
  note?: string
}

/** system:sandbox 的入参：action 选动作；create 用 source、network、ignored，diff 用 maxFiles，apply 用 paths；除 create 外都要 sandboxId。 */
type SystemSandboxInput = {
  action: 'create' | 'diff' | 'apply' | 'discard'
  source?: string
  network?: boolean
  ignored?: SandboxIgnoredMode
  sandboxId?: string
  paths?: string[]
  maxFiles?: number
}

/** system:sandbox 的结果：create、diff、apply、discard 各自的回执。 */
type SystemSandboxResult = SystemSandboxCreated | SandboxDiff | SystemSandboxApplied | SandboxDiscardResult

/** 读一个文本文件：从第几个字符起、最多多少字符，都可省；给 version 就读改动前留下的那个版本（只有本次运行里 edit 留下的版本在）。 */
interface SystemReadFileInput {
  path: string
  offset?: number
  maxChars?: number
  version?: string
}

/** 一个文件读到的内容：content 是 range 这段的原文，hasMore 时把 range.end 当下一次的 offset 接着读；version 是这份内容的版本号。 */
interface SystemReadFileResult {
  path: string
  version: string
  content: string
  range: SystemTextRange
  totalChars: number
  hasMore: boolean
  encoding: TextEncoding
}

/** 一批里某个文件读不了或看不了：只有它自己失败，其余文件照常返回；全部失败时整个调用报错。path 照传入的原样。 */
interface SystemFileFailure {
  path: string
  error: {
    code: string
    message: string
  }
}

/** 看一张图片。 */
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
 * 改一个文件，三种改法各自一项、只用一种：
 * 只给 newText：把它当整个文件写进去，不存在就新建；给 edits：在 read 读到的范围里改这几处，各处不能重叠；只给 restore：回到改动前留下的那个版本。
 * 一批里所有文件所有改动先一起定下来再一起写，全成或全不成；某处的 oldText 在范围里匹配到多处时整批不写，失败回执里给出是第几处和每处的锚点，把选中锚点的 range 填回那一处就是二次确认。
 * version 是 read 返回的版本号，给了就先核对文件现在还是这个版本，被改过就整批不写并给出当前版本；不给就不核对。
 */
interface SystemEditFileInput {
  path: string
  newText?: string
  edits?: SystemTextEdit[]
  restore?: string
  version?: string
}

/** 一个文件写完的结果。 */
type SystemEditFileResult = SystemEditWrittenResult | SystemEditReplacedResult | SystemEditRestoredResult

/** 实际选中的命令语言。Windows 按 Git Bash、PowerShell 7、Windows PowerShell、CMD 的顺序挑选。 */
type SystemShellKind = 'git-bash' | 'pwsh' | 'powershell' | 'cmd' | 'posix'

/**
 * 一次命令执行的完整结果。
 * `success` 只看退出码为 0 且没有超时、没有被取消。`outputWindow` 一定给出；
 * `outputContinuation` 只在宿主留了会话终端日志（`logPath`）时才有，本地内核不落日志文件，只保留结尾窗口。
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
  /** 缺席仅用于兼容旧宿主；新执行器必须报告真实的进程约束事实。 */
  confinement?: SystemProcessConfinementEvidence
  backgroundProcess?: SystemBackgroundProcessInfo
  verification: SystemVerificationSummary
}

/** 镜像时 gitignore 忽略的目录怎么处理：link 链接到真实目录（能读、写不进），copy 复制过来，skip 不要。忽略的文件一律不复制。 */
type SandboxIgnoredMode = 'link' | 'copy' | 'skip'

/** 建好沙箱的回执：沙箱记录加一句怎么用镜像的提醒。 */
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

/** 落回的回执：真正落回的三列；什么都没落或只落了指定路径时 note 说明。 */
interface SystemSandboxApplied extends SandboxApplyResult {
  note?: string
}

/** 丢弃的结果：沙箱本来就不在时 removed 为 false。 */
interface SandboxDiscardResult {
  sandboxId: string
  removed: boolean
}

/** 文件里的一段字符范围：从 offset 起到 end 止，end 不含。read 返回它，edit 收它。 */
interface SystemTextRange {
  offset: number
  end: number
}

/** 一种磁盘文本编码，取值见常量表 `TextEncodings`。 */
type TextEncoding = (typeof TextEncodings)[number]

/** 一处改动：在 range 这段里改；给 oldText 就只换这段里唯一的那一处，不给就把整段换成 newText，range 是空段就是在那个位置插入。 */
interface SystemTextEdit {
  range: SystemTextRange
  oldText?: string
  newText: string
}

/** 整个文件写入的结果：version 是写完后的版本号，previousVersion 是改动前留下的版本，新建或没留下时为 null；path 是按传入路径解析出的绝对路径，它是符号链接时 target 是真正被写的那个文件。 */
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

/** 改了几处的结果：edits 是改了几处，windows 每处一段新文本前后各 200 字符；盖住所有改动那段（各处 range 的并集）不超过 2 万字符时，content 和 range 整段给出，不用再读一遍确认；超过就只有 windows。 */
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

/** 回滚的结果：文件回到 version 那个版本，回滚前的内容留成 previousVersion，回滚本身也能再回滚。 */
interface SystemEditRestoredResult {
  path: string
  target?: string
  action: 'restored'
  version: string
  previousVersion: string | null
  bytes: number
  totalChars: number
}

/** 命令输出采集事实；字节数按解码后的 UTF-8 文本计算。 */
interface SystemCommandOutputCapture {
  status: 'complete' | 'truncated' | 'failed'
  encoding: 'utf-8'
  totalBytes: number
  storedBytes: number
  omittedBytes: number
  decodeErrors: number
  error?: string
}

/**
 * 生成命令之前就已确定的 shell 描述。可安全地传给浏览器端。
 * `readiness` 为 `detected` 表示只发现了可执行文件，`ready` 表示已通过启动、版本与 UTF-8 自检。
 */
interface SystemShellDescriptor {
  kind: SystemShellKind
  name: string
  shellPath: string
  args: string[]
  readiness: 'detected' | 'ready'
  version: string | null
  recommendation: SystemShellRecommendation | null
}

/** 进程归属事实：子进程树由谁负责在父进程退出时清理，以及实际能不能做到。 */
interface SystemProcessOwnership {
  backend: 'windows-job' | 'process-tree'
  parentDeathCleanup: boolean
  reason: string
}

/** 返回给调用方的输出窗口是怎么截的。 */
interface SystemCommandOutputWindow {
  /** 返回窗口保留完整输出的末尾，而不是开头。 */
  retained: 'tail'
  /** false 表示整体输出更长；不影响已返回末尾窗口的真实性。 */
  complete: boolean
  /** 进程结束后窗口的末端与完整输出末端一致。 */
  endPreserved: true
}

/** 输出被截断时，去哪里找完整内容。 */
interface SystemCommandOutputContinuation {
  /** 完整输出由会话内部终端日志管理，不是普通文件。 */
  kind: 'session-terminal-log'
  /** 交给会话终端输出召回能力的稳定查询词。 */
  query: string
  /** 可直接执行的召回工具，避免把系统命令误交给 job:*。 */
  tool: 'context:recall'
  args: { query: string; kind: 'terminal' }
}

/**
 * 一次真实进程启动的约束证据。
 * 这是事实不是意愿：请求了 `workspace-write` 但没有后端时，实现必须拒绝执行，
 * 而不是在这里写一个 `enforcement: 'none'` 蒙混过去。
 */
interface SystemProcessConfinementEvidence {
  mode: SystemProcessConfinementMode
  enforcement: SystemProcessConfinementEnforcement
  backend: SystemProcessConfinementBackend
  reason: string
  /** 受约束模式下真实批准的写根；`danger-full-access` 为空表示不采用 allowlist。 */
  writableRoots: string[]
}

/**
 * 命令被送进后台管理时的回执。
 * `statusContinuation` 指向 `system:list-tasks`，因为系统后台任务不归内核 `job:*` 工具管。
 */
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
  /** 精确查询该系统后台任务状态；不能交给内核 job:* 工具。 */
  statusContinuation?: {
    tool: 'system:list-tasks'
    args: { taskId: string }
  }
}

/**
 * 对命令结果的一句话判定，给模型当验证摘要用。
 * 成功命令的 stdout / stderr 不会被当作 issue；失败、超时、取消时把输出末尾摘进 issues。
 */
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

/** 一处改动改完后的样子：edit 是 edits 里第几处，content 是新文本前后各带 200 字符的原文，range 是这段在新文件里的位置。 */
interface SystemEditWindow {
  edit: number
  range: SystemTextRange
  content: string
}

/** 当前机器缺少推荐的 shell 时给用户的安装建议。 */
interface SystemShellRecommendation {
  code: 'INSTALL_GIT_BASH'
  message: string
  url: string
}

/** 已批准命令在操作系统进程层实际采用的文件副作用边界。 */
type SystemProcessConfinementMode =
  | 'read-only'
  | 'workspace-write'
  | 'danger-full-access'

/** 约束强度。`partial` 只能作为可观测事实，不能被需要绝对边界的调用方当作 `full`。 */
type SystemProcessConfinementEnforcement = 'none' | 'partial' | 'full'

/** 实际承担约束的后端：macOS 是 Seatbelt，Linux 是 bubblewrap，`host` 表示宿主注入的实现。 */
type SystemProcessConfinementBackend =
  | 'none'
  | 'bubblewrap'
  | 'seatbelt'
  | 'host'

/** 一个交互式任务的控制台。 */
interface SystemConsoleSessionInfo {
  /** 控制台归哪个后台任务，和 `backgroundProcess.taskId` 是同一个。 */
  taskId: string
  /** 后面接的是终端还是管道。管道下没有回显，只读 tty 的密码提示可能根本不出现。 */
  channel: SystemConsoleChannel
  /** 现在还能不能往里写输入；进程退出后为 false。 */
  acceptsInput: boolean
  /** 一句给模型看的说明：任务正在控制台里等用户，不要再等这次工具调用的输出。 */
  note: string
}

/** 控制台后面接的是什么：真正的终端（宿主提供 PTY，有回显和终端尺寸）还是一根保持打开的 stdin 管道。 */
type SystemConsoleChannel = 'pty' | 'pipe'

declare const system: {
/**
   * 读文本文件，files 里每项一个，一个文件就一项，一批最多 20 项；返回与 files 一一对应的 files。
   * 每个文件按字符取一段：从 offset 起最多 maxChars 个（默认也是上限 20 万，尽量一次读完），返回这段的原文、它的 range 和内容的版本号，hasMore 时把 range.end 当下一次的 offset；不切开代理对。
   * 一次调用总共最多返回 20 万字符，按顺序分给各文件；预算用完后的文件不读盘，那一项换成失败条目，结果的 note 说明哪个文件被截短、从第几个起没读。路径是符号链接时读它指向的文件。
   * 给 version 就读改动前留下的那个版本，用来召回旧状态；版本只在本次运行的内存里留最近几份，找不到算这个文件失败。
   * 图片算失败并指向 view，PDF 算失败并说明文档不在这里读；其他二进制文件、目录、设备文件、超过 20 MB 的文件也算失败。
   * 某个文件失败只把它那一项换成失败条目，其余文件照常返回；全部失败时整个调用报错。
   */
  read(input: SystemReadInput): Promise<SystemReadResult>
/**
   * 看图片，files 每项一个，一个文件就一项，一批最多 10 项；返回与 files 一一对应的 files，每张图整张作为模型可见的内容块按同样的顺序放在 modelContent 里交给模型，效果和用户上传一样，每块前面一行文字说明是哪个文件。
   * 只认模型本来就认得的 PNG、JPEG、GIF、WebP，没有字符上限，只有 5 MB 的字节上限，超过算失败让调用方先缩小。
   * PDF 和其他文档不在这里看；文本文件、其他二进制文件、目录、设备文件、超过 20 MB 的文件算失败。某个文件失败只把它那一项换成失败条目，全部失败时整个调用报错。
   */
  view(input: SystemViewInput): Promise<SystemViewResult>
/**
   * 写文件，files 每项一个，一个文件就一项，一批最多 20 项；返回与 files 一一对应的 files。每项三种改法只用一种：
   * 只给 newText：把它当整个文件写进去，不存在就新建（连同上级目录），存在就覆盖。
   * 给 edits：在 read 读到的范围里改这几处（一次最多 50 处），每处在自己的 range 里改：给 oldText 就只换这段里唯一的那一处，不给就把整段换成 newText，空段就是插入。
   * 每项可以带 read 返回的 version：给了就先核对文件现在还是这个版本，被改过就整批不写，问题里给出当前版本。
   * 路径先解开符号链接：判重、审批、写入都按真正的那个文件，链接本身不会被换成普通文件，结果里 target 给出它；只给 newText 时已有的二进制文件拒改。
   * 一批全成或全不成：每个文件先过审批（系统敏感路径、凭证文件，第一次被拒就不再问后面的），再把所有改动在改动前的原文上定下来，写之前再核一次文件没变，最后按顺序写；定不下来或被拒就整批不写，
   * 抛出的错误 cause.details 里列出每个问题（第几个文件、第几处、原因；多处匹配带锚点，重叠标明另一处），context.executionOutcome 是 not-applied，调用方可以只改出问题的那一处再来一次。
   * 匹配只在各自的 range 里做，不在整个文件里找。
   * 只给 restore：把文件回到那个版本；回滚前的内容也留成一个版本，回滚本身能再回滚。
   * 每次改动前把原内容留成一个版本，结果里给出新版本号和改动前的版本号；改了几处的结果还返回每处新文本前后各 200 字符的小段，盖住所有改动那段不超过 2 万字符时整段也给，不用再读一遍确认。
   * edits 里写进去的文本跟着原文的换行风格走（看那一段，那一段没有换行就看整个文件）：CRLF 文件里的裸 LF 换成 CRLF；newText 整个写入原样写。
   * 沿用原编码，写不成原编码的新文本（孤立代理项、GB18030 表示不了的字符）整批不写。路径是管道、设备或套接字，或者文件有多个硬链接（原子替换会让它和其余链接分家）时不碰。写到一半出错原样报错，不标 not-applied，已写的文件在 context.applied 里点名。
   */
  edit(input: SystemEditInput): Promise<SystemEditResult>
/**
   * 跑一条命令：先按命令策略分类（只读、要不要确认、该不该丢后台），交互式命令一定跑在后台，因为它要一直开着等用户在控制台里输入。
   * 分类不看挑的是哪个 shell——判定认全部五种语法，所以挑哪个 shell 都不会让危险命令少弹一次确认；`shell` 原样交给宿主，本机没有它由宿主在执行之前拒绝。
   * 要确认的先问用户；危险命令每次都由用户亲自裁决（高风险、手动审批，宿主在任何档位都弹卡）。
   * 交给宿主执行后补上输出窗口说明；进了后台的补上端口、原因、是否自动转后台和查状态的续接（指向 system:list-tasks）；要了控制台却没拿到时 note 说明怎么改写命令。
   */
  run(input: SystemRunInput): Promise<SystemRunResult>
/**
   * 演练沙箱的四个动作，除 create 外都要 sandboxId：create 建镜像并提醒怎么用；diff 看镜像相对创建时的变化；discard 删镜像。
   * apply 先算完整差量（不截断），paths 里有没变化的路径就在问用户之前拒绝；把删除、覆盖的条数与路径和其中的敏感路径摆给用户确认（高风险、每次都问），
   * 确认了才让宿主落回，并把确认时的差量指纹一起交过去，镜像在确认之后又变过就整批不落；镜像里没有文件变化就什么都不落，只落指定路径时 note 说明。
   */
  sandbox(input: SystemSandboxInput): Promise<SystemSandboxResult>
}
