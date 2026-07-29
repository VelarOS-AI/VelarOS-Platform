import { z } from 'zod'

import { BrowserPageScriptBuilder, buildBrowserPageSnapshotName } from '@velaros-ai/browser-core'
import { buildBrowserScreenshotOptions } from '@velaros-ai/browser-core'
import { stringifyPretty } from '@velaros-ai/core'
import { renderParameterDescription as parameterDescription } from '@velaros-ai/core/utils/ToolDescription'

import { BrowserControlCapability } from './Capabilities'
import { createArtifactManager, requireActiveBrowserSite } from './Context'
import { defineBrowserTool } from './Types'

const exportKindSchema = z.enum([
  'content',
  'screenshot',
  'region',
  'pdf',
  'media',
  'resources',
  'table',
  'snapshot',
])

/** 统一入口：按 kind 路由到对应 WYSIWYG 提取能力。 */
const browserExportPage = defineBrowserTool<{
  kind: z.infer<typeof exportKindSchema>
  format?: 'plain' | 'markdown' | 'html'
  selector?: string
  savePath?: string
  save?: boolean
  name?: string
  fullPage?: boolean
  tableIndex?: number
  maxRows?: number
}>({
  name: 'browser_export_page',
  role: 'control',
  summary: '统一导出当前页面可见内容（文本/截图/区域/PDF/媒体/表格/快照）。',
  suitable: [
    '用户要求「保存页面」「下载所见内容」但未指定具体工具时。',
    '需要一次性归档页面多种形态产物。',
  ],
  forbidden: [
    '不要用于 blob:/DRM/m3u8 流媒体；媒体需可直连 http(s)。',
    '不要替代精细交互；先 scroll/wait 让懒加载内容可见。',
  ],
  usage: [
    'kind=content 导出正文（format: plain/markdown/html）。',
    'kind=screenshot 全页/视口 PNG；kind=region 需 selector。',
    'kind=pdf 打印为 PDF；kind=media/resources 列出可下载资源。',
    'kind=table 提取表格 JSON；kind=snapshot 保存结构化页面快照。',
  ],
  examples: [
    // 导出正文为 markdown 并写入 extracts/
    { kind: 'content', format: 'markdown', save: true },
    // 全页截图
    { kind: 'screenshot', fullPage: true },
    // 区域截图：kind=region 必须给 selector
    { kind: 'region', selector: '#invoice' },
    // 打印为 PDF
    { kind: 'pdf' },
    // 列出可下载媒体 URL（再用 browser_fetch_resource 下载）
    { kind: 'media' },
    // 提取第 0 张表格为 JSON
    { kind: 'table', tableIndex: 0, maxRows: 200 },
    // 保存结构化页面快照
    { kind: 'snapshot' },
  ],
  notes: [
    '产物默认写入 extracts/、artifacts/screenshots/、artifacts/exports/ 或 pages/。',
    'fetchable 媒体 URL 再用 browser_fetch_resource 下载。',
  ],
  schema: z.object({
    kind: exportKindSchema.describe(
      parameterDescription({
        description: '导出类型。',
        values: [
          'content：可见正文。',
          'screenshot：页面截图 PNG。',
          'region：selector 区域截图。',
          'pdf：打印为 PDF。',
          'media：媒体 URL 列表。',
          'resources：链接/iframe 清单。',
          'table：表格 JSON。',
          'snapshot：结构化页面快照。',
        ],
      })
    ),
    format: z.enum(['plain', 'markdown', 'html']).optional().describe(
      parameterDescription({
        description: 'kind=content 时的文本格式。',
        notes: ['默认 markdown。'],
      })
    ),
    selector: z.string().optional().describe(
      parameterDescription({
        description: 'kind=content/region/table 时的 CSS selector。',
      })
    ),
    savePath: z.string().optional().describe(
      parameterDescription({
        description: 'kind=screenshot/region/pdf 时的相对保存路径。',
      })
    ),
    save: z.boolean().optional().describe(
      parameterDescription({
        description: 'kind=content/table 是否写入 extracts/。',
        notes: ['默认 true。'],
      })
    ),
    name: z.string().min(1).max(120).optional().describe(
      parameterDescription({
        description: '产物名称。',
      })
    ),
    fullPage: z.boolean().optional().describe(
      parameterDescription({
        description: 'kind=screenshot 是否截取完整页面。',
      })
    ),
    tableIndex: z.number().transform((value) => Math.min(50, Math.max(0, Math.round(value)))).optional().describe(
      parameterDescription({
        description: 'kind=table 时选择第几张表格。',
        notes: ['范围 [0,50],超出自动钳制。'],
      })
    ),
    maxRows: z.number().transform((value) => Math.min(2000, Math.max(1, Math.round(value)))).optional().describe(
      parameterDescription({
        description: 'kind=table 时最多提取行数。',
        notes: ['上限 2000,超出自动钳制。'],
      })
    ),
  }),
  permissions: ['network', 'screen:capture', 'fs:read', 'fs:write'],
  capabilities: BrowserControlCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  execute: async (args, ctx) => {
    ctx.abortSignal.throwIfAborted()
    requireActiveBrowserSite(ctx)
    const context = ctx.browser.getContext()!
    const scripts = new BrowserPageScriptBuilder()

    switch (args.kind) {
      case 'content': {
        const format = args.format ?? 'markdown'
        const result = await ctx.browser.evaluateScript({
          script: scripts.buildPageContentExtractionScript({
            format,
            selector: args.selector,
            maxChars: 50_000,
          }),
          mode: 'expression',
          timeoutMs: 15_000,
        }) as { content?: string; truncated?: boolean; url?: string }
        if (args.save !== false && result.content) {
          const artifactFormat =
            format === 'html' ? 'html' : format === 'markdown' ? 'markdown' : 'text'
          const saved = await createArtifactManager(ctx).writeArtifact({
            context,
            kind: 'extract',
            format: artifactFormat,
            content: result.content,
            name: args.name,
          })
          return { kind: args.kind, ...result, savedPath: saved.path, savedRelativePath: saved.relativePath }
        }
        return { kind: args.kind, ...result }
      }
      case 'screenshot':
        return {
          kind: args.kind,
          ...(await ctx.browser.captureScreenshot(
            buildBrowserScreenshotOptions({
              path: args.savePath,
              fullPage: args.fullPage ?? true,
              modelFacing: true,
            })
          )),
        }
      case 'region': {
        if (!args.selector?.trim()) {
          throw new Error('kind=region 必须提供 selector。')
        }
        return {
          kind: args.kind,
          ...(await ctx.browser.captureScreenshot(
            buildBrowserScreenshotOptions({
              path: args.savePath ?? `artifacts/screenshots/region-${Date.now()}.png`,
              region: { selector: args.selector },
              modelFacing: true,
            })
          )),
        }
      }
      case 'pdf':
        return {
          kind: args.kind,
          ...(await ctx.browser.exportPagePdf({ savePath: args.savePath })),
        }
      case 'media':
        return { kind: args.kind, ...(await ctx.browser.listMediaSources({ limit: 120 })) }
      case 'resources':
        return { kind: args.kind, ...(await ctx.browser.listPageResources({ limit: 120 })) }
      case 'table': {
        const tableResult = await ctx.browser.evaluateScript({
          script: scripts.buildTableExtractionScript({
            selector: args.selector,
            maxRows: args.maxRows ?? 200,
            tableIndex: args.tableIndex ?? 0,
          }),
          mode: 'expression',
          timeoutMs: 10_000,
        })
        if (args.save !== false) {
          const saved = await createArtifactManager(ctx).writeArtifact({
            context,
            kind: 'extract',
            format: 'json',
            content: `${stringifyPretty(tableResult)}\n`,
            name: args.name,
          })
          return { kind: args.kind, ...tableResult, savedPath: saved.path, savedRelativePath: saved.relativePath }
        }
        return { kind: args.kind, ...tableResult }
      }
      case 'snapshot': {
        const inspection = await ctx.browser.inspectPage({ maxTextChars: 20_000 })
        // 未指定名称时用时间戳唯一名(与截图一致),避免同页重复导出撞名硬报错。
        const snapshotName =
          args.name?.trim() ||
          `${buildBrowserPageSnapshotName(inspection.url, inspection.title)}-${new Date()
            .toISOString()
            .replace(/[:.]/g, '-')}`
        const saved = await createArtifactManager(ctx).savePageSnapshot({
          context,
          inspection,
          name: snapshotName,
        })
        return {
          kind: args.kind,
          inspection,
          savedPath: saved.artifact.path,
          savedRelativePath: saved.artifact.relativePath,
        }
      }
      default:
        throw new Error(`不支持的导出类型：${String(args.kind)}`)
    }
  },
})

const browserExportTools = {
  browser_export_page: browserExportPage,
}
export { browserExportTools }
