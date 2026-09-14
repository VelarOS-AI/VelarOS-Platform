import { resolve } from 'node:path'

import { z } from 'zod'

import { createApprovalOperationKey, createManualApprovalOptions } from '@velaros-ai/agent/tool-contract'
import { AppError } from '@velaros-ai/core/error'

import { analyzeCommandExecution, buildBackgroundCommandConfirmationMessage, isParallelCommandExecutionSafe, isShellCommandReadOnly } from '../../execution/command-policy'
import { ProjectToolNames } from '../../project-tool-names'
import { ProjectExecutionCapability } from '../ProjectCapabilities'
import { runWithProjectExecutionGate } from '../ProjectExecutionGate'
import type { ProjectToolContext } from '../Types'

import { defineProjectTool } from './shared'

async function runProjectCommand(
  input: {
    command: string
    cwd?: string
    timeoutMs?: number
    background?: boolean
    maxOutputChars?: number
  },
  context: ProjectToolContext
) {
  context.abortSignal.throwIfAborted()
  const plan = analyzeCommandExecution(input.command)
  const background = input.background ?? plan.shouldStartInBackground
  const commandCwd = resolve(context.project.getRootPath(), input.cwd ?? '.')
  if (background && !context.system.canStartBackgroundCommands())
    throw new AppError('PERMISSION', '当前运行时不允许启动后台项目进程。')

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
      : runWithProjectExecutionGate(
          context.project.getRootPath(),
          !isShellCommandReadOnly(input.command),
          context.abortSignal,
          invoke
        )
  return input.cwd ? context.project.runInDirectory(input.cwd, run) : run()
}

export const projectRun = defineProjectTool<{
  command: string
  cwd?: string
  timeoutMs?: number
  background?: boolean
  maxOutputChars?: number
}>({
  name: ProjectToolNames.run,
  category: 'project-execution',
  role: 'execute',
  summary: '在项目边界内运行可取消、可审计且支持后台任务的命令。',
  protocol: [
    '生成命令前读取宿主报告的实际 shell.kind/name。Windows 按 Git Bash、PowerShell 7、Windows PowerShell、CMD 的可用性选择，并推荐安装 Git for Windows。',
    'Git Bash/POSIX 使用 command -v、$NAME；PowerShell 使用 Get-Command、$env:NAME；CMD 使用 where、%NAME%。刷新环境后按当前 shell 重新生成命令；失败先诊断退出码和输出，避免重复执行副作用。',
  ],
  examples: [{ command: 'bun test' }],
  schema: z.strictObject({
    command: z.string().min(1),
    cwd: z
      .string()
      .optional()
      .describe(
        '当前项目内的工作目录，可用相对路径或绝对路径；省略时使用当前项目目录。不能用它切换到项目之外。'
      ),
    timeoutMs: z.number().int().positive().max(600_000).optional(),
    background: z.boolean().optional(),
    maxOutputChars: z.number().int().positive().max(50_000).optional(),
  }),
  permissions: ['process:exec'],
  capabilities: ProjectExecutionCapability,
  exposure: { tier: 'common', rank: 50 },
  isConcurrencySafe: (input) => isParallelCommandExecutionSafe(input),
  execute: runProjectCommand,
})

