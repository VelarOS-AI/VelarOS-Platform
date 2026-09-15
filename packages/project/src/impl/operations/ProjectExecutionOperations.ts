/**
 * 两个执行操作：`ProjectExecutionOperations` 与整个进程唯一的 `projectExecutionOperations`。接口 `ProjectExecutionOperationsApi` 在本文件的类上方。
 * `project:run`、`project:sandbox` 各调一个方法：执行前按危险命令策略分类、危险命令每次都向用户确认、会改项目的命令先过修改授权，再交给宿主执行。
 */

import { resolve } from 'node:path'

import { createApprovalOperationKey, createManualApprovalOptions } from '@velaros-ai/agent/tool-contract'
import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { ProjectToolContext } from '../../contract/requires.js'
import type { ProjectRunInput, ProjectSandboxInput } from '../../types/tools.js'
import { requireSandboxPort, resolveSourceInsideProject, sandboxApplyConfirmationMessage, selectSandboxChanges } from '../../utils/agent/sandbox.js'
import { analyzeCommandExecution, buildBackgroundCommandConfirmationMessage, isShellCommandReadOnly } from '../../utils/command-policy.js'

import type { ProjectExecutionGateApi } from './ProjectExecutionGate.js'
import { projectExecutionGate } from './ProjectExecutionGate.js'

/**
 * 两个执行操作：在项目里跑命令、演练沙箱。命令先按危险命令策略分类：危险命令每次都由用户亲自确认（高风险、手动审批）；会改项目的命令先过宿主的项目修改授权；
 * 前台命令在项目资源门里执行（只读命令走读门，其余走写门），后台命令由宿主的任务管理接手。
 */
export interface ProjectExecutionOperationsApi {
  /** 在项目内跑一条命令：cwd 只能在项目之内；用户或宿主拒绝时返回 skipped，不执行。后台命令能不能起由宿主在执行时决定。 */
  run(input: ProjectRunInput, ctx: ProjectToolContext): Promise<unknown>
  /**
   * 演练沙箱：create 只镜像项目之内的目录；run 在镜像里跑命令（危险命令仍然确认）；diff 看变化；apply 先算差量、过修改授权与用户确认才落回；discard 删镜像。
   * 宿主没接沙箱端口时报 UNAVAILABLE。
   */
  sandbox(input: ProjectSandboxInput, ctx: ProjectToolContext): Promise<unknown>
}

export class ProjectExecutionOperations implements ProjectExecutionOperationsApi {
  constructor(private readonly gate: ProjectExecutionGateApi) {}

  public async run(input: ProjectRunInput, context: ProjectToolContext) {
    context.abortSignal.throwIfAborted()
    const plan = analyzeCommandExecution(input.command)
    const background = input.background ?? plan.shouldStartInBackground
    const commandCwd = resolve(context.project.getRootPath(), input.cwd ?? '.')

    if (plan.isDangerous) {
      const decision = await context.approval.awaitConfirmationDecision(
        buildBackgroundCommandConfirmationMessage(input.command, plan, '当前项目', background),
        context.abortSignal,
        // 危险命令每次都要用户亲自点头：审批端口会用操作键覆盖 riskScope，宿主靠 `:dangerous`
        // 后缀认出的硬门随之失效，「完全访问」会静默放行、标准档批准一次就记住整条命令。
        createManualApprovalOptions({
          approvalRisk: 'high',
          riskScope: 'project-command:dangerous',
          operation: {
            key: createApprovalOperationKey('shell-command', {
              command: input.command.trim(),
              cwd: commandCwd,
              background,
            }),
            label: input.command,
            target: commandCwd,
          },
        })
      )
      if (!decision.approved)
        return {
          approved: false,
          skipped: true,
          command: input.command,
          message: decision.message ?? '用户拒绝执行该危险命令。',
        }
    }

    if (!isShellCommandReadOnly(input.command)) {
      const authorization = await context.project.prepareMutation({
        cwd: input.cwd,
        operation: `运行可能修改项目的命令：${input.command}`,
      })
      if (!authorization.approved)
        return {
          approved: false,
          skipped: true,
          command: input.command,
          message: authorization.rejectionMessage ?? authorization.message,
        }
    }

    const invoke = () =>
      context.project.runCommand(
        input.command,
        {
          timeoutMs: input.timeoutMs,
          background,
          maxOutputChars: input.maxOutputChars,
        },
        plan.isDangerous,
        context.abortSignal
      )
    const run = () =>
      background
        ? invoke()
        : this.gate.run(
            context.project.getRootPath(),
            !isShellCommandReadOnly(input.command),
            context.abortSignal,
            invoke
          )
    return input.cwd ? context.project.runInDirectory(input.cwd, run) : run()
  }

