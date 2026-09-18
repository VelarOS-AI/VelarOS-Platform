declare module 'velar:shell' {
  /**
   * 跑命令、看后台任务、刷新 shell 环境。
   * 命令先按策略分类：危险命令每次都由用户亲自确认，长驻命令（开发服务器这类）要先问一声；
   * 当前空间还可能要求别的授权（项目空间里会改项目的命令要先过一次）。任何一关被拒时一个进程都没起，调用抛错。
   * 判定认全部五种 shell 的语法，换个 shell 写照样问。
   */

  /**
   * 一条命令。cwd 不给就是当前空间的根目录，相对路径相对它；越出空间允许的范围在执行之前就拒绝。
   * shell 只能填本机有的那几个（环境报告里列着），不填用默认的那个，命令照挑定的 shell 的语法写。
   * timeoutMs 最多 600000，maxOutputChars 最多 50000，超了按上限跑。
   */
  interface ShellRunInput {
    command: string
    cwd?: string
    shell?: ShellCommandKind
    timeoutMs?: number
    background?: boolean
    interactive?: boolean
    maxOutputChars?: number
  }

  /** 要了 interactive 却没拿到控制台时，note 说明怎么把命令改成不用输入的写法。 */
  interface ShellRunResult extends ShellCommandResult {
    note?: string
  }

  /** 刷新之后的 shell 环境：`shell` 是重新选定的那个默认 shell 的可执行文件路径，`runtime` 是它的完整描述。 */
  interface ShellEnvironmentRefreshResult {
    shell: string
    variableCount: number
    refreshedAt: number
    runtime?: ShellDescriptor
    /** 刷新之后本机可用的全部 shell，按挑选优先顺序，第一个就是 `runtime` 那个默认的。刚装上的 shell 在这里就看得到，不必等下一个回合的环境报告。 */
    shells?: ShellDescriptor[]
    /** 这次选定的 shell 环境的版本号；变了说明之前缓存的 shell 选择已作废。 */
    revision?: string
    /** Windows 上重读用户与系统环境变量失败时的原因；成功或不是 Windows 时没有。 */
    reason?: string
  }

  /** 给 taskId 就精确查那一条，limit 不再起作用；不传 limit 默认列 50 条，最多 100 条。 */
  interface ShellListTasksInput {
    limit?: number
    onlyRunning?: boolean
    taskId?: string
  }

  /** 后台任务表：最新启动的在前，count 是这次列出了几条。 */
  interface ShellListTasksResult {
    count: number
    tasks: ShellBackgroundTaskRecord[]
  }

  /** 一条命令可以挑的 shell 种类。Windows 按 Git Bash、PowerShell 7、Windows PowerShell、CMD 的顺序挑默认的那个。 */
  type ShellCommandKind = 'git-bash' | 'pwsh' | 'powershell' | 'cmd' | 'posix'

  /**
   * 一条命令的回执。`success` 只看退出码为 0 且没有超时、没有被取消：命令自己失败是正常回执、不抛错，照 success 判。
   * stdout、stderr 超过 maxOutputChars 时**只留末尾**（失败现场在尾部），truncated 为真；要全量就把输出重定向进文件再读。
   */
  interface ShellCommandResult {
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
    capture?: ShellCommandOutputCapture
    shell?: ShellDescriptor
    cleanupIncomplete?: boolean
    ownership?: ShellProcessOwnership
    success: boolean
    confinement?: ShellProcessConfinementEvidence
    backgroundProcess?: ShellBackgroundProcessInfo
    verification: ShellVerificationSummary
  }

  /** `readiness` 为 `detected` 表示只发现了可执行文件，`ready` 表示已通过启动、版本与 UTF-8 自检。 */
  interface ShellDescriptor {
    kind: ShellCommandKind
    name: string
    shellPath: string
    args: string[]
    readiness: 'detected' | 'ready'
    version: string | null
    recommendation: ShellRecommendation | null
  }

  /**
   * 一条后台任务：`id` 就是 run 返回的 `taskId`。
   * 终止命令三档（普通、强制、兜底）是给 run 直接执行的现成命令。
   */
  interface ShellBackgroundTaskRecord {
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
    status: ShellBackgroundTaskStatus
    /** 这条任务输出的末尾 4000 字符。 */
    recentOutput: string | null
    /** 交互式任务的控制台；不是交互式任务时缺席。 */
    console?: ShellConsoleSessionInfo
  }

  /** 输出捕获的账，各项字节数都按解码后的 UTF-8 文本算。 */
  interface ShellCommandOutputCapture {
    status: 'complete' | 'truncated' | 'failed'
    encoding: 'utf-8'
    totalBytes: number
    storedBytes: number
    omittedBytes: number
    decodeErrors: number
    error?: string
  }

  /** 子进程树由谁负责在父进程退出时清理，以及实际能不能做到。 */
  interface ShellProcessOwnership {
    backend: 'windows-job' | 'process-tree'
    parentDeathCleanup: boolean
    reason: string
  }

  /** 这次进程启动真实生效的约束，不是请求的那个。审批事实与约束事实分开记，谁也不冒充谁。 */
  interface ShellProcessConfinementEvidence {
    mode: ShellProcessConfinementMode
    enforcement: ShellProcessConfinementEnforcement
    backend: ShellProcessConfinementBackend
    reason: string
    /** 受约束模式下真实批准的写根；`danger-full-access` 为空表示不采用 allowlist。 */
    writableRoots: string[]
  }

  /**
   * 命令进了后台时的回执。拿 `taskId` 调 `listTasks` 看它跑到哪了；要停就用 `run` 执行 `terminateCommand`，
   * 不响应再用 `forceTerminateCommand`，最后是 `fallbackTerminateCommand`，别自己拼 pid。
   * `autoStarted` 表示不是你要的后台，是按命令本身判出来自动转的（开发服务器这类长驻命令）。
   */
  interface ShellBackgroundProcessInfo {
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
    /** 交互式任务的控制台：命令正在等用户输入，用户在控制台卡片里打字。不是交互式任务时缺席。 */
    console?: ShellConsoleSessionInfo
  }

  /** 失败、超时、取消时 issues 里是 stdout 与 stderr 的末尾；成功时为空。 */
  interface ShellVerificationSummary {
    kind: 'build' | 'lint' | 'test' | 'typecheck' | 'unknown'
    status: 'aborted' | 'failed' | 'passed' | 'timed-out' | 'unknown'
    issues: string[]
  }

  /** 当前机器缺少推荐的 shell 时给用户的安装建议。 */
  interface ShellRecommendation {
    code: 'INSTALL_GIT_BASH'
    message: string
    url: string
  }

  /** 后台任务状态；进程是否真的还在，拿不准时报 `unknown` 而不是猜。 */
  type ShellBackgroundTaskStatus = 'running' | 'exited' | 'unknown'

  /** 一个交互式任务的控制台。 */
  interface ShellConsoleSessionInfo {
    /** 和 `backgroundProcess.taskId` 是同一个。 */
    taskId: string
    /** 管道下没有回显，只读 tty 的密码提示可能根本不出现。 */
    channel: ShellConsoleChannel
    /** 进程退出后为 false。 */
    acceptsInput: boolean
    /** 一句话说明：任务正在控制台里等用户，别再等这次调用的输出。 */
    note: string
  }

  /** 命令在操作系统进程层实际采用的文件副作用边界。 */
  type ShellProcessConfinementMode =
    | 'read-only'
    | 'workspace-write'
    | 'danger-full-access'

  /** 约束强度；`partial` 不等于 `full`，别把它当成绝对边界。 */
  type ShellProcessConfinementEnforcement = 'none' | 'partial' | 'full'

  /** 实际承担约束的后端：macOS 是 Seatbelt，Linux 是 bubblewrap，`host` 表示宿主注入的实现。 */
  type ShellProcessConfinementBackend =
    | 'none'
    | 'bubblewrap'
    | 'seatbelt'
    | 'host'

  /** 控制台后面接的是什么：真正的终端（宿主提供 PTY，有回显和终端尺寸）还是一根保持打开的 stdin 管道。 */
  type ShellConsoleChannel = 'pty' | 'pipe'

  /**
   * 跑一条命令。background 或 interactive 的命令立刻返回，之后用 listTasks 看它跑到哪了；interactive 一定跑在后台，它要开着等用户在控制台里输入。
   * 长驻命令不传 background 也会自动转后台，回执里 backgroundProcess.autoStarted 为真。
   */
  export function run(input: ShellRunInput): Promise<ShellRunResult>

  /**
   * 重新选定本机能用的 shell 并读一遍它的环境变量；Windows 上还会重读用户与系统环境变量写回本进程，没成功时结果的 reason 说明原因。
   * 只改本进程的环境，不动用户的 shell 配置文件，也不装任何东西：刷过一次还缺的命令就是没装。
   */
  export function refreshEnvironment(): Promise<ShellEnvironmentRefreshResult>

  /**
   * 列出 run 起在后台的任务，最新的在前。宿主按会话隔离时只看得到本会话起的那些。
   * 要停掉一条，用 run 执行它条目里的 terminateCommand 或 forceTerminateCommand，别自己拼 pid。
   */
  export function listTasks(input: ShellListTasksInput): Promise<ShellListTasksResult>
}
