import { z } from 'zod'

import { isEmpty } from '@velaros-ai/core'
import { renderParameterDescription as parameterDescription } from '@velaros-ai/core/utils/ToolDescription'
import {
  requiredNonNegativeMaxDepth,
  requiredResultLimit,
} from '@velaros-ai/core/utils/ToolInputBounds'

import type { SystemDevEnvironmentSummary, SystemProjectContextSummary } from './SystemContracts'
import type { ToolContext } from './Types'


// get_project_context 的 include 白名单，控制返回摘要中要保留哪些大字段。
export const projectContextIncludeSchema = z.enum([
  'all',
  'project',
  'git',
  'gitStatus',
  'changedFiles',
  'runningTasks',
  'openPorts',
  'recentCommandRuns',
  'recentFailedCommandRuns',
  'commands',
  'failedCommands',
  'suggestedNextStep',
])

export type ProjectContextInclude = z.infer<typeof projectContextIncludeSchema>

const PROJECT_CONTEXT_INCLUDE_FIELD_ENTRIES = [
  { field: 'project', include: ['project'] },
  { field: 'gitStatus', include: ['git', 'gitStatus'] },
  { field: 'changedFiles', include: ['changedFiles'] },
  { field: 'runningTasks', include: ['runningTasks'] },
  { field: 'openPorts', include: ['openPorts'] },
  { field: 'recentCommandRuns', include: ['recentCommandRuns', 'commands'] },
  { field: 'recentFailedCommandRuns', include: ['recentFailedCommandRuns', 'failedCommands'] },
  { field: 'suggestedNextStep', include: ['suggestedNextStep'] },
] as const satisfies ReadonlyArray<{
  field: keyof SystemProjectContextSummary
  include: readonly ProjectContextInclude[]
}>

// summarize_current_dev_environment 的 sections 白名单，避免默认返回过大的运行态摘要。
export const devEnvironmentSectionSchema = z.enum([
  'all',
  'headline',
  'project',
  'projectContext',
  'metrics',
  'processes',
  'tasks',
  'ports',
  'logs',
  'risks',
  'nextStep',
])

export type DevEnvironmentSection = z.infer<typeof devEnvironmentSectionSchema>

// 开发环境摘要默认只返回最有决策价值的部分：标题、项目、风险和下一步。
const DEFAULT_DEV_ENVIRONMENT_SECTIONS: DevEnvironmentSection[] = [
  'headline',
  'project',
  'risks',
  'nextStep',
]

const DEV_ENVIRONMENT_SECTION_FIELD_MAP = {
  headline: 'headline',
  project: 'activeProject',
  projectContext: 'projectContext',
  metrics: 'systemMetrics',
  processes: 'relatedProcesses',
  tasks: 'runningTasks',
  ports: 'openPorts',
  logs: 'recentLogs',
  risks: 'risks',
  nextStep: 'suggestedNextStep',
} as const satisfies Record<
  Exclude<DevEnvironmentSection, 'all'>,
  keyof SystemDevEnvironmentSummary
>

// 项目发现/扫描工具共用的根目录、深度、黑名单与缓存刷新参数。
export const projectDiscoveryScanBaseSchema = {
  rootPaths: z
    .array(z.string().min(1))
    .max(20)
    .optional()
    .describe(
      parameterDescription({
        description: '扫描根目录列表。',
        usage: ['传本机目录路径；省略时扫描常见开发目录。'],
      })
    ),
  maxDepth: z
    .number()
    .int()
    .min(0)
    .max(12)
    .optional()
    .describe(
      parameterDescription({
        description: '单次扫描递归深度。',
        usage: [
          '从每个 rootPath 向下递归的层数，取值 0 到 12；省略时使用系统默认值。',
          '只影响本次返回范围，需要更深层级时可换 rootPaths 或增大 maxDepth 再次调用。',
        ],
      })
    ),
  excludeNames: z
    .array(z.string().min(1))
    .max(40)
    .optional()
    .describe(
      parameterDescription({
        description: '要跳过的目录名。',
        usage: ['传目录名而不是路径；扫描时直接跳过。'],
      })
    ),
  refresh: z.boolean().optional().describe(
    parameterDescription({
      description: '是否强制刷新扫描结果。',
      usage: ['需要最新磁盘状态时传 true。'],
    })
  ),
}

