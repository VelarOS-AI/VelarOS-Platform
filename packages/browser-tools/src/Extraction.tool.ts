import { z } from 'zod'

import { BrowserPageScriptBuilder } from '@velaros-ai/browser-core'
import { stringifyPretty } from '@velaros-ai/core'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'
import { renderParameterDescription as parameterDescription } from '@velaros-ai/core/utils/ToolDescription'

import { browserExtractSchema, parseBrowserExtractInput } from './BrowserExtractSchema'
import { BrowserArtifactWriteCapability, BrowserControlCapability } from './Capabilities'
import { createArtifactManager, getActiveBrowserContext, requireActiveBrowserSite } from './Context'
import { createBrowserPageContentBoundary } from './PageContentBoundary'
import { defineBrowserTool } from './Types'

/** 从页面表格提取 headers/rows 结构。 */
const browserExtractTable = defineBrowserTool<{
  selector?: string
  tableIndex?: number
  maxRows?: number
  save?: boolean
  name?: string
}>({
  name: 'browser_extract_table',
  role: 'inspect',
  summary: '从当前页面提取表格数据。',
  suitable: ['需要把页面表格转成 headers 和 rows 的结构化结果。'],
  forbidden: ['不要用它解析非表格列表；列表用 browser_extract_list。'],
  usage: ['可传 selector 或 tableIndex；需要保存时传 save=true。'],
  examples: [{ maxRows: 200, save: true }],
  notes: ['提取脚本在当前网页上下文中运行。'],
  schema: z.object({
    selector: z.string().optional().describe(
      parameterDescription({
        description: '定位目标表格的 CSS selector 或 XPath（//... 或 xpath=...）。',
        notes: ['省略时按 tableIndex 选择页面表格。'],
      })
    ),
    tableIndex: z
      .number()
      .transform((value) => Math.min(50, Math.max(0, Math.round(value))))
      .optional()
      .describe(
        parameterDescription({
          description: '当页面有多张表格时选择第几张。',
          notes: ['从 0 开始，默认 0。', '范围 [0,50],超出自动钳制。'],
        })
      ),
    maxRows: z.number().transform((value) => Math.min(2000, Math.max(1, Math.round(value)))).optional().describe(
      parameterDescription({
        description: '最多提取多少行。',
        notes: ['默认 200。', '上限 2000,超出自动钳制。'],
      })
    ),
    save: z.boolean().optional().describe(
      parameterDescription({
        description: '是否把提取结果保存为 extract 产物。',
        notes: ['默认 false。'],
      })
    ),
    name: z.string().min(1).max(120).optional().describe(
      parameterDescription({
        description: '保存 extract 产物时使用的名称。',
        usage: ['仅 save=true 时使用。'],
      })
    ),
  }),
  permissions: ['network', 'fs:read', 'fs:write'],
  capabilities: BrowserArtifactWriteCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => true,
  execute: async ({ selector, tableIndex = 0, maxRows = 200, save, name }, ctx) => {
    ctx.abortSignal.throwIfAborted()
    requireActiveBrowserSite(ctx)

    // 用统一脚本构建器生成页面端提取逻辑，避免工具里手写长脚本。
    const scripts = new BrowserPageScriptBuilder()
    const result = await ctx.browser.evaluateScript({
      script: scripts.buildTableExtractionScript({ selector, maxRows, tableIndex }),
      mode: 'expression',
      timeoutMs: 10000,
    })
    // save=true 时把本次提取结果沉淀到当前站点 extracts/ 目录。
    if (save) {
      const context = ctx.browser.getContext()!
      const saved = await createArtifactManager(ctx).writeArtifact({
        context,
        kind: 'extract',
        format: 'json',
        content: `${stringifyPretty(result)}\n`,
        name,
      })
      return { ...result, savedPath: saved.path, savedRelativePath: saved.relativePath }
    }
    return result
  },
})