  public async sandbox(input: ProjectSandboxInput, context: ProjectToolContext) {
    context.abortSignal.throwIfAborted()
    const port = requireSandboxPort(context)
    const rootPath = context.project.getRootPath()
    const sandboxId = input.sandboxId ?? ''
    if (input.action !== 'create' && !sandboxId) throw new AppError('VALIDATION', `${input.action} 需要 create 返回的 sandboxId`)

    if (input.action === 'create') {
      const source = resolveSourceInsideProject(rootPath, input.source)
      const record = await port.createSandbox({ source, network: !!input.network, ignored: input.ignored ?? 'link' })
      return {
        ...record,
        note: `镜像根是 ${record.root}。项目工具出不了项目边界，所以要跑的脚本先用 project:file 写进项目再 create，或者直接用 run 传命令；镜像里的命令写不到镜像外，${record.network ? '可以联网' : '连不上网'}。跑完用 diff 看变化，用完 discard。`,
      }
    }

    if (input.action === 'run') {
      if (!input.command) throw new AppError('VALIDATION', 'run 需要 command')
      // 沙箱里的命令出不了镜像，所以不走项目的修改授权；危险命令仍然让用户看一眼。
      const plan = analyzeCommandExecution(input.command)
      if (plan.isDangerous) {
        const decision = await context.approval.awaitConfirmationDecision(
          buildBackgroundCommandConfirmationMessage(input.command, plan, `演练沙箱 ${sandboxId}`, false),
          context.abortSignal,
          createManualApprovalOptions({
            approvalRisk: 'high',
            riskScope: 'project-command:dangerous',
            operation: {
              key: createApprovalOperationKey('shell-command', { command: input.command.trim(), cwd: `sandbox:${sandboxId}`, background: false }),
              label: input.command,
              target: `sandbox:${sandboxId}`,
            },
          })
        )
        if (!decision.approved) return { approved: false, skipped: true, sandboxId, command: input.command, message: decision.message }
      }
      return port.runInSandbox({ sandboxId, command: input.command, timeoutMs: input.timeoutMs, maxOutputChars: input.maxOutputChars }, context.abortSignal)
    }

    if (input.action === 'diff') return port.diffSandbox({ sandboxId, maxFiles: input.maxFiles })
    if (input.action === 'discard') return port.discardSandbox(sandboxId)

    // 落回：先算差量摆给用户看，过项目的修改授权和用户确认，才写。
    const changes = await port.diffSandbox({ sandboxId, maxFiles: 2000 })
    const selection = selectSandboxChanges(changes, input.paths)
    if (!isEmpty(selection.unknown)) throw new AppError('VALIDATION', `这些路径在沙箱里没有变化：${selection.unknown.slice(0, 10).join('、')}`)
    if (isEmpty(selection.created) && isEmpty(selection.modified) && isEmpty(selection.deleted)) return { sandboxId, created: [], modified: [], deleted: [], skippedGit: changes.gitChanged, note: '镜像里没有文件变化，什么都没落。' }
    const authorization = await context.project.prepareMutation({ operation: `把演练沙箱 ${sandboxId} 的改动落回项目` })
    if (!authorization.approved) return { approved: false, skipped: true, sandboxId, message: authorization.rejectionMessage ?? authorization.message }
    const decision = await context.approval.awaitConfirmationDecision(
      sandboxApplyConfirmationMessage(changes.source, selection),
      context.abortSignal,
      createManualApprovalOptions({
        approvalRisk: 'high',
        riskScope: 'project-sandbox:apply',
        operation: {
          key: createApprovalOperationKey('sandbox-apply', { sandboxId, created: selection.created.length, modified: selection.modified.length, deleted: selection.deleted.length }),
          label: `把演练沙箱的改动落回 ${changes.source}`,
          target: changes.source,
        },
      })
    )
    if (!decision.approved) return { approved: false, skipped: true, sandboxId, message: decision.message }
    return port.applySandbox({ sandboxId, paths: input.paths })
  }
}

/** 整个进程唯一的执行操作；project:run 与 project:sandbox 的 execute 交给它。 */
export const projectExecutionOperations: ProjectExecutionOperationsApi = new ProjectExecutionOperations(projectExecutionGate)