/** 项目发现类工具的可选结果上限；不同工具可传入各自的 describe 文案。 */
export function optionalProjectDiscoveryLimit(description: string) {
  return z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe(
      parameterDescription({
        description,
        usage: ['用于限制候选项目数量，最大 100。'],
      })
    )
}

// 全局搜索工具共用的基础 schema；路径搜索和内容搜索都会复用这些过滤条件。
export const globalSearchBaseSchema = {
  query: z
    .string()
    .min(1)
    .describe(
      parameterDescription({
        description: '搜索关键词。',
        usage: ['paths 模式匹配路径片段；content 模式匹配正文子串或正则。'],
        notes: ['目录名请用 paths 模式。'],
      })
    ),
  rootPath: z
    .string()
    .optional()
    .describe(
      parameterDescription({
        description: '搜索起点。',
        usage: ['传绝对路径，或相对于当前 active root 的路径。'],
        notes: ['省略时优先使用当前 active root；没有 active root 时才从用户主目录开始。'],
      })
    ),
  limit: requiredResultLimit(
    200,
    parameterDescription({
      description: '最多返回的搜索结果数。',
      usage: ['用于限制返回体积。'],
    })
  ),
  maxDepth: requiredNonNegativeMaxDepth(
    16,
    parameterDescription({
      description: '目录递归深度。',
      usage: ['从 rootPath 向下递归；仓库内路径搜索通常需要 8 或更大。'],
      notes: ['过小会漏掉深层匹配。'],
    })
  ),
  entryTypes: z
    .array(z.enum(['file', 'directory']))
    .max(2)
    .optional()
    .describe(
      parameterDescription({
        description: '路径结果类型过滤。',
        values: ['file：只返回文件。', 'directory：只返回目录。'],
        usage: ['省略时同时返回文件和目录。'],
      })
    ),
  pathMatchMode: z
    .enum(['contains', 'exact', 'fuzzy'])
    .optional()
    .describe(
      parameterDescription({
        description: '路径匹配方式。',
        values: [
          'contains：路径包含 query。',
          'exact：路径精确匹配 query。',
          'fuzzy：按模糊评分匹配路径。',
        ],
        usage: ['省略时默认 fuzzy。'],
      })
    ),
  extensions: z
    .array(z.string().min(1))
    .max(20)
    .optional()
    .describe(
      parameterDescription({
        description: '文件扩展名过滤器。',
        usage: ['传不带点的扩展名，例如 ts、tsx、md、py。'],
        notes: ['对目录结果不生效。'],
      })
    ),
  caseSensitive: z.boolean().optional().describe(
    parameterDescription({
      description: '内容搜索是否区分大小写。',
      usage: ['mode=content 时使用。'],
    })
  ),
  regex: z.boolean().optional().describe(
    parameterDescription({
      description: '是否把 query 当作正则表达式。',
      usage: ['mode=content 时使用。'],
    })
  ),
  includeHidden: z.boolean().optional().describe(
    parameterDescription({
      description: '是否包含隐藏文件和目录。',
      usage: ['需要搜索点文件或隐藏目录时传 true。'],
    })
  ),
  unrestricted: z
    .boolean()
    .optional()
    .describe(
      parameterDescription({
        description: '是否放开系统搜索跳过规则。',
        usage: ['用户明确要求搜索 Library、node_modules 等默认跳过目录时传 true。'],
        notes: ['可能显著增加搜索成本。'],
      })
    ),
}

