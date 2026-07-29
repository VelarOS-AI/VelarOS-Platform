import { z } from 'zod'

import { renderParameterDescription as parameterDescription } from '@velaros-ai/core/utils/ToolDescription'

import type { ProjectContextInclude } from './Helpers'
import {
  filterProjectContextSummary,
  optionalProjectDiscoveryLimit,
  projectContextIncludeSchema,
  projectDiscoveryScanBaseSchema,
} from './Helpers'
import { defineSystemTool } from './Types'

// 扫描本机目录并识别项目候选，返回项目类型、包管理器、Git 等摘要信息。
const discoverProjects = defineSystemTool<{
  rootPaths?: string[]
  maxDepth?: number
  limit?: number
  excludeNames?: string[]
  refresh?: boolean
}>({
  name: 'discover_projects',
  role: 'inspect',
  summary: '扫描目录并识别项目候选。',
  suitable: [
      '探索未知目录下有哪些项目仓库或列出候选项目清单。',
      '查找从未打开过、没有命令历史的新项目。',
    ],
  forbidden: [
      '不要用它判断最近活跃项目；最近活跃排序用 list_recent_projects。',
      '不要在没有 rootPaths 或 maxDepth 约束时做过大的磁盘扫描。',
    ],
  protocol: [
      '先根据用户线索设置 rootPaths；未知位置再使用默认开发目录。',
      '用 maxDepth 和 excludeNames 控制扫描成本；需要最新磁盘状态时传 refresh=true。',
    ],
  usage: ['传 rootPaths、maxDepth、limit 收窄扫描范围；返回 count 和 projects。'],
  examples: [{ rootPaths: ['/projects'], maxDepth: 2, limit: 20 }],
  notes: ['结果基于目录 marker 和文件时间，不代表最近活跃度。'],
  schema: z.object({
    ...projectDiscoveryScanBaseSchema,
    limit: optionalProjectDiscoveryLimit('最多返回多少个项目'),
  }),
  permissions: ['fs:read'],
  isConcurrencySafe: () => true,
  execute: async ({ rootPaths, maxDepth, limit, excludeNames, refresh }, ctx) => {
    // 实际扫描策略在 system provider 内实现，这里只负责透传过滤参数。
    const projects = await ctx.system.discoverProjects({
      rootPaths,
      maxDepth,
      limit,
      excludeNames,
      refresh,
    })

    return {
      // count 方便调用方在不展开 projects 时也能判断是否发现结果。
      count: projects.length,
      projects,
    }
  },
})

// 按活跃度列出最近项目，比纯扫描更适合“我刚才在哪个项目里干活”这类场景。
const listRecentProjects = defineSystemTool<{
  rootPaths?: string[]
  maxDepth?: number
  limit?: number
  excludeNames?: string[]
  refresh?: boolean
}>({
  name: 'list_recent_projects',
  role: 'inspect',
  summary: '按近期使用痕迹列出活跃项目。',
  suitable: [
      '任务开头需要根据最近命令、后台任务或 Git 改动选择最可能相关的项目。',
      '用户说“刚才那个项目”或“最近在改的仓库”时找候选。',
    ],
  forbidden: [
      '不要用它列全量项目；列全量候选用 discover_projects。',
      '不要把最高分结果直接当用户确认；需要修改前仍应核对项目路径。',
    ],
  protocol: [
      '先读取最近项目候选和 evidence，再根据用户任务选择目标项目。',
      '修改项目文件前必须进入或切换到确认后的项目工作区。',
    ],
  usage: ['传 limit 控制候选数量；需要限定目录时传 rootPaths 和 maxDepth。'],
  examples: [{ limit: 5 }],
  notes: ['score 是启发式活跃度，不是用户明确授权。'],
  schema: z.object({
    ...projectDiscoveryScanBaseSchema,
    limit: optionalProjectDiscoveryLimit('最多返回多少个项目'),
  }),
  permissions: ['fs:read'],
  isConcurrencySafe: () => true,
  execute: async ({ rootPaths, maxDepth, limit, excludeNames, refresh }, ctx) => {
    // 活跃度排序由系统层综合命令历史、后台任务、Git 改动和文件时间完成。
    const projects = await ctx.system.listRecentProjects({
      rootPaths,
      maxDepth,
      limit,
      excludeNames,
      refresh,
    })

    return {
      // 保留 count，减少调用方为了得到数量而遍历数组。
      count: projects.length,
      projects,
    }
  },
})