/** 从页面列表/搜索结果提取结构化条目。 */
const browserExtractList = defineBrowserTool<{
  selector?: string
  maxItems?: number
  save?: boolean
  name?: string
}>({
  name: 'browser_extract_list',
  role: 'inspect',
  summary: '从当前页面提取列表条目。',
  suitable: ['需要提取新闻、电商、搜索结果等列表的标题、链接和描述。'],
  forbidden: ['不要用它提取表格；表格用 browser_extract_table。'],
  usage: ['可传 selector 限定列表容器；需要保存时传 save=true。'],
  examples: [{ selector: ".result", maxItems: 50 }],
  notes: ['省略 selector 时会自动检测常见列表结构。'],
  schema: z.object({
    selector: z
      .string()
      .optional()
      .describe(
        parameterDescription({
          description: '定位列表容器的 CSS selector 或 XPath（//... 或 xpath=...）。',
          notes: ['省略时自动检测 ul、ol、article、.item 等常见结构。'],
        })
      ),
    maxItems: z.number().transform((value) => Math.min(500, Math.max(1, Math.round(value)))).optional().describe(
      parameterDescription({
        description: '最多提取多少条。',
        notes: ['默认 50。', '上限 500,超出自动钳制。'],
      })
    ),
    save: z.boolean().optional().describe(
      parameterDescription({
        description: '是否把提取结果保存为 extract 产物。',
        notes: ['默认 false。'],
      })
    ),
    name: z.string().min(1).max(120).optional().describe(
      parameterDescription({
        description: '保存 extract 产物时使用的名称。',
        usage: ['仅 save=true 时使用。'],
      })
    ),
  }),
  permissions: ['network', 'fs:read', 'fs:write'],
  capabilities: BrowserArtifactWriteCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => true,
  execute: async ({ selector, maxItems = 50, save, name }, ctx) => {
    ctx.abortSignal.throwIfAborted()
    requireActiveBrowserSite(ctx)

    // 自动检测常见列表结构，也允许 selector 精确限定容器。
    const scripts = new BrowserPageScriptBuilder()
    const result = await ctx.browser.evaluateScript({
      script: scripts.buildListExtractionScript({ selector, maxItems }),
      mode: 'expression',
      timeoutMs: 10000,
    })
    // 可选保存便于后续 recipe、分析或人工回看。
    if (save) {
      const context = ctx.browser.getContext()!
      const saved = await createArtifactManager(ctx).writeArtifact({
        context,
        kind: 'extract',
        format: 'json',
        content: `${stringifyPretty(result)}\n`,
        name,
      })
      return { ...result, savedPath: saved.path, savedRelativePath: saved.relativePath }
    }
    return result
  },
})

/** 翻页提取列表数据，并合并多页结果。 */
const browserPaginateExtract = defineBrowserTool<{
  selector?: string
  maxPages?: number
  maxItemsPerPage?: number
  nextPageSelector?: string
  save?: boolean
  name?: string
}>({
  name: 'browser_paginate_extract',
  role: 'inspect',
  summary: '翻页提取列表数据并合并结果。',
  suitable: ['需要跨多页收集搜索结果、商品列表或文章列表。'],
  forbidden: ['不要在会产生不可逆提交的分页流程中使用。'],
  protocol: ['先确认当前页是列表第一页；必要时提供 nextPageSelector；运行后读取 pagesVisited 和 totalItems。'],
  usage: ['设置 maxPages、maxItemsPerPage；需要自定义下一页按钮时传 nextPageSelector。'],
  examples: [{ maxPages: 3, maxItemsPerPage: 40 }],
  notes: ['默认会把合并结果保存为 extract 产物。'],
  schema: z.object({
    selector: z.string().optional().describe(
      parameterDescription({
        description: '列表容器 CSS selector 或 XPath（//... 或 xpath=...）。',
        usage: ['会透传给每页列表提取。'],
      })
    ),
    maxPages: z.number().transform((value) => Math.min(20, Math.max(1, Math.round(value)))).optional().describe(
      parameterDescription({
        description: '最多翻几页。',
        notes: ['默认 5。', '上限 20,超出自动钳制。'],
      })
    ),
    maxItemsPerPage: z
      .number()
      .transform((value) => Math.min(500, Math.max(1, Math.round(value))))
      .optional()
      .describe(
        parameterDescription({
          description: '每页最多提取多少条。',
          notes: ['默认 50。', '上限 500,超出自动钳制。'],
        })
      ),
    nextPageSelector: z.string().optional().describe(
      parameterDescription({
        description: '下一页按钮的 CSS selector。',
        notes: ['省略时自动检测常见分页控件。'],
      })
    ),
    save: z.boolean().optional().describe(
      parameterDescription({
        description: '是否把合并结果保存为 extract 产物。',
        notes: ['默认 true。'],
      })
    ),
    name: z.string().min(1).max(120).optional().describe(
      parameterDescription({
        description: '保存 extract 产物时使用的名称。',
      })
    ),
  }),
  permissions: ['network', 'fs:read', 'fs:write'],
  capabilities: BrowserControlCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  execute: async (
    { selector, maxPages = 5, maxItemsPerPage = 50, nextPageSelector, save = true, name },
    ctx
  ) => {
    ctx.abortSignal.throwIfAborted()
    requireActiveBrowserSite(ctx)

    // 每页复用列表提取脚本，翻页只负责寻找/点击下一页按钮。
    const scripts = new BrowserPageScriptBuilder()
    const allItems: unknown[] = []
    let pagesVisited = 0
    // 默认 selector 覆盖英文/中文 aria-label 和常见 class 分页命名。
    const nextBtnSelector =
      nextPageSelector ||
      'a[rel="next"], button[aria-label*="next" i], button[aria-label*="下一页"], a[aria-label*="next" i], [class*="next"]:not([disabled]), [class*="pagination"] a:last-child'

    for (let page = 0; page < maxPages; page++) {
      ctx.abortSignal.throwIfAborted()
      pagesVisited++

      // 先提取当前页条目。
      const pageResult = await ctx.browser.evaluateScript({
        script: scripts.buildListExtractionScript({ selector, maxItems: maxItemsPerPage }),
        mode: 'expression',
        timeoutMs: 10000,
      }) as { items?: unknown[] }
      const items = pageResult.items ?? []
      allItems.push(...items)

      // 当前页没有条目时认为提取结束，避免空页继续翻。
      if (items.length === 0) break

      // 检查下一页按钮是否存在且未禁用。
      const hasNext = await ctx.browser.evaluateScript({
        script: `(() => { const el = document.querySelector(${JSON.stringify(nextBtnSelector)}); return !!(el && !el.getAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true') })()`,
        mode: 'expression',
        timeoutMs: 5000,
      }) as { result?: unknown }
      if (!hasNext.result) break

      // 点击下一页后短暂等待页面内容更新。
      await ctx.browser.evaluateScript({
        script: `(() => { const el = document.querySelector(${JSON.stringify(nextBtnSelector)}); if (el) { el.click(); return true } return false })()`,
        mode: 'expression',
        timeoutMs: 5000,
      })
      await TimerScope.sleep(1_200, { signal: ctx.abortSignal })
    }

    const summary = { pagesVisited, totalItems: allItems.length, items: allItems }
    // 默认保存批量提取结果，方便用户后续读取 artifact 而不是重新跑翻页。
    if (save) {
      const context = ctx.browser.getContext()!
      const saved = await createArtifactManager(ctx).writeArtifact({
        context,
        kind: 'extract',
        format: 'json',
        content: `${stringifyPretty(summary)}\n`,
        name,
      })
      return { ...summary, savedPath: saved.path, savedRelativePath: saved.relativePath }
    }
    return summary
  },
})

