/**
 * 代码面 `shell` 命名空间的三个操作：`ShellOperations` 与整个进程唯一的 `shellOperations`。接口 `ShellOperationsApi` 在本文件的类上方。
 * 这里只做三件事：执行前分类、要确认的先问用户、把回执整成模型看的样子；工作目录由空间端口解析，
 * 进程由空间端口起——一个进程都不在这里起（本机是 `@velaros-ai/system` 的本地内核）。
 */

import { isNull, isTrue } from '@velaros-ai/core'

import { ShellLimits } from '../contract/constants.js'
import type { ShellOperationContext } from '../contract/requires.js'
import type {
  ShellEnvironment,
  ShellListTasksInput,
  ShellListTasksResult,
  ShellRunInput,
  ShellRunResult,
  ShellStopInput,
  ShellStopResult,
} from '../types/shell-command.js'
import { clampPositive } from '../utils/limits.js'
import { environmentOf, runResult, taskOf } from '../utils/results.js'

import type { ShellCommandApprovalApi } from './ShellCommandApproval.js'
import { shellCommandApproval } from './ShellCommandApproval.js'
import type { ShellCommandPolicyApi } from './ShellCommandPolicy.js'
import { shellCommandPolicy } from './ShellCommandPolicy.js'

/**
 * 代码面跨空间的命名空间之一：模型在程序里写 `run(...)`、`listTasks(...)`，每个空间注入自己的 `ShellSpacePort`。
 * 命令在哪儿跑、越界算不算、确认文案怎么写都在端口里，所以模型面只有这一套说明。
 * 宿主交回的回执很全（进程约束、归属、捕获的账、验证摘要，界面要用），模型只拿它用得上的那几项。
 * 实现是 `ShellOperations`，整个进程只有一份（`shellOperations`）。
 *
 * @AgentView
 * 跑命令、看和停后台任务、刷新 shell 环境。
 * 命令先按策略分类：危险命令每次都由用户亲自确认，长驻命令（开发服务器这类）要先问一声；
 * 当前空间还可能要求别的授权（比如会改东西的命令先过一次修改授权）。任何一关被拒时一个进程都没起，调用抛错。
 * 判定认全部五种 shell 的语法，换个 shell 写照样问。
 */
export interface ShellOperationsApi {
  /**
   * @AgentView
   * 跑一条命令，等它跑完交回全部输出。background 或 interactive 的命令立刻返回，之后用 listTasks 看它跑到哪了；interactive 一定跑在后台，它要开着等用户在控制台里输入。
   * 长驻命令不传 background 也会自动转后台，回执里 backgroundProcess.autoStarted 为真。
   */
  run(input: ShellRunInput, ctx: ShellOperationContext): Promise<ShellRunResult>
  /**
   * @AgentView
   * 重新选定本机能用的 shell 并读一遍它的环境变量；Windows 上还会重读用户与系统环境变量写回本进程。
   * 只改本进程的环境，不动用户的 shell 配置文件，也不装任何东西：刷过一次还缺的命令就是没装。
   */
  refreshEnvironment(ctx: ShellOperationContext): Promise<ShellEnvironment>
  /**
   * @AgentView
   * 列出 run 起在后台的任务，最新的在前，每条带着它到现在的全部输出。
   */
  listTasks(input: ShellListTasksInput, ctx: ShellOperationContext): Promise<ShellListTasksResult>
  /**
   * @AgentView
   * 停掉一条后台任务。普通终止停不下来时抛错，再带 force: true 来一次；任务不存在时抛错。
   */
  stop(input: ShellStopInput, ctx: ShellOperationContext): Promise<ShellStopResult>
}

export class ShellOperations implements ShellOperationsApi {
  constructor(
    private readonly policy: ShellCommandPolicyApi,
    private readonly approvals: ShellCommandApprovalApi,
  ) {}

  public async run({ command, cwd, shell, timeoutMs, background, interactive }: ShellRunInput, ctx: ShellOperationContext): Promise<ShellRunResult> {
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

    // 超时在这里钳，不靠调用方拦：超了按上限跑，别为一个数字废掉一整次调用。输出不折叠，只守内存的上限。
    const result = await ctx.shell.runCommand(
      command,
      {
        cwd: commandCwd,
        shell,
        timeoutMs: clampPositive(timeoutMs, ShellLimits.timeoutMs),
        background: inBackground,
        interactive,
        maxOutputChars: ShellLimits.outputChars,
        sessionId: ctx.sessionId,
      },
      plan.isDangerous,
      ctx.abortSignal
    )
    const shaped = runResult(result)
    if (result.backgroundProcess && !isNull(result.backgroundProcess.taskId)) {
      const started: NonNullable<ShellRunResult['backgroundProcess']> = {
        taskId: result.backgroundProcess.taskId,
        ports: plan.ports,
        autoStarted: plan.shouldStartInBackground && !background,
      }
      if (result.backgroundProcess.console) started.console = result.backgroundProcess.console
      shaped.backgroundProcess = started
    }
    // 要了控制台却没拿到，说明这个宿主跑不了交互式命令：直说，别让模型干等用户输入。
    if (interactive && !result.backgroundProcess?.console) {
      shaped.note = '当前宿主没有把它跑成控制台任务，用户无法输入：改成不需要输入的写法（答案用管道喂进去、加 --yes 这类参数），并用 stop 停掉可能已经起来的任务。'
    }
    return shaped
  }

  public async refreshEnvironment(ctx: ShellOperationContext): Promise<ShellEnvironment> {
    ctx.abortSignal.throwIfAborted()
    return environmentOf(await ctx.shell.refreshShellEnvironment())
  }

  public async listTasks({ onlyRunning, taskId }: ShellListTasksInput, ctx: ShellOperationContext): Promise<ShellListTasksResult> {
    ctx.abortSignal.throwIfAborted()
    const tasks = await ctx.shell.listBackgroundTasks({ onlyRunning, taskId, sessionId: ctx.sessionId })
    return { tasks: tasks.map(taskOf) }
  }

  public async stop({ taskId, force }: ShellStopInput, ctx: ShellOperationContext): Promise<ShellStopResult> {
    ctx.abortSignal.throwIfAborted()
    const outcome = await ctx.shell.terminateBackgroundTask({ taskId, sessionId: ctx.sessionId, force: isTrue(force) })
    const result: ShellStopResult = { taskId, stopped: outcome.terminated, status: outcome.statusAfter }
    if (!outcome.terminated) result.note = outcome.message
    return result
  }
}

/** 整个进程只有一份的 shell 操作；宿主把它挂在代码面的 `shell` 命名空间上，每次调用时把自己空间的端口塞进 ctx。 */
export const shellOperations: ShellOperationsApi = new ShellOperations(shellCommandPolicy, shellCommandApproval)
