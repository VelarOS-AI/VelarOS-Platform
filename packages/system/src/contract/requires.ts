/**
 * 注入面：宿主必须或可以塞进来的东西，每个注入点一个接口。本包只从这些口子接收外部能力，别处不留钩子。
 *
 * - 调用上下文 `SystemToolContext`：必须。宿主每次调用操作时给，里面是宿主端口 `SystemToolSystemApi` 与审批端口 `ApprovalPort`。
 * - 本地内核配置 `LocalSystemKernelOptions`：用本地内核时必须，创建时给。
 * - 进程约束后端 `SystemProcessConfinementProvider`：可选，放在本地内核配置里，没有内置约束后端的平台（Windows）靠它。
 * - 环境变量：可选，全部登记在 `contract/system.ts` 的 `SystemEnvironmentVariables`。
 *
 * 这里的每个接口都必须从根入口导出。
 */

import type { ApprovalPort } from '@velaros-ai/agent/tool-contract'
import type { RehearsalSandboxHostPort } from '@velaros-ai/rehearsal-sandbox'
import type { SandboxApplyOptions, SandboxApplyResult, SandboxCreateOptions, SandboxDiff, SandboxDiffOptions, SandboxDiscardResult, SandboxRecord } from '@velaros-ai/rehearsal-sandbox/contracts'

import type { SystemProcessConfinementRequest, SystemProcessConfinementResult } from '../types/commands.js'
import type { SystemBackgroundTaskQueryOptions, SystemBackgroundTaskRecord, SystemCommandResult, SystemProcessConfinementMode, SystemRunCommandOptions, SystemShellEnvironmentRefreshResult } from '../types/system.js'

// ── 工具上下文与宿主端口 ────────────────────────────────────────

/**
 * 每次调用拿到的上下文。
 *
 * 审批通道由宿主注入且始终存在；无人值守宿主应提供默认拒绝端口。
 * 需审批的敏感操作在没有交互执行通道时仍必须拒绝。
 */
export interface SystemToolContext {
  /** 本次调用的取消信号；用户取消或上层超时时触发，工具和宿主都要尽快收手。 */
  abortSignal: AbortSignal
  /** 本次调用所属会话的标识。宿主给了，后台任务与交互式控制台就按会话登记与核对归属，别的会话列不到也停不了；不给就不隔离。 */
  sessionId?: string
  /** 宿主端口：工具经它向宿主要系统能力。 */
  system: SystemToolSystemApi
  /** 审批端口（来自 agent 包）：写敏感路径、跑危险命令前经它向用户确认。 */
  approval: ApprovalPort
}

/**
 * 宿主端口：工具在运行时能向宿主要什么，工具里写作 `ctx.system`。全仓唯一权威。
 *
 * 本包的本地实现是 `LocalSystemKernel`。产品壳（如 Desktop 的 SystemContextTypes）用 `extends` 追加宿主专属能力，
 * 例如通知、安装建议；这些扩展不进通用端口。
 * 端口里只有工具真会调的方法，门禁按工具文件核对；宿主自己的界面要的搜索、进程、端口、终止任务在本地内核的接口上。
 * 演练沙箱那四个方法是公共沙箱端口 `RehearsalSandboxHostPort` 的形状，这里重申是为了写清系统空间自己的约束。
 */
