/**
 * 代码面 `shell` 命名空间的三个操作：`ShellOperations` 与整个进程唯一的 `shellOperations`。接口 `ShellOperationsApi` 在本文件的类上方。
 * 这里只做三件事：执行前分类、要确认的先问用户、把回执整成模型看的样子；工作目录由空间端口解析，
 * 进程由空间端口起——一个进程都不在这里起（本机是 `@velaros-ai/system` 的本地内核）。
 */

import { ShellLimits } from '../contract/constants.js'
import type { ShellOperationContext } from '../contract/requires.js'
import type { ShellEnvironmentRefreshResult, ShellListTasksInput, ShellListTasksResult, ShellRunInput, ShellRunResult } from '../types/shell-command.js'
import { clampPositive } from '../utils/limits.js'

import type { ShellCommandApprovalApi } from './ShellCommandApproval.js'
import { shellCommandApproval } from './ShellCommandApproval.js'
import type { ShellCommandPolicyApi } from './ShellCommandPolicy.js'
import { shellCommandPolicy } from './ShellCommandPolicy.js'

/**
 * 代码面跨空间的命名空间之一：模型在程序里写 `run(...)`、`listTasks(...)`，每个空间注入自己的 `ShellSpacePort`。
 * 命令在哪儿跑、越界算不算、确认文案怎么写都在端口里，所以模型面只有这一套说明。
 * 实现是 `ShellOperations`，整个进程只有一份（`shellOperations`）。
 *
 * @AgentView
 * 跑命令、看后台任务、刷新 shell 环境。
 * 命令先按策略分类：危险命令每次都由用户亲自确认，长驻命令（开发服务器这类）要先问一声；
 * 当前空间还可能要求别的授权（项目空间里会改项目的命令要先过一次）。任何一关被拒时一个进程都没起，调用抛错。
 * 判定认全部五种 shell 的语法，换个 shell 写照样问。
 */
export interface ShellOperationsApi {
  /**
   * @AgentView
   * 跑一条命令。background 或 interactive 的命令立刻返回，之后用 listTasks 看它跑到哪了；interactive 一定跑在后台，它要开着等用户在控制台里输入。
   * 长驻命令不传 background 也会自动转后台，回执里 backgroundProcess.autoStarted 为真。
   */
  run(input: ShellRunInput, ctx: ShellOperationContext): Promise<ShellRunResult>
  /**
   * @AgentView
   * 重新选定本机能用的 shell 并读一遍它的环境变量；Windows 上还会重读用户与系统环境变量写回本进程，没成功时结果的 reason 说明原因。
   * 只改本进程的环境，不动用户的 shell 配置文件，也不装任何东西：刷过一次还缺的命令就是没装。
   */
  refreshEnvironment(ctx: ShellOperationContext): Promise<ShellEnvironmentRefreshResult>
  /**
   * @AgentView
   * 列出 run 起在后台的任务，最新的在前。宿主按会话隔离时只看得到本会话起的那些。
   * 要停掉一条，用 run 执行它条目里的 terminateCommand 或 forceTerminateCommand，别自己拼 pid。
   */
  listTasks(input: ShellListTasksInput, ctx: ShellOperationContext): Promise<ShellListTasksResult>
}

export class ShellOperations implements ShellOperationsApi {
  constructor(
    private readonly policy: ShellCommandPolicyApi,
    private readonly approvals: ShellCommandApprovalApi,
  ) {}

  public async run({ command, cwd, shell, timeoutMs, background, interactive, maxOutputChars }: ShellRunInput, ctx: ShellOperationContext): Promise<ShellRunResult> {
    ctx.abortSignal.throwIfAborted()
    // 工作目录先由空间解析：越界的排在确认之前拒绝，用户不会被问一条注定跑不了的命令。
    const commandCwd = await ctx.shell.resolveCwd(cwd)
    const plan = this.policy.analyze(command)
    // 交互式命令一定跑在后台：它要一直开着等用户在控制台里输入。
    const inBackground = !!interactive || (background ?? plan.shouldStartInBackground)

    // 危险命令必须每次由用户亲自裁决：审批端口会用操作身份覆盖 riskScope，只有手动确认选项能让宿主在任何档位都弹卡。
    if (plan.shouldRequestConfirmation) {
      const { scopeLabel, riskScope } = ctx.shell.commandPolicy(cwd)
      const request = plan.isDangerous
        ? this.approvals.dangerous({ command, plan, cwd: commandCwd, background: inBackground, scopeLabel, riskScope })
        : { message: this.policy.confirmationMessage(command, plan, scopeLabel, inBackground), options: { approvalRisk: 'low' as const } }
      await ctx.approval.awaitConfirmation(request.message, ctx.abortSignal, request.options)
    }

    // 空间自己还要过的关（项目空间在这里过写授权）：排在确认之后、起进程之前，被拒一个进程都不起。
    await ctx.shell.reviewCommand?.({ command, plan, cwd: commandCwd })

    // 上限在这里钳，不靠调用方拦：预算是这件能力自己的，换一个入口也漏不掉；超了按上限跑，别为一个数字废掉一整次调用。
    const result: ShellRunResult = await ctx.shell.runCommand(
      command,
      {
        cwd: commandCwd,
        shell,
        timeoutMs: clampPositive(timeoutMs, ShellLimits.timeoutMs),
        background: inBackground,
        interactive,
        maxOutputChars: clampPositive(maxOutputChars, ShellLimits.outputChars),
        sessionId: ctx.sessionId,
      },
      plan.isDangerous,
      ctx.abortSignal
    )

    // 要了控制台却没拿到，说明这个宿主跑不了交互式命令：直说，别让模型干等用户输入。
    if (interactive && !result.backgroundProcess?.console) {
      result.note = '当前宿主没有把它跑成控制台任务，用户无法输入：改成不需要输入的写法（答案用管道喂进去、加 --yes 这类参数），并用 listTasks 里的 terminateCommand 停掉可能已经起来的任务。'
    }
    if (result.backgroundProcess) {
      result.backgroundProcess = {
        ...result.backgroundProcess,
        ports: plan.ports,
        reason: plan.reason,
        autoStarted: plan.shouldStartInBackground && !background,
      }
    }
    return result
  }

  public refreshEnvironment(ctx: ShellOperationContext): Promise<ShellEnvironmentRefreshResult> {
    ctx.abortSignal.throwIfAborted()
    return ctx.shell.refreshShellEnvironment()
  }

  public async listTasks({ limit, onlyRunning, taskId }: ShellListTasksInput, ctx: ShellOperationContext): Promise<ShellListTasksResult> {
    ctx.abortSignal.throwIfAborted()
    // 精确查一条时 limit 没有意义。
    const tasks = await ctx.shell.listBackgroundTasks({
      limit: taskId ? undefined : clampPositive(limit, ShellLimits.taskListItems),
      onlyRunning,
      taskId,
      sessionId: ctx.sessionId,
    })
    return { count: tasks.length, tasks }
  }
}

/** 整个进程只有一份的 shell 操作；宿主把它挂在代码面的 `shell` 命名空间上，每次调用时把自己空间的端口塞进 ctx。 */
export const shellOperations: ShellOperationsApi = new ShellOperations(shellCommandPolicy, shellCommandApproval)
