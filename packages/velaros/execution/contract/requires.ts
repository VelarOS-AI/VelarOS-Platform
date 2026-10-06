/** 宿主进程执行、环境与终端所需的注入契约。 */

import type { ShellEnvironmentApi } from '../impl/local/ShellEnvironment.js'
import type {
  ShellProcessConfinementRequest,
  ShellProcessConfinementResult,
} from '../types/local.js'
import type {
  ShellBackgroundTaskQueryOptions,
  ShellBackgroundTaskRecord,
  ShellCommandResult,
  ShellEnvironmentRefreshResult,
  ShellProcessConfinementMode,
  ShellRunCommandOptions,
  ShellTaskTerminateRequest,
  ShellTaskTerminateResult,
} from '../types/shell-command.js'

/** 宿主的命令、只读进程和后台任务端口；本机实现由 createLocalShellHost 创建。 */
export interface ShellHostPort {
  /** 观察命令的受限执行口；不能回退普通 runCommand，返回实际约束证据。 */
  runObservationCommand?: (
    command: string,
    options: ShellRunCommandOptions,
    abortSignal?: AbortSignal
  ) => Promise<ShellCommandResult>
  /**
   * 跑一条命令：前台等它结束并返回输出；background 为真时登记成后台任务后立即返回。命令自己失败不抛错，如实写进结果；
   * 不能或不允许跑后台任务时以 `PERMISSION` 拒绝。`allowDangerous` 为真表示这条命令被判为危险、用户已经亲自确认过，宿主不必再问。
   * `options.shell` 挑定的 shell 本机没有时，在执行之前以 `VALIDATION` 拒绝、一个进程都不起，不许换默认 shell 照跑。
   */
  runCommand: (
    command: string,
    options?: ShellRunCommandOptions & ShellRunCommandHooks,
    allowDangerous?: boolean,
    abortSignal?: AbortSignal
  ) => Promise<ShellCommandResult>
  /** 查询以后台方式启动的命令任务，可按任务 id、会话、过滤词、只看运行中筛选，最新的在前。 */
  listBackgroundTasks: (
    options?: ShellBackgroundTaskQueryOptions
  ) => Promise<ShellBackgroundTaskRecord[]>
  /** 重新选定能用的 shell 并读取它的环境变量，返回刷新后的 shell 描述、本机可用的 shell 清单和变量个数。 */
  refreshShellEnvironment: () => Promise<ShellEnvironmentRefreshResult>
  /**
   * 终止一条后台任务：先核对它存在、属于请求里的会话（不在就抛错），force 为真直接强杀，否则发普通的终止信号；
   * 本来就不在跑时不抛错，`terminated` 为 false。期限内没停下来时抛错，调用方可以再带 force 来一次。
   */
  terminateBackgroundTask: (request: ShellTaskTerminateRequest) => Promise<ShellTaskTerminateResult>
}

/** 跑一条命令时宿主要的回调。入参是可移植数据、放不下函数，回调单独放这里，和入参合在一起传。 */
export interface ShellRunCommandHooks {
  /** 前台命令跑着时每吐出一段输出（stdout、stderr 按到达顺序）就回调一次；后台命令不回调。 */
  onOutput?: (text: string) => void
}

// ── 本机宿主 ────────────────────────────────────────────────────

/** 登录环境的宿主来源和读取预算；状态与读取进程归环境实例持有。 */
export interface ShellEnvironmentOptions {
  /** 每次加载读取一次，缺省为当前进程环境；库不会修改该对象。 */
  env?: () => NodeJS.ProcessEnv
  /** 宿主平台，缺省为当前进程的平台。 */
  platform?: NodeJS.Platform
  /** 每个 POSIX 登录 shell 的读取超时，缺省 10 秒。 */
  captureTimeoutMs?: number
}

