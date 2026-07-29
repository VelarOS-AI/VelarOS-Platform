import { z } from 'zod'

import { renderParameterDescription as parameterDescription } from '@velaros-ai/core/utils/ToolDescription'

import { buildSystemOverview } from './Helpers'
import { defineSystemTool } from './Types'

// 系统能力总览工具：给模型快速判断当前能打开路径、运行命令、刷新 shell 等能力。
const getSystemOverview = defineSystemTool<{ compact?: boolean }>({
  name: 'get_system_overview',
  role: 'inspect',
  summary: '查看系统能力与工作区状态。',
  suitable: [
      '任务开头快速确认当前 active workspace、browser site 和系统能力开关。',
      '需要知道当前是否允许打开路径、运行命令、刷新 shell 或启动后台任务。',
    ],
  forbidden: [
      '不要用它检测具体命令是否存在；命令可用性用 bash 工具探测（Windows 用 where，macOS/Linux 用 command -v）。',
      '不要用它读取文件或执行命令；它只返回状态概览。',
    ],
  protocol: [
      '先用默认 compact=true 快速判断当前状态。',
      '只有需要完整 provider/root 明细时才传 compact=false。',
    ],
  usage: ['传空对象获取紧凑概览；需要完整列表时传 compact=false。'],
  examples: [
    // 紧凑概览（默认）
    {},
    // 完整 provider/root 明细
    { compact: false },
  ],
  notes: ['返回的是调用时快照，后续切换工作区或能力变化后需要重新读取。'],
  schema: z.object({
    compact: z.boolean().optional().describe(
      parameterDescription({
        description: '是否返回紧凑概览。',
        usage: ['默认 true；需要 provider/root 明细时传 false。'],
      })
    ),
  }),
  permissions: [],
  isConcurrencySafe: () => true,
  execute: async ({ compact }, ctx) =>
    // 默认走紧凑模式，只有调用方明确 compact=false 时才返回完整 provider/root 列表。
    buildSystemOverview(ctx, compact ?? true),
})


// 对外注册的系统概览类工具集合。
const systemOverviewTools = {
  get_system_overview: getSystemOverview,
}
export { systemOverviewTools }
