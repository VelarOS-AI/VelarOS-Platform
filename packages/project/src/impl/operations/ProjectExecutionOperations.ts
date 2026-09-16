/**
 * 两个执行操作：`ProjectExecutionOperations` 与整个进程唯一的 `projectExecutionOperations`。接口 `ProjectExecutionOperationsApi` 在本文件的类上方。
 * `project:run`、`project:sandbox` 各调一个方法：命令判定与危险命令的审批请求来自 `@velaros-ai/shell-command`，落回前的核对与确认来自 `@velaros-ai/rehearsal-sandbox`。
 */

import type { RehearsalSandboxRulesApi } from '@velaros-ai/rehearsal-sandbox'
import { rehearsalSandboxRules } from '@velaros-ai/rehearsal-sandbox'
import type { ShellCommandApprovalApi, ShellCommandPolicyApi } from '@velaros-ai/shell-command'
import { shellCommandApproval, shellCommandPolicy } from '@velaros-ai/shell-command'

import type { ProjectToolContext } from '../../contract/requires.js'
import type { ProjectRunInput, ProjectSandboxInput } from '../../types/tools.js'
import { assertSandboxApplyWritable, redactCommandOutput } from '../../utils/agent/execution.js'
import { requireSandboxPort, resolveCommandCwdInsideProject, resolveSourceInsideProject } from '../../utils/agent/sandbox.js'

import type { ProjectExecutionGateApi } from './ProjectExecutionGate.js'
import { projectExecutionGate } from './ProjectExecutionGate.js'

/**
 * 两个执行操作：在项目里跑命令、演练沙箱。命令先按公共命令判定分类：危险命令每次都由用户亲自确认（高风险、手动、不可记忆）；会改项目的命令先过宿主的项目修改授权；
 * 前台命令在项目资源门里执行（只读命令走读门，其余走写门），后台命令由宿主的任务管理接手。
 */
export interface ProjectExecutionOperationsApi {
  /**
   * 在项目内跑一条命令：cwd 只能在项目之内；用户或宿主拒绝时返回 skipped，不执行。后台命令能不能起由宿主在执行时决定。
   * `shell` 原样交给宿主（不填就是宿主的默认 shell），本机没有挑定的那个由宿主在执行之前拒绝；命令判定不看挑的是哪个 shell，它认全部五种语法。
   */
  run(input: ProjectRunInput, ctx: ProjectToolContext): Promise<unknown>
  /**
   * 演练沙箱：create 只镜像项目之内的目录；run 在镜像里跑命令（危险命令仍然确认）；diff 看变化；
   * apply 向宿主要不截断的完整差量，核对与确认都按完整三列，过修改授权与用户确认后连同差量指纹交给宿主落回，镜像在确认之后又变过就整批不落；discard 删镜像。
   * 宿主没接沙箱端口时报 UNAVAILABLE。
   */
  sandbox(input: ProjectSandboxInput, ctx: ProjectToolContext): Promise<unknown>
}

export class ProjectExecutionOperations implements ProjectExecutionOperationsApi {
  private static readonly ApplyClosingNote = '删除和覆盖不经过 project:edit 的撤销账本；落回前会核对这些文件自建沙箱以来没被别人改过，改过就整批不落。'

  constructor(
    private readonly gate: ProjectExecutionGateApi,
    private readonly policy: ShellCommandPolicyApi,
    private readonly approvals: ShellCommandApprovalApi,
    private readonly sandboxRules: RehearsalSandboxRulesApi,
  ) {}

  public async run(input: ProjectRunInput, context: ProjectToolContext) {
    context.abortSignal.throwIfAborted()
    // 工作目录先核对在项目之内：排在确认与授权之前，用户不会被问一条注定失败的命令。
    const commandCwd = await resolveCommandCwdInsideProject(context.project.getRootPath(), input.cwd)
    const plan = this.policy.analyze(input.command)
    const background = input.background ?? plan.shouldStartInBackground

    if (plan.isDangerous) {
      const request = this.approvals.dangerous({ command: input.command, plan, cwd: commandCwd, background, scopeLabel: '当前项目', riskScope: 'project-command:dangerous' })
      const decision = await context.approval.awaitConfirmationDecision(request.message, context.abortSignal, request.options)
      if (!decision.approved)
        return { approved: false, skipped: true, command: input.command, message: decision.message ?? '用户拒绝执行该危险命令。' }
    }

    if (!plan.isReadOnly) {
      const authorization = await context.project.prepareMutation({ cwd: input.cwd, operation: `运行可能修改项目的命令：${input.command}` })
      if (!authorization.approved)
        return { approved: false, skipped: true, command: input.command, message: authorization.message }
    }

    const invoke = () => context.project.runCommand(input.command, { cwd: input.cwd, shell: input.shell, timeoutMs: input.timeoutMs, background, maxOutputChars: input.maxOutputChars }, plan.isDangerous, context.abortSignal)
    const run = () => background ? invoke() : this.gate.run(context.project.getRootPath(), !plan.isReadOnly, context.abortSignal, invoke)
    return redactCommandOutput(context, await run())
  }