// 根据最近活动推断当前最可能相关的项目，通常用于没有明确 cwd 的任务开头。
const inferActiveProject = defineSystemTool<{
  rootPaths?: string[]
  maxDepth?: number
  limit?: number
  excludeNames?: string[]
  refresh?: boolean
}>({
  name: 'infer_active_project',
  role: 'inspect',
  summary: '推断当前最可能相关的项目。',
  suitable: [
      '用户没有明确项目路径，但当前任务需要判断最可能相关的仓库。',
      '需要一个首选项目和备选项目，以及可解释的 evidence。',
    ],
  forbidden: [
      '不要在用户已明确指定项目路径时覆盖用户选择。',
      '不要把推断结果当作 Workspace 授权或自动切换；项目选择由产品的 Workspace 能力处理。',
    ],
  protocol: [
      '先推断项目并检查 confidence/evidence。',
      '置信度不足或多个候选接近时，向用户确认或列出备选。',
    ],
  usage: ['传 limit 控制候选数量；需要限定范围时传 rootPaths。'],
  examples: [{ limit: 5 }],
  notes: ['返回值用于决策辅助，不会自动切换 workspace。'],
  schema: z.object({
    ...projectDiscoveryScanBaseSchema,
    limit: optionalProjectDiscoveryLimit('用于推断的候选项目数量'),
  }),
  permissions: ['fs:read'],
  isConcurrencySafe: () => true,
  execute: async ({ rootPaths, maxDepth, limit, excludeNames, refresh }, ctx) =>
    // 返回值通常包含候选项目和证据，便于调用方解释为什么选中该项目。
    ctx.system.inferActiveProject({
      rootPaths,
      maxDepth,
      limit,
      excludeNames,
      refresh,
    }),
})

// 获取单个项目的统一上下文：Git、改动文件、后台任务、端口和最近命令等。
const getProjectContext = defineSystemTool<{
  path?: string
  include?: ProjectContextInclude[]
}>({
  name: 'get_project_context',
  role: 'inspect',
  summary: '获取项目运行与版本控制上下文。',
  suitable: [
      '需要一次性了解项目 Git 状态、改动文件、后台任务、端口和最近命令。',
      '需要按 include 裁剪项目上下文字段，减少返回体大小。',
  ],
  forbidden: [
      '不要用它读取项目文件正文；文件内容用 ws_read。',
      '不要把不传 path 的自动推断当作用户明确选择。',
    ],
  protocol: [
      '已知项目路径时传 path；未知时允许系统推断并检查 found 和 summary。',
      '只需要少数字段时传 include，避免返回过多运行态信息。',
    ],
  usage: ['传 path 获取指定项目上下文；传 include 白名单裁剪返回字段。'],
  examples: [{ path: "/repo", include: ["git", "changedFiles"] }],
  notes: ['include 只裁剪返回值，不改变系统层采集上下文的方式。'],
  schema: z.object({
    path: z
      .string()
      .optional()
      .describe(
        parameterDescription({
          description: '项目路径。',
          usage: ['传绝对路径或相对于当前 active root 的路径。'],
          notes: ['省略时尝试推断活跃项目。'],
        })
      ),
    include: z
      .array(projectContextIncludeSchema)
      .max(12)
      .optional()
      .describe(
        parameterDescription({
          description: '返回字段白名单。',
          values: [
            'all：返回全部上下文字段。',
            'project：返回项目基础信息。',
            'git：gitStatus 的简写。',
            'gitStatus：返回 Git 状态摘要。',
            'changedFiles：返回改动文件列表。',
            'runningTasks：返回相关后台任务。',
            'openPorts：返回相关监听端口。',
            'recentCommandRuns：返回最近命令运行。',
            'recentFailedCommandRuns：返回最近失败命令。',
            'commands：recentCommandRuns 的简写。',
            'failedCommands：recentFailedCommandRuns 的简写。',
            'suggestedNextStep：返回建议下一步。',
          ],
          usage: ['省略时返回完整上下文。'],
        })
      ),
  }),
  permissions: ['fs:read', 'process:exec'],
  isConcurrencySafe: () => true,
  execute: async ({ path, include }, ctx) => {
    // path 为空时由系统层自动推断当前活跃项目。
    const summary = await ctx.system.getProjectContext({ path })

    return {
      found: !!summary,
      // include 只做返回字段裁剪，不影响系统层采集的上下文完整性。
      summary: summary ? filterProjectContextSummary(summary, include) : summary,
    }
  },
})

// 项目发现相关工具的注册表，供上层 SystemTools 聚合。
const systemProjectDiscoveryTools = {
  discover_projects: discoverProjects,
  list_recent_projects: listRecentProjects,
  infer_active_project: inferActiveProject,
  get_project_context: getProjectContext,
}
export { systemProjectDiscoveryTools }