/** 提取页面可见正文为 plain/markdown/html。 */
const browserExtractPageContent = defineBrowserTool<{
  format?: 'plain' | 'markdown' | 'html'
  selector?: string
  ignoreSelectors?: string[]
  maxChars?: number
  save?: boolean
  name?: string
}>({
  name: 'browser_extract_page_content',
  role: 'inspect',
  summary: '提取当前页面可见正文并保存为 plain/markdown/html。',
  suitable: [
    '需要把文章、详情页或选中区块导出为可读文本。',
    '用户要求保存页面文字内容而非截图。',
  ],
  forbidden: [
    '不要用于表格结构化数据；表格用 browser_extract_table。',
    '跨域 iframe、canvas 渲染内容无法提取。',
  ],
  usage: [
    '默认提取 main/article 区域；传 selector 限定 DOM 子树。',
    '传 ignoreSelectors 过滤导航、侧栏、cookie banner、广告等噪音子树。',
    'format 选 plain/markdown/html；save=true 写入 extracts/。',
  ],
  examples: [{ format: 'markdown', save: true }],
  notes: ['懒加载内容需先 browser_act action=scroll 滚到可见区域。'],
  schema: z.object({
    format: z.enum(['plain', 'markdown', 'html']).optional().describe(
      parameterDescription({
        description: '输出格式。',
        notes: ['默认 markdown。'],
      })
    ),
    selector: z.string().optional().describe(
      parameterDescription({
        description: '限定提取范围的 CSS selector 或 XPath（//... 或 xpath=...）。',
        notes: ['省略时自动选择 main/article 或 body。'],
      })
    ),
    ignoreSelectors: z.array(z.string().min(1).max(1000)).max(50).optional().describe(
      parameterDescription({
        description: '需要从正文提取结果中排除的 CSS selector 或 XPath（//... 或 xpath=...）列表。',
        notes: ['适合过滤导航、侧栏、cookie banner、广告等重复噪音。'],
      })
    ),
    maxChars: z.number().transform((value) => Math.min(200000, Math.max(1, Math.round(value)))).optional().describe(
      parameterDescription({
        description: '最多返回多少字符。',
        notes: ['默认 50000。', '上限 200000,超出自动钳制。'],
      })
    ),
    save: z.boolean().optional().describe(
      parameterDescription({
        description: '是否保存到 extracts/ 目录。',
        notes: ['默认 false。'],
      })
    ),
    name: z.string().min(1).max(120).optional().describe(
      parameterDescription({
        description: '保存时的产物名称。',
        usage: ['仅 save=true 时使用。'],
      })
    ),
  }),
  permissions: ['network', 'fs:read', 'fs:write'],
  capabilities: BrowserArtifactWriteCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => true,
  execute: async (
    { format = 'markdown', selector, ignoreSelectors, maxChars = 50_000, save, name },
    ctx
  ) => {
    ctx.abortSignal.throwIfAborted()
    requireActiveBrowserSite(ctx)
    const context = getActiveBrowserContext(ctx)

    const scripts = new BrowserPageScriptBuilder()
    const result = await ctx.browser.evaluateScript({
      script: scripts.buildPageContentExtractionScript({ format, selector, ignoreSelectors, maxChars }),
      mode: 'expression',
      timeoutMs: 15000,
    }) as {
      ok?: boolean
      format?: string
      selector?: LooseOptional<string>
      content?: string
      truncated?: boolean
      url?: string
      capturedAt?: number
    }
    const resultWithBoundary = {
      ...result,
      contentBoundary: createBrowserPageContentBoundary(context.url),
    }

    const artifactFormat =
      format === 'html' ? 'html' : format === 'markdown' ? 'markdown' : 'text'

    if (save && result.content) {
      const saved = await createArtifactManager(ctx).writeArtifact({
        context,
        kind: 'extract',
        format: artifactFormat,
        content: result.content,
        name,
      })
      return { ...resultWithBoundary, savedPath: saved.path, savedRelativePath: saved.relativePath }
    }

    return resultWithBoundary
  },
})

