/**
 * 注入面：`velar:shell` 要空间塞进来的东西。本包只从这些口子接收外部能力，别处不留钩子。
 *
 * - 空间端口 `ShellSpacePort`：每个挂 `velar:shell` 的空间给一份——命令在哪儿跑、谁来跑、怎么问用户，都由它说了算。
 * - 调用上下文 `ShellOperationContext`：宿主分发每一次调用时装好。
 *
 * 这里的每个接口都必须从根入口导出。
 */

import type { ApprovalPort } from '@velaros-ai/agent/tool-contract'

import type {
  ShellBackgroundTaskQueryOptions,
  ShellBackgroundTaskRecord,
  ShellCommandResult,
  ShellCommandSpacePolicy,
  ShellEnvironmentRefreshResult,
  ShellRunCommandOptions,
} from '../types/shell-command.js'

/**
 * `velar:shell` 的空间端口：作用域与口径两件事，加上宿主真正跑命令的三件事。
 *
 * **空间之间的差别全落在这里**，模型那边因此只有一套说明：系统空间的 cwd 可以是本机任意目录，
 * 项目空间的钳在项目内、越界就拒绝；确认文案与风险分类也各给各的。执行那三件，本机实现是 `@velaros-ai/system` 的本地内核。
 */
export interface ShellSpacePort {
  /** 把模型给的 cwd 解析成绝对工作目录：不给就是这个空间的根目录；越出这个空间允许的范围时拒绝（`PERMISSION`），不悄悄钳到根上。 */
  resolveCwd: (cwd?: string) => Promise<string>
  /** 这个空间对一条命令的口径：确认文案里「在哪儿执行」、危险命令审批的风险分类。`cwd` 是模型给的原样（可能没给）。 */
  commandPolicy: (cwd?: string) => ShellCommandSpacePolicy
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
}

/** 每次调用 `velar:shell` 时宿主给的上下文。它不是模型能填的入参：宿主分发这次调用时按当前空间装好，生成声明时整个丢掉。 */
export interface ShellOperationContext {
  /** 本次调用的取消信号：用户取消或上层超时时触发，命令也应随之停下。 */
  abortSignal: AbortSignal
  /** 这个空间的端口：作用域、口径、执行都经它，操作类自己不起进程。 */
  shell: ShellSpacePort
  /** 审批端口（来自 agent 包）：要确认的命令经它问用户；无人值守的宿主给默认拒绝的端口。 */
  approval: ApprovalPort
  /** 本次调用所属会话。给了，后台任务就按会话登记与核对归属，别的会话列不到；不给就不隔离。 */
  sessionId?: string
}