// 构建系统能力概览；compact 模式只保留用户最常需要看的工作区和能力位。
export function buildSystemOverview(ctx: ToolContext, compact: boolean) {
  const overview = ctx.system.getOverview()
  // capabilities 是从 provider 能力反推的统一布尔摘要，调用方不需要理解 provider 细节。
  const capabilities = {
    canOpenPath: overview.providers.some((provider) => provider.capabilities.includes('open-path')),
    canRevealPath: overview.providers.some((provider) =>
      provider.capabilities.includes('reveal-path')
    ),
    canOpenApplication: overview.providers.some((provider) =>
      provider.capabilities.includes('open-application')
    ),
    canRunCommands: true,
    canRefreshShellEnvironment: ctx.system.canRefreshShellEnvironment(),
    canStartBackgroundCommands: ctx.system.canStartBackgroundCommands(),
  }

  if (compact) {
    // 紧凑概览减少 provider/root 噪声，适合工具选择阶段快速判断能力。
    return {
      compact: true,
      workspace: {
        activeRoot: overview.activeWorkspaceRoot,
        browserSiteContext: overview.browserSiteContext,
      },
      shellEnvironment: {
        canRefresh: capabilities.canRefreshShellEnvironment,
      },
      capabilities,
      note: '这是紧凑概览；如果确实需要完整 provider 和 workspace root 列表，请用 compact=false 重新调用。',
    }
  }

  // 完整概览保留 provider 和全部 workspace root，适合排查集成状态。
  return {
    compact: false,
    integrations: overview.providers,
    workspace: {
      activeRoot: overview.activeWorkspaceRoot,
      roots: overview.workspaceRoots,
    },
    capabilities,
    note: '如果要检查 shell、PATH、命令可用性或包管理器状态，请用 bash 工具直接探测；Windows 使用 where <cmd>/echo %PATH%，macOS/Linux 使用 command -v <cmd>/echo $PATH。',
  }
}

// 根据 include 白名单裁剪项目上下文摘要，避免把 Git、命令历史和端口信息一次全塞回去。
export function filterProjectContextSummary(
  summary: SystemProjectContextSummary,
  include?: ProjectContextInclude[]
): SystemProjectContextSummary | Partial<SystemProjectContextSummary> {
  if (!include || isEmpty(include) || include.includes('all')) {
    // 未指定 include 或显式 all 时返回完整摘要。
    return summary
  }

  const includeSet = new Set(include)
  const output: Partial<SystemProjectContextSummary> = {}

  for (const { field, include: keys } of PROJECT_CONTEXT_INCLUDE_FIELD_ENTRIES) {
    if (keys.some((key) => includeSet.has(key))) {
      ;(output as Record<string, unknown>)[field] = summary[field]
    }
  }

  return output
}

// 按 sections 裁剪开发环境摘要；这个摘要可能包含进程、端口、日志等较重字段。
export function filterDevEnvironmentSummary(
  summary: SystemDevEnvironmentSummary,
  sections?: DevEnvironmentSection[]
): Partial<SystemDevEnvironmentSummary> & {
  generatedAt: number
  includedSections: DevEnvironmentSection[]
} {
  if (sections?.includes('all')) {
    // all 用于诊断阶段拿完整上下文，同时在 includedSections 中记录调用意图。
    return {
      ...summary,
      includedSections: ['all'],
    }
  }

  // 没传 sections 时使用保守默认值，降低普通调用的噪声和 token 占用。
  const includedSections =
    sections && !isEmpty(sections) ? sections : DEFAULT_DEV_ENVIRONMENT_SECTIONS
  const output: Partial<SystemDevEnvironmentSummary> & {
    generatedAt: number
    includedSections: DevEnvironmentSection[]
  } = {
    generatedAt: summary.generatedAt,
    includedSections,
  }

  for (const section of includedSections) {
    if (section === 'all') continue
    const field = DEV_ENVIRONMENT_SECTION_FIELD_MAP[section]
    ;(output as Record<string, unknown>)[field] = summary[field]
  }

  return output
}
