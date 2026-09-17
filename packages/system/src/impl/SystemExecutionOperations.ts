/**
 * 四个执行操作：`SystemExecutionOperations` 与整个进程唯一的 `systemExecutionOperations`。接口 `SystemExecutionOperationsApi` 在本文件的类上方。
 * `run`、`sandbox`、`refreshEnvironment`、`listTasks` 各调一个方法，它们的执行前分类、向用户确认和结果整形写在这里。
 * 刷新环境、列后台任务只调一次宿主端口，收在这里不是因为实现多，是因为不在操作接口上就进不了代码面。
 * 真正跑命令、建镜像的是宿主端口 `ctx.system`（本机就是本地内核）。
 */


import type { RehearsalSandboxRulesApi } from '@velaros-ai/rehearsal-sandbox'
import { rehearsalSandboxRules } from '@velaros-ai/rehearsal-sandbox'
import type { ShellCommandApprovalApi, ShellCommandPolicyApi } from '@velaros-ai/shell-command'
import { shellCommandApproval, shellCommandPolicy } from '@velaros-ai/shell-command'

import { SystemCommandLimits, SystemOperationNames } from '../contract/constants.js'
import type { SystemToolContext } from '../contract/requires.js'
import type { SystemListTasksInput, SystemListTasksResult, SystemRunInput, SystemRunResult } from '../types/commands.js'
import type { SystemShellEnvironmentRefreshResult } from '../types/system.js'
import { exposeCommandOutputWindow } from '../utils/command-result.js'
import { clampPositive } from '../utils/text.js'

/**
 * 四个执行操作：跑命令、演练沙箱、刷新环境、列后台任务。`run`、`sandbox`、`refreshEnvironment`、`listTasks` 各调一个方法。
 *
 * 实现是 `SystemExecutionOperations`，整个进程只有一份（`systemExecutionOperations`）。命令交给宿主执行，
 * 这里负责执行前按命令策略分类、要确认的先问用户，以及把宿主的回执整形成模型看的样子。
 *
 * @AgentView
 * 下面这几件事**四个方法都成立**，各自说明里不再重复：
 * 路径按用户输入规整，`~` 展开到家目录，相对路径相对默认工作目录。
 * 命令按策略分类，要确认的在执行之前问用户；被拒时命令一个进程都没起。
 */
export interface SystemExecutionOperationsApi {
  /**
   * @AgentView
   * 跑一条命令。background 或 interactive 的命令立刻返回，之后用 listTasks 看它跑到哪了；interactive 一定跑在后台，它要开着等用户在控制台里输入。
   * 要确认的命令先问过用户才跑；危险命令每次都由用户亲自裁决。换个 shell 写也照样问——判定认全部五种 shell 的语法。
   * shell 只能填本机有的那几个，填了没有的在执行之前就被拒，一个进程都不起。
   */
  run(input: SystemRunInput, ctx: SystemToolContext): Promise<SystemRunResult>
  /**
   * @AgentView
   * 重新选定本机能用的 shell 并读一遍它的环境变量；Windows 上还会重读用户与系统环境变量写回本进程，没成功时结果的 reason 说明原因。
   * 只改本进程的环境，不动用户的 shell 配置文件，也不装任何东西：刷过一次还缺的命令就是没装。
   */
  refreshEnvironment(ctx: SystemToolContext): Promise<SystemShellEnvironmentRefreshResult>
  /**
   * @AgentView
   * 列出 run 起在后台的任务，最新的在前。宿主按会话隔离时只看得到本会话起的那些。
   * 要停掉一条，用 run 执行它条目里的 terminateCommand 或 forceTerminateCommand，别自己拼 pid。
   */
  listTasks(input: SystemListTasksInput, ctx: SystemToolContext): Promise<SystemListTasksResult>
}

export class SystemExecutionOperations implements SystemExecutionOperationsApi {
  constructor(
    private readonly policy: ShellCommandPolicyApi,
    private readonly approvals: ShellCommandApprovalApi,
    private readonly sandboxRules: RehearsalSandboxRulesApi,
  ) {}

