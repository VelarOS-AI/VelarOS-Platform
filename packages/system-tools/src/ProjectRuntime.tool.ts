import { z } from 'zod'

import { renderParameterDescription as parameterDescription } from '@velaros-ai/core/utils/ToolDescription'

import type { DevEnvironmentSection } from './Helpers'
import {
  devEnvironmentSectionSchema,
  filterDevEnvironmentSummary,
  optionalProjectDiscoveryLimit,
  projectDiscoveryScanBaseSchema,
} from './Helpers'
import { defineSystemTool } from './Types'


// 将当前系统进程尽量归属到项目，帮助判断某个 dev server 属于哪个仓库。
const associateProcessesWithProjects = defineSystemTool<{
  limit?: number
  pid?: number
  name?: string
  commandContains?: string
  onlyCurrentUser?: boolean
  includeUnmatched?: boolean
  rootPaths?: string[]
  maxDepth?: number
  excludeNames?: string[]
  refresh?: boolean
}>({
  name: 'associate_processes_with_projects',
  role: 'inspect',
  summary: '将本机进程关联到项目。',
  suitable: [
      '判断某个 dev server 或进程属于哪个仓库。',
      '需要按 pid、进程名或命令关键字筛选进程并查看 evidence。',
    ],
  forbidden: [
      '不要用它杀进程或修改进程状态。',
      '不要把低置信关联当作用户确认的项目选择。',
    ],
  usage: ['传 pid、name 或 commandContains 收窄进程；必要时限定 rootPaths。'],
  examples: [{ commandContains: "vite", limit: 20 }],
  notes: ['匹配基于 cwd、端口、后台任务和项目扫描结果。'],
  schema: z.object({
    limit: z.number().int().positive().max(100).optional().describe(
      parameterDescription({
        description: '最多返回的进程关联数。',
        usage: ['用于限制返回体积，最大 100。'],
      })
    ),
    pid: z.number().int().positive().optional().describe(
      parameterDescription({
        description: '进程 pid 过滤器。',
        usage: ['只分析指定进程。'],
      })
    ),
    name: z.string().min(1).optional().describe(
      parameterDescription({
        description: '进程名过滤器。',
        usage: ['按进程名模糊过滤。'],
      })
    ),
    commandContains: z.string().min(1).optional().describe(
      parameterDescription({
        description: '命令行关键字过滤器。',
        usage: ['按进程命令文本模糊过滤。'],
      })
    ),
    onlyCurrentUser: z.boolean().optional().describe(
      parameterDescription({
        description: '是否只看当前用户进程。',
        usage: ['排除其他用户进程时传 true。'],
      })
    ),
    includeUnmatched: z.boolean().optional().describe(
      parameterDescription({
        description: '是否保留未匹配项目的进程。',
        usage: ['需要完整排查进程列表时传 true。'],
      })
    ),
    ...projectDiscoveryScanBaseSchema,
  }),
  permissions: ['fs:read', 'process:exec'],
  isConcurrencySafe: () => true,
  execute: async (
    {
      limit,
      pid,
      name,
      commandContains,
      onlyCurrentUser,
      includeUnmatched,
      rootPaths,
      maxDepth,
      excludeNames,
      refresh,
    },
    ctx
  ) => {
    // 系统层会综合进程 cwd、后台任务记录、端口和项目扫描结果生成 evidence。
    const associations = await ctx.system.associateProcessesWithProjects({
      limit,
      pid,
      name,
      commandContains,
      onlyCurrentUser,
      includeUnmatched,
      rootPaths,
      maxDepth,
      excludeNames,
      refresh,
    })

    return {
      // associations 中可能包含未匹配项，取决于 includeUnmatched。
      count: associations.length,
      associations,
    }
  },
})