export interface SystemToolSystemApi extends RehearsalSandboxHostPort {
  /**
   * 把用户给的路径解析成绝对路径：`~` 与 `~/…` 展开到宿主的家目录，相对路径相对宿主的默认工作目录；不给路径就返回默认工作目录。
   * 文件工具的路径和 run 的 cwd 都经它解析，审批看到的目标和实际操作的目标因此一致。
   */
  resolvePath: (path?: string) => string
  /** 查询以后台方式启动的命令任务，可按任务 id、会话、过滤词、只看运行中筛选。 */
  listBackgroundTasks: (
    options?: SystemBackgroundTaskQueryOptions
  ) => Promise<SystemBackgroundTaskRecord[]>
  /** 重新选定能用的 shell 并读取它的环境变量，返回刷新后的 shell 描述、刷新后本机可用的 shell 清单和变量个数。 */
  refreshShellEnvironment: () => Promise<SystemShellEnvironmentRefreshResult>
  /**
   * 在系统层运行一条命令：前台等它结束并返回输出；background 为真时登记成后台任务后立即返回。命令自己失败不抛错，如实写进结果；宿主不能或不允许跑后台任务时，就在这里以 PERMISSION 拒绝，不另设能力开关。
   *
   * `options.shell` 挑定用哪个 shell（不给就用宿主自己挑的默认 shell）。宿主必须在挑定的那个里执行：本机没有它就在执行之前以 `VALIDATION` 拒绝、一个进程都不起，
   * 报错里点名本机可用的是哪几个、哪个是默认。不许忽略它换默认 shell 照跑——模型是按挑定的那个 shell 的语法写的命令，换一个跑出来的是错的结果而不是报错。
   *
   * `options.interactive` 为真（一定和 background 一起来）时，任务要能接受用户输入：宿主有 PTY 就用 PTY，
   * 没有就让 stdin 保持打开的管道；启动成功后在回执的 `backgroundProcess.console` 里给出这个控制台，
   * 用户经产品面 `LocalSystemKernelApi` 的三个控制台方法与它打交道。宿主做不到交互式时不报错，只是回执里没有 console。
   */
  runCommand: (
    command: string,
    options?: SystemRunCommandOptions,
    allowDangerous?: boolean,
    abortSignal?: AbortSignal
  ) => Promise<SystemCommandResult>
  /**
   * 建演练沙箱：把 source（缺省默认工作目录）镜像到临时区，返回沙箱记录；之后 cwd 落在镜像根之内的 runCommand 一律受约束、写不到镜像外。
   * 没有约束后端时拒绝（`SYSTEM_PROCESS_CONFINEMENT_UNAVAILABLE`），不留目录。
   */
  createSandbox: (options?: SandboxCreateOptions) => Promise<SandboxRecord>
  /** 镜像相对创建时的变化：新增、修改、删除三列，文本文件附有界的差量，.git 里的变化只汇总成一个布尔。 */
  diffSandbox: (options: SandboxDiffOptions) => Promise<SandboxDiff>
  /** 把镜像里的文件变化落回源目录：先核对源文件自建沙箱以来没变过，冲突整批不落并抛错；.git 永远不落。审批由工具在调用前完成。 */
  applySandbox: (options: SandboxApplyOptions) => Promise<SandboxApplyResult>
  /** 删掉镜像；路径不在沙箱基目录之下就拒绝，沙箱本来就不在时 removed 为 false。 */
  discardSandbox: (sandboxId: string) => Promise<SandboxDiscardResult>
}


// ── 本地内核 ────────────────────────────────────────────────────

/** 创建本地内核时宿主给的配置。 */
export interface LocalSystemKernelOptions {
  /** 工作目录：命令的默认 cwd，相对路径都相对它。 */
  cwd: string
  /** 家目录，`~` 展开到这里；缺省用当前用户的家目录。 */
  homeDir?: string
  /** 按哪个平台跑命令、读系统信息；缺省是当前进程的平台。 */
  platform?: NodeJS.Platform
  /**
   * 同机命令的进程约束策略。缺省保持兼容的 `danger-full-access`，但仍在结果中明确报告
   * `enforcement:none`；受约束模式没有可用后端时会失败关闭。
   */
  processConfinement?: {
    /** 约束模式：只读、只许写工作区，或不约束。 */
    mode: SystemProcessConfinementMode
    /** 工作区根，只许写工作区时的写边界；缺省是 cwd。 */
    workspaceRoot?: string
    /** 宿主额外批准的写根，例如受管日志目录；模型不能直接控制。 */
    writeRoots?: readonly string[]
    /** 为 false 时同时切断网络；缺省只管文件写入。 */
    network?: boolean
    /** 约束后端；平台没有内置后端时靠它，缺了就在受约束模式下失败。 */
    provider?: SystemProcessConfinementProvider
  }
}

/** 进程约束后端：宿主可以注入 Windows restricted-token、容器或更强的同机约束实现。 */
export interface SystemProcessConfinementProvider {
  /** 把一条命令的启动规格包进约束里，返回约束后的启动规格和如实的约束证据；做不到时抛错，不许返回未约束的规格。 */
  confine(request: SystemProcessConfinementRequest): SystemProcessConfinementResult
}