  public async run({ command, cwd, shell, timeoutMs, background, interactive, maxOutputChars }: SystemRunInput, ctx: SystemToolContext): Promise<SystemRunResult> {
    ctx.abortSignal.throwIfAborted()

    // 执行前分类
    const plan = this.policy.analyze(command)
    const commandCwd = ctx.system.resolvePath(cwd)

    // 前台还是后台。交互式命令一定跑在后台：它要一直开着等用户在控制台里输入
    const shouldRunInBackground = !!interactive || (background ?? plan.shouldStartInBackground)

    // 审批。危险命令必须每次由用户亲自裁决：审批端口覆盖 riskScope 后 `:dangerous` 后缀不再可见，
    //    只有 requireManualApproval 能让宿主在任何档位都弹卡。
    if (plan.shouldRequestConfirmation) {
      const scopeLabel = cwd ?? '系统运行环境'
      const request = plan.isDangerous
        ? this.approvals.dangerous({ command, plan, cwd: commandCwd, background: shouldRunInBackground, scopeLabel, riskScope: 'system-command:dangerous' })
        : { message: this.policy.confirmationMessage(command, plan, scopeLabel, shouldRunInBackground), options: { approvalRisk: 'low' as const } }
      await ctx.approval.awaitConfirmation(request.message, ctx.abortSignal, request.options)
    }

    // 交给宿主执行。上限在这里钳，**不在入参 schema 里拦**：预算是这件能力自己的，
    // 谁拥有预算谁兜底；靠调用方那一侧的 schema 拦，换一个入口（代码面、内核按名调用）就漏了。
    // 钳而不拒也是仓库的口径：超了就按上限跑，别为一个数字废掉一整次调用。
    const result = await ctx.system.runCommand(
      command,
      {
        cwd: commandCwd,
        shell,
        timeoutMs: clampPositive(timeoutMs, SystemCommandLimits.timeoutMs),
        background: shouldRunInBackground,
        interactive,
        maxOutputChars: clampPositive(maxOutputChars, SystemCommandLimits.outputChars),
        sessionId: ctx.sessionId,
      },
      plan.isDangerous,
      ctx.abortSignal
    )

    // 整形。要了控制台却没拿到，说明这个宿主跑不了交互式命令，直说，别让模型干等用户输入
    const shaped: SystemRunResult = exposeCommandOutputWindow(result)
    if (interactive && !result.backgroundProcess?.console) {
      shaped.note = '当前宿主没有把它跑成控制台任务，用户无法输入：改成不需要输入的写法（答案用管道喂进去、加 --yes 这类参数），并用 listTasks 里的 terminateCommand 停掉可能已经起来的任务。'
    }
    if (result.backgroundProcess) {
      shaped.backgroundProcess = {
        ...result.backgroundProcess,
        ports: plan.ports,
        reason: plan.reason,
        autoStarted: plan.shouldStartInBackground && !background,
        statusContinuation: result.backgroundProcess.taskId
          ? { tool: SystemOperationNames.listTasks, args: { taskId: result.backgroundProcess.taskId } }
          : result.backgroundProcess.statusContinuation,
      }
    }
    return shaped
  }

  public refreshEnvironment(ctx: SystemToolContext): Promise<SystemShellEnvironmentRefreshResult> {
    // 由 system provider 重新加载 PATH 和 shell 环境变量。
    return ctx.system.refreshShellEnvironment()
  }

  public async listTasks({ limit, onlyRunning, taskId }: SystemListTasksInput, ctx: SystemToolContext): Promise<SystemListTasksResult> {
    // 精确查一条时 limit 没有意义；onlyRunning 可过滤掉已结束的历史任务。
    const tasks = await ctx.system.listBackgroundTasks({
      limit: taskId ? undefined : clampPositive(limit, SystemCommandLimits.taskListItems),
      onlyRunning,
      taskId,
      sessionId: ctx.sessionId,
    })

    // count 给调用方提供轻量摘要。
    return { count: tasks.length, tasks }
  }
}

/** 整个进程唯一的执行操作；run 与 sandbox 的 execute 交给它。 */
export const systemExecutionOperations: SystemExecutionOperationsApi = new SystemExecutionOperations(shellCommandPolicy, shellCommandApproval, rehearsalSandboxRules)
