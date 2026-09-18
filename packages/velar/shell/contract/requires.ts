/**
 * 注入面：`velar:shell` 要空间塞进来的东西，以及本机宿主（`./local` 入口）要宿主给的东西。本单元只从这些口子接收外部能力，别处不留钩子。
 *
 * - 空间端口 `ShellSpacePort`：每个挂 `velar:shell` 的空间给一份——命令在哪儿跑、谁来跑、怎么问用户，都由它说了算。
 *   真正跑命令、管后台任务的那四件单独叫 `ShellHostPort`，本机实现是 `createLocalShellHost`。
 * - 调用上下文 `ShellOperationContext`：宿主分发每一次调用时装好。
 * - 本机宿主配置 `LocalShellHostOptions` 与受约束执行器配置 `ConfinedShellRunnerOptions`：用到哪个时必须给；
 *   进程约束后端 `ShellProcessConfinementProvider` 可选，放在两份配置里。
 * - 环境变量：可选，全部登记在 `contract/constants.ts` 的 `ShellEnvironmentVariables`。
 *
 * 根入口导出空间端口与调用上下文；本机宿主的配置与约束后端从 `./local` 入口导出。
 */

import type { ApprovalPort } from '@velaros-ai/agent/tool-contract'

import type { ShellProcessConfinementRequest, ShellProcessConfinementResult } from '../types/local.js'
import type {
  ShellBackgroundTaskQueryOptions,
  ShellBackgroundTaskRecord,
  ShellCommandResult,
  ShellCommandSpacePolicy,
  ShellEnvironmentRefreshResult,
  ShellProcessConfinementMode,
  ShellRunCommandOptions,
  ShellTaskTerminateRequest,
  ShellTaskTerminateResult,
} from '../types/shell-command.js'

/**
 * 宿主真正跑命令、管后台任务的四件事：`ShellSpacePort` 的执行那一半。空间给 `velar:shell` 装端口时把它原样接上，
 * 自己只补作用域与口径。本机实现是 `createLocalShellHost`（`./local` 入口），项目空间在它外面再套一层项目资源门。
 */
export interface ShellHostPort {
  /**
   * 跑一条命令：前台等它结束并返回输出；background 为真时登记成后台任务后立即返回。命令自己失败不抛错，如实写进结果；
   * 不能或不允许跑后台任务时以 `PERMISSION` 拒绝。`allowDangerous` 为真表示这条命令被判为危险、用户已经亲自确认过，宿主不必再问。
   * `options.shell` 挑定的 shell 本机没有时，在执行之前以 `VALIDATION` 拒绝、一个进程都不起，不许换默认 shell 照跑。
   */
  runCommand: (
    command: string,
    options?: ShellRunCommandOptions,
    allowDangerous?: boolean,
    abortSignal?: AbortSignal
  ) => Promise<ShellCommandResult>
  /** 查询以后台方式启动的命令任务，可按任务 id、会话、过滤词、只看运行中筛选，最新的在前。 */
  listBackgroundTasks: (options?: ShellBackgroundTaskQueryOptions) => Promise<ShellBackgroundTaskRecord[]>
  /** 重新选定能用的 shell 并读取它的环境变量，返回刷新后的 shell 描述、本机可用的 shell 清单和变量个数。 */
  refreshShellEnvironment: () => Promise<ShellEnvironmentRefreshResult>
  /**
   * 终止一条后台任务：先核对它存在、属于请求里的会话（不在就抛错），force 为真直接强杀，否则发普通的终止信号；
   * 本来就不在跑时不抛错，`terminated` 为 false。期限内没停下来时抛错，调用方可以再带 force 来一次。
   */
  terminateBackgroundTask: (request: ShellTaskTerminateRequest) => Promise<ShellTaskTerminateResult>
}

/**
 * `velar:shell` 的空间端口：作用域与口径两件事，加上宿主真正跑命令、管后台任务的四件事（`ShellHostPort`）。
 *
 * **空间之间的差别全落在这里**，模型那边因此只有一套说明：系统空间的 cwd 可以是本机任意目录，
 * 项目空间的钳在项目内、越界就拒绝；确认文案与风险分类也各给各的。
 */
export interface ShellSpacePort extends ShellHostPort {
  /** 把模型给的 cwd 解析成绝对工作目录：不给就是这个空间的根目录；越出这个空间允许的范围时拒绝（`PERMISSION`），不悄悄钳到根上。 */
  resolveCwd: (cwd?: string) => Promise<string>
  /** 这个空间对一条命令的口径：确认文案里「在哪儿执行」、危险命令审批的风险分类。`cwd` 是模型给的原样（可能没给）。 */
  commandPolicy: (cwd?: string) => ShellCommandSpacePolicy
}

/** 每次调用 `velar:shell` 时宿主给的上下文。它不是模型能填的入参：宿主分发这次调用时按当前空间装好，生成声明时整个丢掉。 */
export interface ShellOperationContext {
  /** 本次调用的取消信号：用户取消或上层超时时触发，命令也应随之停下。 */
  abortSignal: AbortSignal
  /** 这个空间的端口：作用域、口径、执行都经它，操作类自己不起进程。 */
  shell: ShellSpacePort
  /** 审批端口（来自 agent 包）：危险命令经它问用户；无人值守的宿主给默认拒绝的端口。 */
  approval: ApprovalPort
  /** 本次调用所属会话。给了，后台任务就按会话登记与核对归属，别的会话列不到；不给就不隔离。 */
  sessionId?: string
}

// ── 本机宿主 ────────────────────────────────────────────────────

/** 创建本机宿主时宿主给的配置。 */
export interface LocalShellHostOptions {
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
