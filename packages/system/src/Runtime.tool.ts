import { z } from 'zod'

import { renderParameterDescription as parameterDescription } from '@velaros-ai/agent/tool-contract'
import { AppError } from '@velaros-ai/core/error'

import { SystemToolNames } from './system-tool-names'
import { defineSystemTool } from './Types'

// 刷新 shell 环境缓存，常在刚安装 CLI 或 PATH 变化后使用。
const refreshShellEnvironment = defineSystemTool<Record<string, never>>({
  name: SystemToolNames.refreshEnvironment,
  role: 'control',
  summary: '刷新登录 shell 环境缓存。',
  suitable: [
      '刚安装 CLI、修改 shell 配置或发现 PATH 中缺少命令后重新加载环境。',
      '需要让后续系统命令看到最新 PATH 和环境变量。',
    ],
  forbidden: [
      '不要把它当作命令存在性检查；检查命令可用性用 bash 工具（Windows 用 where，macOS/Linux 用 command -v）。',
      '不要在宿主环境未允许刷新 shell 时反复调用。',
    ],
  protocol: [
      '先确认缺失命令或 PATH 变化，再刷新 shell 环境。',
      '刷新后用 bash 工具按宿主 shell 语法验证目标命令是否可见。',
    ],
  usage: ['调用时传空对象。'],
  examples: [{}],
  notes: ['刷新结果取决于宿主 system provider；不保证修改用户 shell 配置文件。'],
  schema: z.object({}),
  permissions: [],
  capabilities: {
    effectKind: 'write',
    readScopes: ['system'],
    writeScopes: ['system'],
    filesystem: { read: 'none', write: 'none' },
    canReadArbitrarySource: false,
    concurrency: 'unsafe',
    reason: 'refresh host shell environment cache',
  },
  isConcurrencySafe: () => false,
  execute: async (_input, ctx) => {
    if (!ctx.system.canRefreshShellEnvironment()) {
      // 部分宿主环境不允许主动刷新登录 shell，需要显式阻止。
      throw new AppError('PERMISSION', '当前未允许模型主动刷新 shell 环境。')
    }

    // 由 system provider 重新加载 PATH 和 shell 环境变量。
    return ctx.system.refreshShellEnvironment()
  },
})

// 列出当前产品启动过的后台任务，用于追踪 dev server/watch 命令是否还活着。
const listBackgroundTasks = defineSystemTool<{
  limit?: number
  onlyRunning?: boolean
  taskId?: string
}>({
  name: SystemToolNames.listTasks,
  role: 'inspect',
  summary: '列出后台任务。',
  suitable: ['查 dev server、watcher 或长任务状态。'],
  forbidden: ['不要查系统全部进程。'],
  usage: ['传 taskId 精确查询 system:run 返回的后台任务；或传 limit/onlyRunning 查看任务列表。'],
  examples: [
    // 全部后台任务（含已结束）
    {},
    // 只看还在运行的
    { onlyRunning: true },
    // 精确查询 system:run 返回的后台任务
    { taskId: 'task-abc123' },
  ],
  notes: ['只返回产品记录；不要把 system:run 的 taskId 交给 job:*。'],
  schema: z.object({
    limit: z.number().int().positive().max(100).optional().describe(
      parameterDescription({
        description: '最多返回数量。',
      })
    ),
    onlyRunning: z.boolean().optional().describe(
      parameterDescription({
        description: '是否只返回运行中任务。',
      })
    ),
    taskId: z.string().min(1).max(120).optional().describe(
      parameterDescription({
        description: '精确后台任务 id；取自 system:run 的 backgroundProcess.taskId。',
      })
    ),
  }),
  permissions: [],
  capabilities: {
    effectKind: 'read',
    readScopes: ['system'],
    filesystem: { read: 'none', write: 'none' },
    canReadArbitrarySource: false,
    concurrency: 'safe',
    reason: 'managed system background task inspection',
  },
  isConcurrencySafe: () => true,
  execute: async ({ limit, onlyRunning, taskId }, ctx) => {
    // onlyRunning 可过滤掉已结束的历史任务。
    const tasks = await ctx.system.listBackgroundTasks({
      limit: taskId ? undefined : limit,
      onlyRunning,
      taskId,
    })

    return {
      // count 给调用方提供轻量摘要。
      count: tasks.length,
      tasks,
    }
  },
})

// 终止当前产品记录的受管后台任务。
const terminateBackgroundTask = defineSystemTool<{
  taskId: string
  force?: boolean
}>({
  name: SystemToolNames.terminateTask,
  role: 'control',
  summary: '终止后台任务。',
  suitable: ['后台任务不再需要或卡住。'],
  forbidden: ['不要猜 taskId。'],
  usage: ['传 taskId；强制时传 force=true。'],
  examples: [
    // 正常终止
    { taskId: 'task-abc123' },
    // 卡住时强制杀
    { taskId: 'task-abc123', force: true },
  ],
  notes: ['仅限当前会话可控任务。'],
  schema: z.object({
    taskId: z.string().min(1).max(120).describe(
      parameterDescription({
        description: '后台任务 id。',
        usage: ['取自 system:list-tasks 返回的任务条目，不要自己编。'],
      })
    ),
    force: z.boolean().optional().describe(
      parameterDescription({
        description: '是否强制终止。',
        notes: ['默认优雅停止；进程无响应时传 true 强杀。'],
      })
    ),
  }),
  permissions: ['process:exec'],
  capabilities: {
    effectKind: 'execute',
    readScopes: ['system'],
    writeScopes: ['system'],
    filesystem: { read: 'none', write: 'none' },
    canReadArbitrarySource: false,
    concurrency: 'unsafe',
    reason: 'terminate managed background task',
  },
  isConcurrencySafe: () => false,
  execute: async ({ taskId, force }, ctx) => {
    ctx.abortSignal.throwIfAborted()

    return ctx.system.terminateBackgroundTask({ taskId, force })
  },
})

const systemRuntimeTools = Object.freeze({
  [SystemToolNames.refreshEnvironment]: refreshShellEnvironment,
  [SystemToolNames.listTasks]: listBackgroundTasks,
  [SystemToolNames.terminateTask]: terminateBackgroundTask,
})
export { systemRuntimeTools }
