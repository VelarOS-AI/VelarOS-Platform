/**
 * 跑命令、看和停后台任务、刷新 shell 环境。
 * 只有成片毁掉、找不回来的命令（递归删除目录、清掉未跟踪文件、强推覆盖远端、抹盘格式化这类）每次由用户亲自确认，被拒时一个进程都没起，调用抛错；
 * 判定认全部五种 shell 的语法，换个 shell 写照样问。别的命令直接跑。
 */
declare module 'velaros:shell' {
  /**
   * 跑一条命令，等它跑完交回全部输出。background 或 interactive 的命令立刻返回，之后用 listTasks 看它跑到哪了；interactive 一定跑在后台，它要开着等用户在控制台里输入。
   * 长驻命令不传 background 也会自动转后台，回执里 backgroundProcess.autoStarted 为真。
   * 非空 stderr 或命令失败另附诊断，输出摘录最多 1600 字符，超出保留首尾并标记省略；stderr 是日志，成败以进程状态为准。
   * 程序筛输出时保留 exitCode、signal、timedOut、aborted、truncated 与后台身份；管道的退出码遵循实际 shell，需逐阶段判断时分开 run，依赖阶段在失败或仍运行时停止。
   */
  export function run(input: ShellRunInput): Promise<ShellRunResult>

  /**
   * 重新选定本机能用的 shell 并读一遍它的环境变量；Windows 上还会重读用户与系统环境变量写回本进程。
   * 只改本进程的环境，不动用户的 shell 配置文件，也不装任何东西：刷过一次还缺的命令就是没装。
   */
  export function refreshEnvironment(): Promise<ShellEnvironment>

  /**
   * 列出 run 起在后台的任务，最新的在前，每条带着它到现在的全部输出。
   */
  export function listTasks(input: ShellListTasksInput): Promise<ShellListTasksResult>

  /**
   * 停掉一条后台任务。普通终止停不下来时抛错，再带 force: true 来一次；任务不存在时抛错。
   */
  export function stop(input: ShellStopInput): Promise<ShellStopResult>

  /**
   * 一条命令。cwd 不给就是当前空间的根目录，相对路径相对它；cwd 越出允许范围在执行之前拒绝。
   * cwd 检查仅限制起始工作目录；命令进程的文件与网络权限以宿主约束策略及回执 confinement 为准。
   * shell 只能填本机有的那几个（环境报告里列着），不填用默认的那个，命令照挑定的 shell 的语法写。
   * timeoutMs 是前台命令的执行时限，到期终止进程并返回 timedOut: true；按预计完成时间设置，最多 600000，超了按上限跑。
   * 需要先返回而让命令继续运行时用 background: true，之后按 backgroundProcess.taskId 用 listTasks 查询同一任务。
   */
  interface ShellRunInput {
    command: string
    cwd?: string
    shell?: ShellCommandKind
    timeoutMs?: number
    background?: boolean
    interactive?: boolean
  }

  /**
   * 一条命令的回执。前台 success 要求退出码为 0、没有超时、取消或未完成清理；后台 success 只确认进程启动，此时 exitCode 为 null，不表示任务完成。
   * 有限后台任务用 listTasks 核对 status 为 exited 且 exitCode 为 0，再确认任务成功；命令自己失败是正常回执、不抛错。
   * stdout、stderr 是全部输出，看多少、筛什么在程序里定；只有超过 5000000 字符时才只留末尾，truncated 为真。
   * 命令进了后台时立刻返回，backgroundProcess 是那条后台任务；要了 interactive 却没拿到控制台时，note 说明怎么改成不用输入的写法。
   */
  interface ShellRunResult {
    /** 宿主实际采用的约束；partial 不是无副作用保证。 */
    confinement?: ShellProcessConfinementEvidence
    command: string
    cwd: string
    success: boolean
    exitCode: number | null
    signal: string | null
    timedOut: boolean
    aborted: boolean
    durationMs: number
    stdout: string
    stderr: string
    truncated: boolean
    backgroundProcess?: ShellBackgroundStart
    note?: string
  }

