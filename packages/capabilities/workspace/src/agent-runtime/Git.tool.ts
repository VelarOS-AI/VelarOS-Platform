import { z } from 'zod'

import { toNullable } from '@velaros-ai/core'
import {
  renderParameterDescription as parameterDescription,
} from '@velaros-ai/core/utils/ToolDescription'

import { isGitToolAvailable, runWithDirectory } from './Helpers'
import { defineWorkspaceToolCapability } from './KernelToolShared'
import { defineWorkspaceVelaTool } from './workspaceToolMiddleware'

// readChangedFiles / listChangedFiles 工具实现已删除（审查报告 m12 死代码清理）：
// 它们既没在 codingGitTools 注册表里登记，也没有被任何上层 re-export，确认为零引用。
// 现存的模型链路通过 git_status / git_diff / 读文件能力组合表达同样能力；如需恢复，
// 请同步在 codingGitTools 中登记并在 i18n / 类别配置里加上对应入口。

/** 获取 Git 工作树状态。 */
const gitStatus = defineWorkspaceVelaTool<{ cwd?: string }>({
  name: 'git_status',
  role: 'inspect',
  category: 'workspace-inspect',
  summary: '返回当前工作区 Git 状态。',
  suitable: ['需要确认当前分支、追踪信息或工作区是否 clean。'],
  forbidden: ['不要用它查看具体 diff 内容。'],
  usage: ['可传 cwd 检查子项目。'],
  examples: [{}],
  notes: ['具体改动内容用 git_diff。'],
  schema: z.object({
    cwd: z.string().optional().describe(
      parameterDescription({
        description: '项目目录。',
        usage: ['可传绝对路径，或相对当前工作区的路径。'],
      })
    ),
  }),
  permissions: ['process:exec'],
  capabilities: defineWorkspaceToolCapability({
    effectKind: 'read',
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
    process: { execution: 'short' },
    concurrency: 'safe',
    reason: 'git status inspection',
  }),
  isAvailable: isGitToolAvailable,
  isConcurrencySafe: () => true,
  execute: async ({ cwd }, ctx) => {
    ctx.abortSignal.throwIfAborted()
    return runWithDirectory(ctx, cwd, async () => {
      const status = await ctx.workspace.getGitStatus()
      const sandbox = ctx.workspaceSandbox?.current
      if (!sandbox) return status
      return {
        ...status,
        executionRootBranch: status.branch,
        sourceRootBranch: toNullable(sandbox.sourceBranch),
        sourceRootHead: toNullable(sandbox.baseFingerprint?.sourceHead),
      }
    })
  },
})

/** 读取工作树或暂存区 diff。 */
const gitDiff = defineWorkspaceVelaTool<{
  cwd?: string
  staged?: boolean
  path?: string
  maxChars?: number
}>({
  name: 'git_diff',
  role: 'inspect',
  category: 'workspace-inspect',
  summary: '显示工作区或指定路径的 Git diff。',
  suitable: ['需要查看工作树或暂存区具体改动。'],
  forbidden: ['不要用它查看提交历史；提交历史用 get_git_commits 或命令。'],
  usage: ['可传 staged、path、maxChars 和 cwd。'],
  examples: [
    // 工作树全部改动
    { maxChars: 20000 },
    // 暂存区（已 git add）的改动
    { staged: true, maxChars: 20000 },
    // 只看某个文件/目录的 diff
    { path: 'src/app.ts' },
  ],
  notes: ['staged=true 时读取暂存区 diff。'],
  schema: z.object({
    cwd: z.string().optional().describe(
      parameterDescription({
        description: '项目目录。',
        usage: ['可传绝对路径，或相对当前工作区的路径。'],
      })
    ),
    staged: z.boolean().optional().describe(
      parameterDescription({
        description: '是否读取暂存区 diff。',
        notes: ['省略或 false 时读取工作树 diff。'],
      })
    ),
    path: z.string().optional().describe(
      parameterDescription({
        description: '限定 diff 的文件或目录路径。',
        usage: ['传相对工作区根目录的路径。'],
      })
    ),
    maxChars: z
      .number()
      .int()
      .positive()
      .max(200000)
      .optional()
      .describe(
        parameterDescription({
          description: 'diff 最大返回字符数。',
          notes: ['超过上限的输出由 workspace 层截断并标记。'],
        })
      ),
  }),
  permissions: ['process:exec'],
  capabilities: defineWorkspaceToolCapability({
    effectKind: 'read',
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
    process: { execution: 'short' },
    concurrency: 'safe',
    reason: 'git diff inspection',
  }),
  isAvailable: isGitToolAvailable,
  isConcurrencySafe: () => true,
  execute: async ({ cwd, staged, path, maxChars }, ctx) => {
    ctx.abortSignal.throwIfAborted()
    // maxChars 由 workspace 层裁剪，并在结果里提示是否截断。
    return runWithDirectory(ctx, cwd, () => ctx.workspace.getGitDiff({ staged, path, maxChars }))
  },
})

/**
 * Git 检查类工具出口。
 *
 * 这两个工具的 permissions 包含 process:exec（底层通过 git 子进程实现），
 * 因此被归到 workspace-inspect 类别后仍需要 process:exec 授权。
 */
const codingGitTools = {
  git_status: gitStatus,
  git_diff: gitDiff,
}
export { codingGitTools }
