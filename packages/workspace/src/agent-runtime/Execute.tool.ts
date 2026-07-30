
import { z } from 'zod'

import { toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import {
  renderParameterDescription as parameterDescription,
} from '@velaros-ai/core/utils/ToolDescription'

import {
  analyzeCommandExecution,
  buildBackgroundCommandConfirmationMessage,
  isParallelCommandExecutionSafe,
} from '../command-execution-policy.js'

import { shouldPrepareCommandWorkspaceMutation, shouldPrepareExternalProjectMutation } from './Execute'
import {
  buildWorkspaceMutationSkippedResult,
  prepareWorkspaceMutation,
  runWithDirectory,
} from './Helpers'
import { defineWorkspaceToolCapability } from './KernelToolShared'
import { codingToolHelper } from './Tool'
import { defineWorkspaceVelaTool } from './workspaceToolMiddleware'

/** 执行项目验证计划。 */
const runVerificationPlan = defineWorkspaceVelaTool<{
  cwd?: string
  changedPaths?: string[]
  goal?: 'quick' | 'standard' | 'thorough'
  maxCommands?: number
  stopOnFailure?: boolean
  allowRepeat?: boolean
}>({
  name: 'run_verification_plan',
  role: 'execute',
  category: 'workspace-execute',
  summary: '执行项目验证计划。',
  suitable: ['实现完成后需要真正运行推荐检查，而不只是给建议。'],
  forbidden: ['不要在每次小改后反复运行完整验证。'],
  protocol: ['完成实现并检查 diff 后再运行；快速验证时限制 maxCommands。'],
  usage: ['可传 changedPaths、goal、maxCommands、stopOnFailure、cwd。'],
  examples: [
    // 快速验证：限制命令数
    { goal: 'quick', maxCommands: 3 },
    // 针对改动文件验证，遇错即停
    { changedPaths: ['src/app.ts'], stopOnFailure: true, maxCommands: 5 },
    // 更彻底的验证（goal 可选 quick|standard|thorough）
    { goal: 'thorough', maxCommands: 8, stopOnFailure: false },
  ],
  notes: ['不传 maxCommands 时最多执行 10 条推荐命令。'],
  schema: z.object({
    cwd: z.string().optional().describe(
      parameterDescription({
        description: '项目目录。',
        usage: ['可传绝对路径，或相对当前工作区的路径。'],
      })
    ),
    changedPaths: z
      .array(z.string().min(1))
      .max(100)
      .optional()
      .describe(
        parameterDescription({
          description: '改动文件路径列表。',
          usage: ['传相对工作区根目录的路径。'],
          notes: ['省略时会从 session 或 Git 推断当前改动。'],
        })
      ),
    goal: z
      .enum(['quick', 'standard', 'thorough'])
      .optional()
      .describe(
        parameterDescription({
          description: '验证执行强度。',
          values: [
            'quick：运行成本最低、反馈最快的检查。',
            'standard：运行常规推荐检查。',
            'thorough：运行更完整、更耗时的检查。',
          ],
        })
      ),
    maxCommands: z.number().int().positive().max(10).optional().describe(
      parameterDescription({
        description: '最多执行的验证命令数。',
        notes: ['最大 10。'],
      })
    ),
    stopOnFailure: z.boolean().optional().describe(
      parameterDescription({
        description: '失败后是否停止后续命令。',
        notes: ['适合快速定位首个阻断错误。'],
      })
    ),
    allowRepeat: z
      .boolean()
      .optional()
      .describe(
        parameterDescription({
          description: '是否允许重复运行同一验证计划。',
          notes: ['仅在用户明确要求重复验证时设为 true。'],
        })
      ),
  }),
  permissions: ['fs:read', 'process:exec'],
  capabilities: defineWorkspaceToolCapability({
    effectKind: 'execute',
    readScopes: ['workspace'],
    filesystem: { read: 'workspace', write: 'none' },
    metadata: {
      workspace: {
        requiresActiveProject: true,
        requiresWorkspaceSwitchForExternalCwd: true,
        mutation: 'none',
        arbitraryRead: true,
      },
    },
    process: { execution: 'input-dependent' },
    concurrency: 'unsafe',
    reason: 'workspace verification command execution',
  }),
  isConcurrencySafe: () => false,
  execute: async ({ cwd, changedPaths, goal, maxCommands, stopOnFailure }, ctx) => {
    ctx.abortSignal.throwIfAborted()
    if (await shouldPrepareExternalProjectMutation(ctx, cwd)) {
      const authorization = await prepareWorkspaceMutation(ctx, {
        cwd,
        operation: '执行项目验证计划',
      })
      if (authorization) return buildWorkspaceMutationSkippedResult(authorization)
    }

    // 未传 changedPaths 时从 session/Git 推断，保持验证范围贴近当前改动。
    const effectiveChangedPaths = await codingToolHelper.resolveChangedPaths(ctx, changedPaths, cwd)
    // runVerificationPlan 会按项目脚本执行命令，具有进程副作用，不能并发。
    const run = await runWithDirectory(ctx, cwd, () =>
      ctx.workspace.runVerificationPlan({
        changedPaths: effectiveChangedPaths,
        goal,
        maxCommands,
        stopOnFailure,
      }, ctx.abortSignal)
    )
    // 验证步骤输出可能很长，只保留前几条摘要和截断标记。
    const { results: steps, truncated } = codingToolHelper.limitResults(run.steps, 6)
    return {
      ...run,
      steps,
      stepsTruncated: truncated,
    }
  },
})

/** 在工作区运行任意 shell 命令。 */
const runCommand = defineWorkspaceVelaTool<{
  command: string
  cwd?: string
  timeoutMs?: number
  background?: boolean
  maxOutputChars?: number
  parallel?: boolean
  allowRepeat?: boolean
}>({
  // 内部契约名必须与注册名一致:examples registry 按本名建键,按暴露名取示例的消费方会 miss。
  name: 'ws_run_command',
  role: 'execute',
  category: 'workspace-execute',
  summary: '在工作区中运行 shell 命令。',
  suitable: ['需要构建、测试、类型检查、lint、git 操作、包管理或启动 dev server。'],
  forbidden: ['不要用 shell find 替代已有路径发现，除非内置过滤不够或用户明确要求。'],
  protocol: ['命令可能长期运行或危险时等待确认；truncated=true 时补读输出或 logPath。'],
  usage: ['传 command；按需传 cwd、timeoutMs、background、maxOutputChars。'],
  examples: [
    // 常规：跑测试，设超时与输出预算
    { command: 'bun test', timeoutMs: 120000, maxOutputChars: 20000 },
    // 内联脚本快速验证
    { command: 'node -e "console.log(1+1)"', timeoutMs: 10000, maxOutputChars: 4000 },
    // 指定子目录 cwd 跑
    { command: 'node --test', cwd: 'packages/core', timeoutMs: 60000, maxOutputChars: 20000 },
    // 长驻进程（dev server）后台运行：background:true，超时只用于确认启动
    { command: 'npm run dev', background: true, timeoutMs: 5000, maxOutputChars: 8000 },
  ],
  notes: ['工作区内命令使用本工具；系统级或工作区外 shell 命令使用 bash。cwd 指向其他项目时会先进入或切换工作区并请求授权。'],
  schema: z.object({
    command: z.string().min(1).describe(
      parameterDescription({
        description: '要执行的 shell 命令。',
        usage: ['传完整命令字符串。'],
      })
    ),
    cwd: z.string().optional().describe(
      parameterDescription({
        description: '命令工作目录。',
        usage: ['可传绝对路径，或相对当前工作区的路径。'],
      })
    ),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(600000)
      .optional()
      .describe(
        parameterDescription({
          description: '命令超时时间。',
          usage: ['单位为毫秒。'],
          notes: ['最大 600000。'],
        })
      ),
    background: z
      .boolean()
      .optional()
      .describe(
        parameterDescription({
          description: '是否后台启动命令。',
          usage: ['适合 dev server、watcher 或端口转发。'],
        })
      ),
    maxOutputChars: z
      .number()
      .int()
      .positive()
      .max(50000)
      .optional()
      .describe(
        parameterDescription({
          description: '每路 stdout/stderr 最大返回字符数。',
          notes: ['默认 8000，最大 50000。'],
        })
      ),
    parallel: z
      .boolean()
      .optional()
      .describe(
        parameterDescription({
          description: '是否允许与其他独立短命令并发执行。',
          usage: ['只给彼此独立且短时的只读命令设为 true。'],
          notes: ['写文件、危险命令、长期服务或互相依赖的命令不要并发。'],
        })
      ),
    allowRepeat: z
      .boolean()
      .optional()
      .describe(
        parameterDescription({
          description: '是否允许重复运行同一验证命令。',
          notes: ['仅在用户明确要求重复验证时设为 true。'],
        })
      ),
  }),
  permissions: ['process:exec'],
  capabilities: defineWorkspaceToolCapability({
    effectKind: 'execute',
    readScopes: ['workspace', 'system'],
    filesystem: { read: 'workspace', write: 'workspace' },
    metadata: {
      workspace: {
        requiresActiveProject: true,
        requiresWorkspaceSwitchForExternalCwd: true,
        mutation: 'command-dependent',
        arbitraryRead: true,
      },
    },
    process: { execution: 'input-dependent' },
    concurrency: 'input-dependent',
    reason: 'workspace shell command execution',
  }),
  isConcurrencySafe: isParallelCommandExecutionSafe,
  execute: async ({ command, cwd, timeoutMs, background, maxOutputChars }, ctx) => {
    ctx.abortSignal.throwIfAborted()
    // 先做策略分析，判断是否危险、是否可能长期运行、涉及哪些端口。
    const plan = analyzeCommandExecution(command)
    const shouldRunInBackground =
      background || ((background ?? true) && plan.shouldStartInBackground)

    // 如果要后台启动，必须确认当前系统运行时允许 background commands。
    if (shouldRunInBackground && !ctx.system.canStartBackgroundCommands()) {
      throw new AppError('PERMISSION', '当前未允许模型启动长期运行的命令。')
    }

    // 默认放行普通命令和长期驻留命令；只拦截策略识别出的危险命令。
    // 用非终止型确认（awaitConfirmationDecision）：被拒时不炸掉整轮，而是把结构化的
    // "未执行/被拒 + 原因" 交回模型，让它能对用户解释并改策略，而不是干巴巴复述内部错误串。
    if (plan.isDangerous) {
      const decision = await ctx.approval.awaitConfirmationDecision(
        buildBackgroundCommandConfirmationMessage(
          command,
          plan,
          '当前工作区',
          shouldRunInBackground
        ),
        ctx.abortSignal,
        {
          approvalRisk: 'high',
          riskScope: 'workspace-command:dangerous',
        }
      )
      if (!decision.approved) return {
          approved: false,
          skipped: true,
          changed: false,
          command,
          dangerousReason: plan.dangerousReason,
          rejectionMessage: toOptional(decision.message),
          message: decision.message?.trim()
            ? `用户拒绝执行该危险命令，未运行。原因：${decision.message.trim()}`
            : '用户拒绝执行该危险命令，命令未运行。可以向用户说明并改用更安全的方式。',
        }
    }

    if (await shouldPrepareCommandWorkspaceMutation(ctx, command, cwd)) {
      const authorization = await prepareWorkspaceMutation(ctx, {
        cwd,
        operation: `运行可能修改文件的命令：${command}`,
      })
      if (authorization) return buildWorkspaceMutationSkippedResult(authorization)
    }

    const run = () =>
      ctx.workspace.runCommand(
        command,
        { timeoutMs, background: shouldRunInBackground, maxOutputChars },
        plan.isDangerous
      )
    // allowDangerous 参数来自策略分析，workspace 层据此决定是否放行危险命令。
    const result = cwd ? await runWithDirectory(ctx, cwd, run) : await run()
    if (!result.backgroundProcess) return result

    // 后台命令补充端口、原因和是否自动转后台，便于 UI 后续展示/停止。
    return {
      ...result,
      backgroundProcess: {
        ...result.backgroundProcess,
        ports: plan.ports,
        reason: plan.reason,
        autoStarted: plan.shouldStartInBackground && !background,
      },
    }
  },
})

/** 工作区执行类工具出口。 */
const codingExecuteTools = {
  ws_run_command: runCommand,
  run_verification_plan: runVerificationPlan,
}
export { codingExecuteTools }