  /**
   * 刷新之后的 shell 环境：shell 是重新选定的默认 shell 的可执行文件路径，shells 是本机可用的全部（按挑选优先顺序，第一个就是默认的）。
   * 刚装上的 shell 在这里就看得到，不必等下一个回合的环境报告；note 说明刷新没完全成功的地方，或者缺了推荐的 shell 该怎么装。
   */
  interface ShellEnvironment {
    shell: string
    shells: ShellInfo[]
    note?: string
  }

  /** 给 taskId 就只查那一条；onlyRunning 为真只列还在跑的。 */
  interface ShellListTasksInput {
    onlyRunning?: boolean
    taskId?: string
  }

  /** 后台任务，最新启动的在前。宿主按会话隔离时只看得到本会话起的那些。 */
  interface ShellListTasksResult {
    tasks: ShellTask[]
  }

  /** 停哪一条后台任务：缺省发普通的终止信号，force 为真直接强杀（普通终止停不下来时再用它）。 */
  interface ShellStopInput {
    taskId: string
    force?: boolean
  }

  /** 停的结果：任务本来就不在跑时 stopped 为 false，note 说明它现在的样子。 */
  interface ShellStopResult {
    taskId: string
    stopped: boolean
    status: ShellBackgroundTaskStatus
    note?: string
  }

  /** 一条命令可以挑的 shell 种类。Windows 按 Git Bash、PowerShell 7、Windows PowerShell、CMD 的顺序挑默认的那个。 */
  type ShellCommandKind = 'git-bash' | 'pwsh' | 'powershell' | 'cmd' | 'posix'

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
   * 命令进了后台：taskId 交给 listTasks 看它跑到哪、输出了什么，交给 stop 停掉。
   * autoStarted 表示不是你要的后台，是按命令判出来自动转的（开发服务器这类长驻命令）；ports 是从命令里认出来的端口。
   */
  interface ShellBackgroundStart {
    taskId: string
    ports: number[]
    autoStarted: boolean
    /** 交互式任务的控制台：命令正在等用户输入，用户在控制台里打字。不是交互式任务时缺席。 */
    console?: ShellConsoleSessionInfo
  }

  /** 一个可用的 shell：ready 为 false 表示只找到了可执行文件，还没通过启动、版本与 UTF-8 自检。 */
  interface ShellInfo {
    kind: ShellCommandKind
    path: string
    version: string | null
    ready: boolean
  }

  /**
   * 一条后台任务：id 就是 run 回执里的 taskId。output 是它到现在的全部输出（超过 5000000 字符只留末尾）；
   * exitCode、signal、finishedAt 在它结束之后才有。
   */
  interface ShellTask {
    id: string
    command: string
    cwd: string
    status: ShellBackgroundTaskStatus
    exitCode?: number | null | undefined
    signal?: string | null | undefined
    ports: number[]
    autoStarted: boolean
    startedAt: number
    finishedAt?: number
    output: string
    /** 交互式任务的控制台；不是交互式任务时缺席。 */
    console?: ShellConsoleSessionInfo
  }

  /** 后台任务状态；进程是否真的还在，拿不准时报 `unknown` 而不是猜。 */
  type ShellBackgroundTaskStatus = 'running' | 'exited' | 'unknown'

  /** 命令在操作系统进程层实际采用的文件副作用边界。 */
  type ShellProcessConfinementMode = 'read-only' | 'workspace-write' | 'danger-full-access'

  /** 约束强度；`partial` 不等于 `full`，别把它当成绝对边界。 */
  type ShellProcessConfinementEnforcement = 'none' | 'partial' | 'full'

  /** 实际承担约束的后端：macOS 是 Seatbelt，Linux 是 bubblewrap，`host` 表示宿主注入的实现。 */
  type ShellProcessConfinementBackend = 'none' | 'bubblewrap' | 'seatbelt' | 'host'

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

  /** 控制台后面接的是什么：真正的终端（宿主提供 PTY，有回显和终端尺寸）还是一根保持打开的 stdin 管道。 */
  type ShellConsoleChannel = 'pty' | 'pipe'
}
