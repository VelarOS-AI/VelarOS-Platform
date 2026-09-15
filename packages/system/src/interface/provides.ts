/**
 * 产品面：本包交给外面的整件能力，每一件是一个接口。对外入口导出的值，类型只能是这里的接口或上游包的接口。
 * 实现都在 impl/，外面只拿到接口、看不到类；这里的每个接口都必须从根入口导出。
 */

import type { AgentModManifest, ToolCategoryDefinition } from '@velaros-ai/agent/protocol'
import type { ToolPermission } from '@velaros-ai/agent/protocol'
import type { ToolContractRuntimeSpec } from '@velaros-ai/agent/tool-contract'
import type { KernelCallableCapabilityService } from '@velaros-ai/kernel/contracts/abi'

import type { SystemCommandExecutionPlan } from '../contract/commands.js'
import type { SystemBackgroundTaskTerminateRequest, SystemBackgroundTaskTerminateResult, SystemGlobalSearchOptions, SystemGlobalSearchResult, SystemOpenPortInfo, SystemOpenPortQueryOptions, SystemProcessInfo, SystemProcessQueryOptions } from '../contract/system.js'
import type { SystemConsoleControlResult, SystemConsoleInputRequest, SystemConsoleInterruptRequest, SystemConsoleOutputChunk, SystemConsoleOutputRequest } from '../contract/system.js'
import type { SystemModId, SystemToolCategoryId, SystemToolName } from '../contract/system.js'
import type { SystemEnvironmentInspection, SystemMetricsSnapshot, SystemSandboxRecord } from '../contract/system.js'

import type { SystemToolContext, SystemToolSystemApi } from './requires.js'

// ── 工具 ────────────────────────────────────────────────────────

/** 一个系统工具的运行时规格：模型看到的信息面、入参 schema、权限、能力声明和 execute；上下文固定是宿主注入的 `SystemToolContext`。 */
export type VelaTool<TInput extends Record<string, unknown> = Record<string, unknown>> =
  ToolContractRuntimeSpec<TInput, SystemToolContext, unknown, ToolPermission>

/**
 * 系统空间的七个模型面工具，按工具名索引，实例是 `systemTools`。
 * 集合层面不区分各工具的入参类型：宿主拿模型给的入参先用该工具的 schema 严格校验，再调它的 execute。
 */

export type SystemToolCollection = Readonly<Record<SystemToolName, VelaTool<any>>>

/**
 * 系统空间作为官方内置 mod 的定义，由 `createSystemBundledModDefinition()` 创建。
 * 产品壳的 mod 加载器按它把系统空间挂进来：清单声明工具、类别和空间，绑定里是六个工具与两个类别的实物。
 */
export interface SystemBundledModDefinition {
  /** mod 身份，固定是 `velaros.system`。 */
  readonly id: typeof SystemModId
  /** 加载器用的定位串，形如 `bundled:velaros.system`。 */
  readonly specifier: string
  /** 内置 mod 默认启用。 */
  readonly defaultEnabled: true
  /** mod 清单：版本、发布者、需要的能力轴，以及贡献的工具、工具类别和系统空间。 */
  readonly manifest: AgentModManifest
  /** 清单里声明的东西对应的实物。 */
  readonly bindings: {
    /** 七个工具。 */
    readonly tools: SystemToolCollection
    /** 两个工具类别：文件、执行。 */
    readonly toolCategories: Readonly<Record<SystemToolCategoryId, ToolCategoryDefinition>>
  }
}

/**
 * 系统能力服务：本包作为内核模块激活后登记的服务，身份令牌是 `SystemCapability`。
 * 宿主通过内核按工具名调用系统工具；每次调用先用 schema 严格解析入参，再向宿主解析一次上下文。
 */
export interface SystemCapabilityService extends KernelCallableCapabilityService {
  /** 七个工具的只读视图，给只想读工具说明的宿主用。 */
  readonly tools: SystemToolCollection
}

// ── 本地内核 ────────────────────────────────────────────────────

/**
 * 本地内核：宿主端口 `ctx.system` 在本机上的实现，产品壳创建一个交给工具用。
 *
 * 实现是 `LocalSystemKernel`，只做转接：命令与后台任务交给命令执行器，搜索交给全局搜索，
 * 进程、端口、指标跑平台命令读出来。相对路径都相对构造时给的 cwd，`~` 展开到家目录。
 * 宿主端口本身的方法见 `requires.ts` 的 `SystemToolSystemApi`；这里另给产品壳十一个方法：环境检查、指标、释放、沙箱列表，
 * 全局搜索、进程、端口、终止后台任务，以及交互式任务的控制台三件事（写输入、读增量输出、发中断）。
 * 这些方法都没有工具在调（模型改用 `system:run` 跑系统命令，控制台归用户），是宿主自己的界面要的。由 `createLocalSystemKernel(options)` 创建。
 */