/** 页面结构化抽取工具出口。 */
const browserExtract = defineBrowserTool<z.input<typeof browserExtractSchema>>({
  name: 'browser_extract',
  role: 'inspect',
  summary: '统一提取当前页面的表格、列表、分页列表或正文。',
  suitable: [
    '需要把当前页面内容转为结构化 table/list 结果。',
    '需要提取正文为 plain/markdown/html，或跨分页收集列表项。',
  ],
  forbidden: [
    '不要用于截图、PDF、媒体或资源清单导出；这些仍用 browser_export_page。',
    '不要用它操作页面表单或按钮；页面动作使用 browser_act。',
  ],
  protocol: ['分页提取会点击下一页，先确认当前页面处于列表第一页。'],
  usage: ['传 action 选择 table、list、paginate 或 content，再传该动作需要的字段。'],
  examples: [
    // 提取正文为 markdown
    { action: 'content', format: 'markdown', save: true },
    // 提取表格为结构化行
    { action: 'table', maxRows: 200 },
    // 按重复容器 selector 提取列表项
    { action: 'list', selector: '.result', maxItems: 50 },
    // 跨分页收集列表：从第一页开始，点击下一页
    { action: 'paginate', selector: '.result', maxPages: 3, maxItemsPerPage: 40 },
  ],
  notes: ['这是 browser 页面结构化提取的唯一公开入口；内部仍按 action 复用有界提取实现。'],
  schema: browserExtractSchema,
  permissions: ['network', 'fs:read', 'fs:write'],
  capabilities: BrowserArtifactWriteCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  execute: async (input, ctx) => {
    const parsed = parseBrowserExtractInput(input)

    switch (parsed.action) {
      case 'table':
        return browserExtractTable.execute(
          {
            selector: parsed.selector,
            tableIndex: parsed.tableIndex,
            maxRows: parsed.maxRows,
            save: parsed.save,
            name: parsed.name,
          },
          ctx
        )
      case 'list':
        return browserExtractList.execute(
          {
            selector: parsed.selector,
            maxItems: parsed.maxItems,
            save: parsed.save,
            name: parsed.name,
          },
          ctx
        )
      case 'paginate':
        return browserPaginateExtract.execute(
          {
            selector: parsed.selector,
            maxPages: parsed.maxPages,
            maxItemsPerPage: parsed.maxItemsPerPage,
            nextPageSelector: parsed.nextPageSelector,
            save: parsed.save,
            name: parsed.name,
          },
          ctx
        )
      case 'content':
        return browserExtractPageContent.execute(
          {
            format: parsed.format,
            selector: parsed.selector,
            ignoreSelectors: parsed.ignoreSelectors,
            maxChars: parsed.maxChars,
            save: parsed.save,
            name: parsed.name,
          },
          ctx
        )
      default:
        parsed satisfies never
        throw new Error('Unsupported browser_extract action.')
    }
  },
})

const browserExtractionTools = {
  browser_extract: browserExtract,
}
export { browserExtractionTools }