// 汇总当前开发现场，默认只返回高信号字段，避免普通调用过重。
const summarizeCurrentDevEnvironment = defineSystemTool<{
  rootPaths?: string[]
  maxDepth?: number
  limit?: number
  excludeNames?: string[]
  refresh?: boolean
  logLimit?: number
  processLimit?: number
  portLimit?: number
  sections?: DevEnvironmentSection[]
}>({
  name: 'summarize_current_dev_environment',
  role: 'inspect',
  summary: '汇总当前开发现场。',
  suitable: [
      '需要快速判断当前可能在做哪个项目以及下一步风险。',
      '需要把项目、进程、端口、日志和系统指标合成摘要。',
    ],
  forbidden: [
      '不要用它替代针对性排障；已知端口、pid 或项目时用更具体工具。',
      '不要把默认摘要当作完整上下文；需要明细时传 sections。',
    ],
  usage: ['默认返回 headline、project、risks、nextStep；传 sections 控制板块。'],
  examples: [{ sections: ["project", "ports", "risks", "nextStep"] }],
  notes: ['sections 为空时使用高信号默认板块。'],
  schema: z.object({
    ...projectDiscoveryScanBaseSchema,
    limit: optionalProjectDiscoveryLimit('项目发现与活跃度推断时的候选项目数量'),
    logLimit: z
      .number()
      .int()
      .positive()
      .max(20)
      .optional()
      .describe(
        parameterDescription({
          description: '摘要中的日志数量上限。',
          usage: ['需要日志板块时设置，最大 20。'],
        })
      ),
    processLimit: z
      .number()
      .int()
      .positive()
      .max(20)
      .optional()
      .describe(
        parameterDescription({
          description: '摘要中的进程数量上限。',
          usage: ['需要进程板块时设置，最大 20。'],
        })
      ),
    portLimit: z
      .number()
      .int()
      .positive()
      .max(30)
      .optional()
      .describe(
        parameterDescription({
          description: '端口采样数量上限。',
          usage: ['没有明确项目上下文时用于限制监听端口采样。'],
        })
      ),
    sections: z
      .array(devEnvironmentSectionSchema)
      .max(11)
      .optional()
      .describe(
        parameterDescription({
          description: '摘要板块白名单。',
          values: [
            'all：返回全部板块。',
            'headline：返回一句话概览。',
            'project：返回活跃项目推断。',
            'projectContext：返回项目上下文。',
            'metrics：返回系统指标。',
            'processes：返回相关进程。',
            'tasks：返回后台任务。',
            'ports：返回监听端口。',
            'logs：返回最近日志。',
            'risks：返回风险。',
            'nextStep：返回下一步建议。',
          ],
          usage: ['省略时返回默认高信号板块。'],
        })
      ),
  }),
  permissions: ['fs:read', 'process:exec'],
  isConcurrencySafe: () => true,
  execute: async (
    {
      rootPaths,
      maxDepth,
      limit,
      excludeNames,
      refresh,
      logLimit,
      processLimit,
      portLimit,
      sections,
    },
    ctx
  ) => {
    // 先让系统层收集完整摘要，再由 filterDevEnvironmentSummary 按 sections 裁剪。
    const summary = await ctx.system.summarizeCurrentDevEnvironment({
      rootPaths,
      maxDepth,
      limit,
      excludeNames,
      refresh,
      logLimit,
      processLimit,
      portLimit,
    })

    // sections 为空时会使用 helper 中定义的默认板块。
    return filterDevEnvironmentSummary(summary, sections)
  },
})

// 面向排障的一站式诊断：可围绕项目路径、端口或 pid 收集运行态证据。
const diagnoseDevRuntime = defineSystemTool<{
  path?: string
  port?: number
  pid?: number
  rootPaths?: string[]
  maxDepth?: number
  limit?: number
  excludeNames?: string[]
  refresh?: boolean
}>({
  name: 'diagnose_dev_runtime',
  role: 'inspect',
  summary: '诊断开发运行态问题。',
  suitable: [
      '围绕项目路径、端口或 pid 收集排障证据。',
      '需要一次性查看进程、端口、后台任务、日志、指标和建议。',
    ],
  forbidden: [
      '不要用它修改项目或重启服务；本工具只诊断。',
      '不要在已有明确失败日志时替代直接读取日志和运行验证命令。',
    ],
  usage: ['传 path、port 或 pid 作为诊断锚点；没有锚点时结合项目发现参数推断。'],
  examples: [{ port: 5173, limit: 5 }],
  notes: ['诊断结果是建议和证据集合，不会自动执行修复。'],
  schema: z.object({
    path: z
      .string()
      .optional()
      .describe(
        parameterDescription({
          description: '诊断锚点项目路径。',
          usage: ['传绝对路径或相对于当前 active root 的路径。'],
        })
      ),
    port: z.number().int().positive().max(65535).optional().describe(
      parameterDescription({
        description: '诊断锚点端口。',
        usage: ['服务端口已知时传入。'],
      })
    ),
    pid: z.number().int().positive().optional().describe(
      parameterDescription({
        description: '诊断锚点进程 pid。',
        usage: ['目标进程已知时传入。'],
      })
    ),
    ...projectDiscoveryScanBaseSchema,
    limit: optionalProjectDiscoveryLimit('项目发现与活跃度推断时的候选项目数量'),
  }),
  permissions: ['fs:read', 'process:exec'],
  isConcurrencySafe: () => true,
  execute: async ({ path, port, pid, rootPaths, maxDepth, limit, excludeNames, refresh }, ctx) =>
    // 诊断逻辑在系统层统一实现，便于跨工具复用相同的项目/端口/日志关联算法。
    ctx.system.diagnoseDevRuntime({
      path,
      port,
      pid,
      rootPaths,
      maxDepth,
      limit,
      excludeNames,
      refresh,
    }),
})

// 项目运行态工具注册表，供 systemProjectTools 聚合。
const systemProjectRuntimeTools = {
  associate_processes_with_projects: associateProcessesWithProjects,
  summarize_current_dev_environment: summarizeCurrentDevEnvironment,
  diagnose_dev_runtime: diagnoseDevRuntime,
}
export { systemProjectRuntimeTools }