  public async sandbox(input: ProjectSandboxInput, context: ProjectToolContext) {
    context.abortSignal.throwIfAborted()
    const port = requireSandboxPort(context)
    const rootPath = context.project.getRootPath()
    // sandboxId、command 这些跨字段要求由 schema 拦，执行阶段只按动作取值。
    const sandboxId = input.sandboxId ?? ''

    if (input.action === 'create') {
      const source = await resolveSourceInsideProject(rootPath, input.source)
      const record = await port.createSandbox({ source, network: !!input.network, ignored: input.ignored ?? 'link' })
      return {
        ...record,
        note: `沙箱 ${record.id} 已建好（${record.network ? '可以联网' : '不能联网'}）。接下来用 action=run 在镜像里跑命令，diff 看变化，用完 discard。`,
      }
    }

    if (input.action === 'run') {
      const command = input.command ?? ''
      // 沙箱里的命令出不了镜像，所以不走项目的修改授权；危险命令仍然让用户看一眼。
      const plan = this.policy.analyze(command)
      if (plan.isDangerous) {
        const request = this.approvals.dangerous({ command, plan, cwd: `sandbox:${sandboxId}`, background: false, scopeLabel: `演练沙箱 ${sandboxId}`, riskScope: 'project-command:dangerous' })
        const decision = await context.approval.awaitConfirmationDecision(request.message, context.abortSignal, request.options)
        if (!decision.approved) return { approved: false, skipped: true, sandboxId, command, message: decision.message }
      }
      return redactCommandOutput(
        context,
        await port.runInSandbox({ sandboxId, command, shell: input.shell, timeoutMs: input.timeoutMs, maxOutputChars: input.maxOutputChars }, context.abortSignal),
      )
    }

    if (input.action === 'diff') return port.diffSandbox({ sandboxId, maxFiles: input.maxFiles })
    if (input.action === 'discard') return port.discardSandbox(sandboxId)

    // 落回：先向宿主要不截断的完整差量，核对与确认请求交给公共规则；再过项目的修改授权和用户确认，最后连同差量指纹交给宿主落回。
    const changes = await port.diffSandbox({ sandboxId, maxFiles: Number.MAX_SAFE_INTEGER, textDiffs: false })
    const request = this.sandboxRules.prepareApply({ diff: changes, paths: input.paths, targetLabel: `项目 ${changes.source}`, closingNote: ProjectExecutionOperations.ApplyClosingNote, riskScope: 'project-sandbox:apply' })
    if (!request) return { sandboxId, created: [], modified: [], deleted: [], skippedGit: changes.gitChanged, note: '镜像里没有文件变化，什么都没落。' }
    await assertSandboxApplyWritable(context, [...request.selection.created, ...request.selection.modified, ...request.selection.deleted])
    const authorization = await context.project.prepareMutation({ operation: `把演练沙箱 ${sandboxId} 的改动落回项目` })
    if (!authorization.approved) return { approved: false, skipped: true, sandboxId, message: authorization.message }
    const decision = await context.approval.awaitConfirmationDecision(request.message, context.abortSignal, request.options)
    if (!decision.approved) return { approved: false, skipped: true, sandboxId, message: decision.message }
    return port.applySandbox({ sandboxId, paths: input.paths, fingerprint: changes.fingerprint })
  }
}

/** 整个进程唯一的执行操作；project:run 与 project:sandbox 的 execute 交给它。 */
export const projectExecutionOperations: ProjectExecutionOperationsApi = new ProjectExecutionOperations(projectExecutionGate, shellCommandPolicy, shellCommandApproval, rehearsalSandboxRules)
