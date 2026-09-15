/**
 * 两个执行操作：`SystemExecutionOperations` 与整个进程唯一的 `systemExecutionOperations`。接口 `SystemExecutionOperationsApi` 在本文件的类上方。
 * `system:run`、`system:sandbox` 各调一个方法，它们的执行前分类、向用户确认和结果整形写在这里；只调一次宿主端口的简单工具（刷新环境、列后台任务）直接写在工具文件里。
 * 真正跑命令、建镜像的是宿主端口 `ctx.system`（本机就是本地内核）。
 */

import { join } from 'node:path'

import { createApprovalOperationKey, createManualApprovalOptions } from '@velaros-ai/agent/tool-contract'
import { isEmpty, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { ShellCommandApprovalApi, ShellCommandPolicyApi } from '@velaros-ai/shell-command'
import { shellCommandApproval, shellCommandPolicy } from '@velaros-ai/shell-command'

import { SystemFailureLimits, SystemToolNames } from '../contract/constants.js'
import type { SystemToolContext } from '../contract/requires.js'
import type { SystemRunInput, SystemRunResult } from '../types/commands.js'
import type { SystemSandboxInput, SystemSandboxResult } from '../types/sandbox.js'
import { exposeCommandOutputWindow } from '../utils/command-result.js'
import { isCredentialPath, isSensitiveSystemMutationPath } from '../utils/file-safety.js'
import { buildSandboxApplyConfirmationMessage, selectSandboxChanges } from '../utils/sandbox.js'

/**
 * 两个执行操作：跑命令、演练沙箱。`system:run`、`system:sandbox` 各调一个方法。
 *
 * 实现是 `SystemExecutionOperations`，整个进程只有一份（`systemExecutionOperations`）。路径交给宿主解析（`~` 与相对路径），命令交给宿主执行，
 * 这里负责执行前按命令策略分类、要确认的先问用户，以及把宿主的回执整形成模型看的样子。
 */
export interface SystemExecutionOperationsApi {
  /**
   * 跑一条命令：先按命令策略分类（只读、要不要确认、该不该丢后台），交互式命令一定跑在后台，因为它要一直开着等用户在控制台里输入。
   * 要确认的先问用户；危险命令每次都由用户亲自裁决（高风险、手动审批，宿主在任何档位都弹卡）。
   * 交给宿主执行后补上输出窗口说明；进了后台的补上端口、原因、是否自动转后台和查状态的续接（指向 system:list-tasks）；要了控制台却没拿到时 note 说明怎么改写命令。
   */
  run(input: SystemRunInput, ctx: SystemToolContext): Promise<SystemRunResult>
  /**
   * 演练沙箱的四个动作，除 create 外都要 sandboxId：create 建镜像并提醒怎么用；diff 看镜像相对创建时的变化；discard 删镜像。
   * apply 先算完整差量（不截断），paths 里有没变化的路径就在问用户之前拒绝；把删除、覆盖的条数与路径和其中的敏感路径摆给用户确认（高风险、每次都问），
   * 确认了才让宿主落回，并把确认时的差量指纹一起交过去，镜像在确认之后又变过就整批不落；镜像里没有文件变化就什么都不落，只落指定路径时 note 说明。
   */
  sandbox(input: SystemSandboxInput, ctx: SystemToolContext): Promise<SystemSandboxResult>
}

export class SystemExecutionOperations implements SystemExecutionOperationsApi {
  constructor(
    private readonly policy: ShellCommandPolicyApi,
    private readonly approvals: ShellCommandApprovalApi,
  ) {}

  public async run({ command, cwd, timeoutMs, background, interactive, maxOutputChars }: SystemRunInput, ctx: SystemToolContext): Promise<SystemRunResult> {
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

    // 交给宿主执行
    const result = await ctx.system.runCommand(
      command,
      { cwd: commandCwd, timeoutMs, background: shouldRunInBackground, interactive, maxOutputChars, sessionId: ctx.sessionId },
      plan.isDangerous,
      ctx.abortSignal
    )

    // 整形。要了控制台却没拿到，说明这个宿主跑不了交互式命令，直说，别让模型干等用户输入
    const shaped: SystemRunResult = exposeCommandOutputWindow(result)
    if (interactive && !result.backgroundProcess?.console) {
      shaped.note = '当前宿主没有把它跑成控制台任务，用户无法输入：改成不需要输入的写法（答案用管道喂进去、加 --yes 这类参数），并用 system:list-tasks 里的 terminateCommand 停掉可能已经起来的任务。'
    }
    if (result.backgroundProcess) {
      shaped.backgroundProcess = {
        ...result.backgroundProcess,
        ports: plan.ports,
        reason: plan.reason,
        autoStarted: plan.shouldStartInBackground && !background,
        statusContinuation: result.backgroundProcess.taskId
          ? { tool: SystemToolNames.listTasks, args: { taskId: result.backgroundProcess.taskId } }
          : result.backgroundProcess.statusContinuation,
      }
    }
    return shaped
  }

  public async sandbox(input: SystemSandboxInput, ctx: SystemToolContext): Promise<SystemSandboxResult> {
    const sandboxId = input.sandboxId ?? ''
    if (input.action !== 'create' && !sandboxId) throw new AppError('VALIDATION', `${input.action} 需要 create 返回的 sandboxId`)
    if (input.action === 'create') {
      const record = await ctx.system.createSandbox({ source: input.source, network: input.network, ignored: input.ignored })
      const detached = record.detachedGitLinks ?? []
      const detachedNote = isEmpty(detached) ? '' : `这些目录的 .git 指向源目录外的真实仓库（git worktree、子模块），没有放进镜像，镜像里它们不是 git 仓库：${detached.join('、')}。`
      return {
        ...record,
        note: `镜像根是 ${record.root}：脚本用 system:edit 写进去，system:run 传 cwd=${record.root} 跑，跑完用 diff 看变化；镜像里的命令写不到镜像外，${record.network ? '可以联网' : '连不上网'}。用完 discard。${detachedNote}`,
      }
    }
    if (input.action === 'diff') return ctx.system.diffSandbox({ sandboxId, maxFiles: input.maxFiles })
    if (input.action === 'discard') return ctx.system.discardSandbox(sandboxId)

    // 落回：先算完整差量（不截断、不附文本差量），把删除、覆盖、敏感路径都摆给用户看，确认了才写。
    // 条数、敏感路径都按完整的三列算；确认时的差量指纹交给宿主，镜像在确认之后又变过就整批不落。
    const changes = await ctx.system.diffSandbox({ sandboxId, maxFiles: Number.MAX_SAFE_INTEGER, textDiffs: false })
    if (changes.truncated) throw new AppError('VALIDATION', '宿主给的差量被截断了，没法对着完整的改动向用户确认，什么都没写。')
    const selection = selectSandboxChanges(changes, input.paths)
    if (!isEmpty(selection.unknown)) throw new AppError('VALIDATION', `这些路径在沙箱里没有变化，什么都没写：${selection.unknown.slice(0, SystemFailureLimits.listItems).join('、')}`)
    if (isEmpty(selection.created) && isEmpty(selection.modified) && isEmpty(selection.deleted)) return { sandboxId, created: [], modified: [], deleted: [], skippedGit: changes.gitChanged, note: '镜像里没有文件变化，什么都没落。' }
    const targets = [...selection.created, ...selection.modified, ...selection.deleted].map((path) => join(changes.source, path))
    const sensitive = targets.filter((path) => isSensitiveSystemMutationPath(path) || isCredentialPath(path))
    await ctx.approval.awaitConfirmation(
      buildSandboxApplyConfirmationMessage(changes.source, selection, sensitive),
      ctx.abortSignal,
      createManualApprovalOptions({
        approvalRisk: 'high',
        riskScope: 'system-sandbox:apply',
        operation: {
          key: createApprovalOperationKey('sandbox-apply', { sandboxId, fingerprint: toNullable(changes.fingerprint), created: selection.created.length, modified: selection.modified.length, deleted: selection.deleted.length }),
          label: `把演练沙箱的改动落回 ${changes.source}`,
          target: changes.source,
        },
      })
    )
    const applied = await ctx.system.applySandbox({ sandboxId, paths: input.paths, fingerprint: changes.fingerprint })
    // 宿主的回执原样不动，note 放进新对象里。
    return input.paths ? { ...applied, note: `只落了指定的 ${input.paths.length} 个路径。` } : applied
  }
}

/** 整个进程唯一的执行操作；system:run 与 system:sandbox 的 execute 交给它。 */
export const systemExecutionOperations: SystemExecutionOperationsApi = new SystemExecutionOperations(shellCommandPolicy, shellCommandApproval)