/** 创建本机宿主时注入的工作目录、共享环境与进程约束。 */
export interface LocalShellHostOptions {
  /** 借用宿主共享的登录环境；由创建它的宿主负责刷新和关闭。 */
  environment?: ShellEnvironmentApi
  /** 工作目录：命令的默认 cwd，相对路径都相对它。 */
  cwd: string
  /** 家目录，`~` 展开到这里；缺省用当前用户的家目录。 */
  homeDir?: string
  /** 按哪个平台跑命令、读系统信息；缺省是当前进程的平台。 */
  platform?: NodeJS.Platform
  /**
   * 普通命令的进程约束策略。缺省是 `danger-full-access`（不约束），结果里照实报 `enforcement: none`；
   * 受约束模式没有可用后端时失败关闭。演练沙箱里的命令不看这一项，一律钉在镜像根。
   */
  processConfinement?: {
    /** 约束模式：只读、只许写工作区，或不约束。 */
    mode: ShellProcessConfinementMode
    /** 工作区根，只许写工作区时的写边界；缺省是 cwd。 */
    workspaceRoot?: string
    /** 宿主额外批准的写根，例如受管日志目录；模型不能直接控制。 */
    writeRoots?: readonly string[]
    /** 为 false 时同时切断网络；缺省只管文件写入。 */
    network?: boolean
  }
  /** 约束后端；平台没有内置后端（Windows）时靠它，缺了就在受约束模式下、以及建演练沙箱时失败。 */
  confinementProvider?: ShellProcessConfinementProvider
  /** 伪终端工厂；给了，交互式任务就在真终端里跑（控制台报 `pty`），不给用保持打开的输入管道。 */
  terminal?: ShellTerminalFactory
}

/**
 * 伪终端（PTY）工厂：宿主注入。交互式任务在它起的终端里跑，有回显、有终端尺寸，Ctrl+C 经终端送给前台进程，
 * 只读终端的提示（密码、`read -p`）照常出现。本包不带原生依赖，Node 宿主一般用 node-pty 实现它。
 */
export interface ShellTerminalFactory {
  /** 在新的伪终端里起一个进程：参数照原样传，约束包装已经在里面；起不来时抛错。 */
  spawn(file: string, args: string[], options: ShellTerminalSpawnOptions): ShellTerminalProcess
}

/** 起伪终端时给的：目录、环境、初始尺寸、终端类型。 */
export interface ShellTerminalSpawnOptions {
  /** 工作目录，已经解析好的绝对路径。 */
  cwd: string
  /** 进程的环境变量，已经带上 TERM。 */
  env: NodeJS.ProcessEnv
  /** 初始列数；界面量好尺寸后再改。 */
  cols: number
  /** 初始行数。 */
  rows: number
  /** 终端类型名，同 TERM。 */
  name: string
  /** Windows 上参数原样拼进命令行、不再加引号，同 `child_process` 的同名选项。 */
  windowsVerbatimArguments?: boolean
}

/** 伪终端里跑着的进程：工厂返回的那一面，node-pty 的进程对象就长这样。 */
export interface ShellTerminalProcess {
  /** 进程号。 */
  readonly pid: number
  /** 订阅终端输出（已按 UTF-8 解码）；返回的对象用来退订。 */
  onData(listener: (data: string) => void): { dispose(): void }
  /** 订阅进程退出：退出码，被信号杀掉时另给信号编号。 */
  onExit(listener: (event: ShellTerminalExit) => void): { dispose(): void }
  /** 往终端写入，相当于用户按键。 */
  write(data: string): void
  /** 改终端尺寸。 */
  resize(cols: number, rows: number): void
  /** 给进程发信号，缺省 SIGHUP。 */
  kill(signal?: string): void
}

/** 伪终端里的进程退出了：退出码，被信号杀掉时另给信号编号。 */
export interface ShellTerminalExit {
  /** 退出码。 */
  exitCode: number
  /** 杀掉它的信号编号；正常退出时没有或为 0。 */
  signal?: number
}

/** 建受约束执行器时给的配置：演练沙箱给每个镜像根建一个。 */
export interface ConfinedShellRunnerOptions {
  /** 只许写这个目录（演练沙箱的镜像根）；命令的 cwd 也固定在这里。 */
  root: string
  /** 命令自己的临时目录，也许写；TMPDIR、TMP、TEMP 都指到这里。 */
  tempDir: string
  /** 为 false 时切断网络。 */
  network: boolean
  /** 按哪个平台跑；缺省是当前进程的平台。 */
  platform?: NodeJS.Platform
  /** 约束后端；平台没有内置后端（Windows）时靠它，缺了就建不出。 */
  confinementProvider?: ShellProcessConfinementProvider
}

/** 进程约束后端：宿主可以注入 Windows restricted-token、容器或更强的同机约束实现。 */
export interface ShellProcessConfinementProvider {
  /** 把一条命令的启动规格包进约束里，返回约束后的启动规格和如实的约束证据；做不到时抛错，不许返回未约束的规格。 */
  confine(request: ShellProcessConfinementRequest): ShellProcessConfinementResult
}
