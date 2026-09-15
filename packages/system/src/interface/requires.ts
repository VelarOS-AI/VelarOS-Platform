/**
 * 注入面：宿主必须或可以塞进来的东西，每个注入点一个接口。本包只从这些口子接收外部能力，别处不留钩子。
 *
 * - 工具上下文 `SystemToolContext`：必须。宿主每次调工具时给，里面是宿主端口 `SystemToolSystemApi` 与审批端口 `ApprovalPort`。
 * - 上下文解析器 `SystemToolContextResolver`：挂进内核且要按名调用工具时必须，放在 `CreateSystemKernelModuleOptions` 里给。
 * - 本地内核配置 `LocalSystemKernelOptions`：用本地内核时必须，创建时给。
 * - 进程约束后端 `SystemProcessConfinementProvider`：可选，放在本地内核配置里，没有内置约束后端的平台（Windows）靠它。
 * - 环境变量：可选，全部登记在 `contract/system.ts` 的 `SystemEnvironmentVariables`。
 *
 * 这里的每个接口都必须从根入口导出。
 */

import type { ApprovalPort } from '@velaros-ai/agent/tool-contract'
import type { ScopeRef } from '@velaros-ai/kernel/contracts/abi'

import type { SystemProcessConfinementRequest, SystemProcessConfinementResult } from '../contract/commands.js'
import type { SystemBackgroundTaskQueryOptions, SystemBackgroundTaskRecord, SystemCommandResult, SystemProcessConfinementMode, SystemRunCommandOptions, SystemShellEnvironmentRefreshResult } from '../contract/system.js'

// ── 工具上下文与宿主端口 ────────────────────────────────────────

/**
 * 每次工具调用拿到的上下文。
 *
 * 审批通道由宿主注入且始终存在；无人值守宿主应提供默认拒绝端口。
 * 需审批的敏感操作在没有交互执行通道时仍必须拒绝。
 */
export interface SystemToolContext {
  /** 本次调用的取消信号；用户取消或上层超时时触发，工具和宿主都要尽快收手。 */
  abortSignal: AbortSignal
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
 */
export interface SystemToolSystemApi {
  /** 解析本次命令实际使用的工作目录，审批和执行共用同一个值；不提供时由 runCommand 自己解析。 */
  resolveCommandCwd?: (cwd?: string) => string
  /** 查询以后台方式启动的命令任务，可按任务 id、会话、过滤词、只看运行中筛选。 */
  listBackgroundTasks: (
    options?: SystemBackgroundTaskQueryOptions
  ) => Promise<SystemBackgroundTaskRecord[]>
  /** 重新选定能用的 shell 并读取它的环境变量，返回刷新后的 shell 描述和变量个数。 */
  refreshShellEnvironment: () => Promise<SystemShellEnvironmentRefreshResult>
  /** 在系统层运行一条命令：前台等它结束并返回输出；background 为真时登记成后台任务后立即返回。命令自己失败不抛错，如实写进结果。 */
  runCommand: (
    command: string,
    options?: SystemRunCommandOptions,
    allowDangerous?: boolean,
    abortSignal?: AbortSignal
  ) => Promise<SystemCommandResult>
  /** 当前宿主是否支持刷新 shell 环境。 */
  canRefreshShellEnvironment: () => boolean
  /** 当前宿主是否支持启动后台命令。 */
  canStartBackgroundCommands: () => boolean
}

// ── 挂进内核 ────────────────────────────────────────────────────

/** 按作用域给出一次工具调用的上下文；内核每次按名调用系统工具前调用一次。 */
export type SystemToolContextResolver = (
  scope: LooseOptional<ScopeRef>,
  signal: AbortSignal,
) => SystemToolContext | Promise<SystemToolContext>

/** 把本包挂进内核时宿主给的选项。 */
export interface CreateSystemKernelModuleOptions {
  /** 产品壳提供按作用域绑定的系统上下文；不提供时内核模块只登记工具，不能被调用。 */
  resolveContext?: SystemToolContextResolver
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