export interface LocalSystemKernelApi extends SystemToolSystemApi {
  /** 环境检查：操作系统、经过自检的 shell 和它的 PATH，以及给定的每个命令在不在、在哪。 */
  inspectEnvironment(commands?: string[]): Promise<SystemEnvironmentInspection>
  /** 系统指标快照：CPU、内存、交换区、系统盘、负载各自的用量和告警级别，外加占用最高的 5 个进程；读不到的项为 null。 */
  getSystemMetrics(): Promise<SystemMetricsSnapshot>
  /** 释放：停掉这个内核启动过、还没退出的全部后台进程。 */
  dispose(): Promise<void>
  /** 在一棵目录树里按路径名或文件内容搜索，跳过隐藏项、依赖目录、gitignore 忽略项和受保护目录，最多 limit 条。 */
  globalSearch(options: SystemGlobalSearchOptions, abortSignal?: AbortSignal): Promise<SystemGlobalSearchResult>
  /** 列出本机进程（名称、命令行、用户、CPU、内存），可按 pid、名字、命令行片段、用户、资源占用筛选，最多 limit 条（默认 50）。 */
  listProcesses(options?: SystemProcessQueryOptions): Promise<SystemProcessInfo[]>
  /** 列出正在监听的 TCP 端口和占用它们的进程，可按端口、端口范围、进程筛选，最多 limit 条（默认 50）。 */
  listOpenPorts(options?: SystemOpenPortQueryOptions): Promise<SystemOpenPortInfo[]>
  /** 登记着的演练沙箱，给宿主界面列沙箱、展示差量用。 */
  listSandboxes(): SystemSandboxRecord[]
  /** 终止一个后台任务：核对任务存在、属于请求里的会话、进程确实是自己启动的那个，再发信号并等它退出；返回终止前后的状态。 */
  terminateBackgroundTask(request: SystemBackgroundTaskTerminateRequest): Promise<SystemBackgroundTaskTerminateResult>
  /**
   * 往交互式任务的控制台写一段用户输入，缺省在末尾补一个换行（相当于用户按回车）。
   * 任务不存在、不属于请求里的会话时抛错；进程已经退出或这条任务不是交互式的，不抛错，结果里 `accepted` 为 false 并说明原因。
   */
  writeConsoleInput(request: SystemConsoleInputRequest): Promise<SystemConsoleControlResult>
  /**
   * 读控制台从 `cursor` 起的增量输出，返回新文本和下一次的 cursor；不给 cursor 就从缓冲区里留着的最早一段开始。
   * 缓冲区只留最近的一段，被挤掉的字符数如实写在 `droppedChars` 里，不假装输出是连续的。任务不存在或不属于该会话时抛错。
   */
  readConsoleOutput(request: SystemConsoleOutputRequest): Promise<SystemConsoleOutputChunk>
  /**
   * 给控制台发中断，相当于用户按 Ctrl+C：POSIX 上向整个进程组发 SIGINT，Windows 上退回按进程树终止。
   * 任务不存在、不属于请求里的会话时抛错；进程已经退出时不抛错，结果里 `accepted` 为 false。
   */
  interruptConsole(request: SystemConsoleInterruptRequest): Promise<SystemConsoleControlResult>
}

// ── 命令策略 ────────────────────────────────────────────────────

/**
 * 执行前给 shell 命令分类的判定，实例是 `systemCommandPolicy`。`system:run` 用的就是这一份，宿主做审批界面、无人值守放行时也用它，保证判定一致。
 *
 * 只读判定是白名单加整体否决：命令名不在只读名单、或出现重定向、子 shell、后台符、换行，整条判非只读。
 * 危险判定是黑名单：递归删除、丢弃未提交改动的 Git 操作、mkfs、dd、shutdown、sudo 等；漏判只是少弹一次确认，真正的授权门在宿主的审批端口。
 */
export interface SystemCommandPolicyApi {
  /** 给一条命令做执行前分类：是否只读、是否危险及原因、是否该转入后台及原因、是否要用户确认，以及命令里可能占用的端口。 */
  analyze(command: string): SystemCommandExecutionPlan
  /** 这条命令是否在任何参数组合下都不写东西；判成只读的命令才允许和别的命令并发执行。 */
  isReadOnly(command: string): boolean
}

