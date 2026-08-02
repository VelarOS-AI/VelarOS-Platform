import { z } from 'zod'

import { AppError } from '@velaros-ai/core/error'
import { renderParameterDescription as parameterDescription } from '@velaros-ai/core/utils/ToolDescription'

import { BrowserControlCapability } from './Capabilities'
import { requireActiveBrowserSite } from './Context'
import { defineBrowserTool } from './Types'

/**
 * 性能分析工具（吸收自 chrome-devtools-mcp 的 performance_* 工具组）。
 *
 * 背后是 DevTools 官方 trace 引擎：录制 CDP Tracing → 解析出 LCP/INP/CLS
 * 等指标与 insights → 按需对单个 insight 深挖。
 */
const browserPerformance = defineBrowserTool<{
  // action 可省略:带 insightSetId/insightName 时 schema transform 推断为 analyze_insight。
  action?: 'start_trace' | 'stop_trace' | 'analyze_insight' | 'take_heapsnapshot'
  reload?: boolean
  autoStopMs?: number | null
  insightSetId?: string
  insightName?: string
  path?: string
}>({
  name: 'browser:performance',
  role: 'control',
  summary: '页面性能与内存分析：trace 出 CWV 指标与瓶颈 insight，堆快照排查内存泄漏。',
  suitable: [
    '定位加载慢、LCP/INP/CLS 差、长任务卡顿，或配合节流压测页面。',
    '怀疑内存泄漏时按「基线→操作→回退」采集堆快照对比。',
  ],
  forbidden: [
    '只要页面内容或结构时不要用；那是 inspect/extract 的事。',
    '不要读 .heapsnapshot 进上下文；用 memlab 等外部工具分析。',
  ],
  usage: [
    'start_trace 默认重载录完整加载，5 秒自动停止返回分析；录交互传 autoStopMs=null 再 stop_trace。',
    'analyze_insight 需要 insightSetId + insightName（取自 trace 摘要）。',
  ],
  examples: [
    // 录完整加载：默认重载、5 秒自动停止并返回分析
    { action: 'start_trace' },
    // 录交互：不重载、录到手动 stop_trace（autoStopMs=null）
    { action: 'start_trace', reload: false, autoStopMs: null },
    // 手动停止并返回分析摘要
    { action: 'stop_trace' },
    // 对 trace 摘要里的某个 insight 出详细分析
    { action: 'analyze_insight', insightSetId: 'NAV-1', insightName: 'LCPBreakdown' },
    // 采集 V8 堆快照落盘（配合 memlab 排查泄漏）
    { action: 'take_heapsnapshot' },
  ],
  notes: [
    'trace 与堆快照落盘 artifacts/ 下，DevTools 面板或 memlab 可直接消费。',
  ],
  schema: z
    .object({
      // 宽容:action 可省略——带 insightSetId/insightName 时推断为 analyze_insight(模型连续
      // 分析多个 insight 时常只换 insight 字段不重复 action);其余情况仍必填。
      action: z
        .enum(['start_trace', 'stop_trace', 'analyze_insight', 'take_heapsnapshot'])
        .optional()
        .describe(
        parameterDescription({
          description: '性能/内存分析动作。',
          values: [
            'start_trace：开始录制性能 trace。',
            'stop_trace：停止录制并返回分析摘要。',
            'analyze_insight：对最近一次 trace 的指定 insight 输出详细分析。',
            'take_heapsnapshot：采集 V8 堆快照并落盘。',
          ],
          notes: ['省略时:带 insightSetId/insightName 视为 analyze_insight;否则必填。'],
        })
      ),
      reload: z.boolean().optional().describe(
        parameterDescription({
          description: 'start_trace 是否先重载页面录完整加载；默认 true，录交互时传 false。',
        })
      ),
      autoStopMs: z
        .number()
        .nullable()
        .transform((value) => (value === null ? null : Math.min(60_000, Math.max(1000, Math.round(value)))))
        .optional()
        .describe(
          parameterDescription({
            description: 'start_trace 录制窗口毫秒数；默认 5000，null 表示录到 stop_trace。',
            notes: ['范围 [1000,60000],超出自动钳制。'],
          })
        ),
      insightSetId: z.string().min(1).max(120).optional().describe(
        parameterDescription({
          description: 'analyze_insight 的 insight 集合 id（取自 trace 摘要清单）。',
        })
      ),
      insightName: z.string().min(1).max(120).optional().describe(
        parameterDescription({
          description: 'analyze_insight 的 insight 名称，例如 LCPBreakdown。',
        })
      ),
      path: z.string().min(1).max(300).optional().describe(
        parameterDescription({
          description: 'take_heapsnapshot 保存相对路径；缺省 artifacts/memory/ 下按时间戳命名。',
        })
      ),
    })
    // 缺 action 但带 insight 字段 → 推断 analyze_insight(这两个字段只属于该动作,推断无歧义)。
    .transform((input) => {
      if (!input.action && (input.insightSetId?.trim() || input.insightName?.trim())) return { ...input, action: 'analyze_insight' as const }
      return input
    })
    .superRefine((input, ctx) => {
      if (!input.action) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['action'],
          message:
            '缺少 action。可选:start_trace / stop_trace / analyze_insight / take_heapsnapshot(带 insightSetId/insightName 时可省略,自动视为 analyze_insight)。',
        })
        return
      }
      if (input.action === 'analyze_insight') {
        if (!input.insightSetId?.trim()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['insightSetId'],
            message: 'analyze_insight 动作必须提供 insightSetId。',
          })
        }
        if (!input.insightName?.trim()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['insightName'],
            message: 'analyze_insight 动作必须提供 insightName。',
          })
        }
      }
    }),
  permissions: ['network', 'fs:write'],
  capabilities: BrowserControlCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  execute: async (args, ctx) => {
    ctx.abortSignal.throwIfAborted()
    requireActiveBrowserSite(ctx)

    // schema 已保证:action 缺失只在带 insight 字段时被推断补全,否则 superRefine 拦下;
    // 这里的空值分支只是类型收窄兜底。
    const action = args.action
    if (!action) throw new AppError('VALIDATION', 'Unsupported browser:performance action.')

    switch (action) {
      case 'start_trace':
        return ctx.browser.startPerformanceTrace({
          reload: args.reload,
          autoStopMs: args.autoStopMs,
        })
      case 'stop_trace':
        return ctx.browser.stopPerformanceTrace()
      case 'analyze_insight':
        return ctx.browser.analyzePerformanceInsight({
          insightSetId: args.insightSetId!,
          insightName: args.insightName!,
        })
      case 'take_heapsnapshot':
        return ctx.browser.captureHeapSnapshot({ path: args.path })
      default:
        action satisfies never
        throw new AppError('VALIDATION', 'Unsupported browser:performance action.')
    }
  },
})

const browserPerformanceTools = {
  'browser:performance': browserPerformance,
}
export { browserPerformanceTools }
