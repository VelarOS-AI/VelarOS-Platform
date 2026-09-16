import type { z } from 'zod'

import { isArray, isTrue, stringifyPretty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import { encodeBrowserScriptStringLiteral } from '../core/BrowserScriptLiteral'

import { browserExtractSchema, parseBrowserExtractInput } from './BrowserExtractSchema'
import { BrowserArtifactWriteCapability } from './Capabilities'
import { requireActiveBrowserSite } from './Context'
import {
  extractBrowserList,
  extractBrowserPageContent,
  extractBrowserTable,
  saveBrowserExtraction,
} from './PageExtraction'
import { type BrowserToolContext, defineBrowserTool } from './Types'

/**
 * 翻页缺省的「下一页」选择器：只认明确自称下一页的元素。
 *
 * 宁可翻不动也不要翻错：点错一次之后收集到的就全是别的页面的内容，而回执上看不出来。
 * 页面用别的写法时由模型显式传 nextPageSelector。
 */
const BrowserNextPageSelector = [
  'a[rel="next"]',
  'button[rel="next"]',
  'a[aria-label*="next" i]',
  'button[aria-label*="next" i]',
  'a[aria-label*="下一页"]',
  'button[aria-label*="下一页"]',
].join(', ')

/**
 * browser:extract 的四个动作分支。
 *
 * 这些分支只被本文件的 `browser:extract` 调用，不是模型面工具：入参已由
 * `parseBrowserExtractInput` 校验并归一。
 */

/** 从页面表格提取 headers/rows 结构。 */
async function browserExtractTable(
  {
    selector,
    tableIndex = 0,
    maxRows = 200,
    save = false,
    name,
  }: {
    selector?: string
    tableIndex?: number
    maxRows?: number
    save?: boolean
    name?: string
  },
  ctx: BrowserToolContext
) {
  ctx.abortSignal.throwIfAborted()
  requireActiveBrowserSite(ctx)

  return extractBrowserTable(ctx, { selector, tableIndex, maxRows, save, name })
}

/** 从页面列表/搜索结果提取结构化条目。 */
async function browserExtractList(
  {
    selector,
    maxItems = 50,
    save = false,
    name,
  }: {
    selector?: string
    maxItems?: number
    save?: boolean
    name?: string
  },
  ctx: BrowserToolContext
) {
  ctx.abortSignal.throwIfAborted()
  requireActiveBrowserSite(ctx)

  return extractBrowserList(ctx, { selector, maxItems, save, name })
}

/** 翻页提取列表数据，并合并多页结果。 */
async function browserPaginateExtract(
  {
    selector,
    maxPages = 5,
    maxItemsPerPage = 50,
    nextPageSelector,
    save = true,
    name,
  }: {
    selector?: string
    maxPages?: number
    maxItemsPerPage?: number
    nextPageSelector?: string
    save?: boolean
    name?: string
  },
  ctx: BrowserToolContext
) {
  ctx.abortSignal.throwIfAborted()
  requireActiveBrowserSite(ctx)

  // 每页复用列表提取，翻页只负责寻找/点击下一页按钮。
  const allItems: unknown[] = []
  let pagesVisited = 0
  let previousPageItems: Nullable<string> = null
  // 缺省只认「明确自称下一页」的元素：rel=next 与英文/中文 aria-label。
  // 曾经的 `[class*="next"]` 会匹配 class 里带 next 的任何元素（例如「next-article」推荐卡片），
  // `[class*="pagination"] a:last-child` 会点到「末页」；翻页点错一次，后面几页收的就全是别的内容。
  const nextBtnSelector = nextPageSelector || BrowserNextPageSelector
  const nextButtonSelectorLiteral = encodeBrowserScriptStringLiteral(nextBtnSelector)
  const nextPageTarget = {
    css: nextBtnSelector,
    role: null,
    text: null,
    name: null,
    attributes: {},
  }

  for (let page = 0; page < maxPages; page++) {
    ctx.abortSignal.throwIfAborted()

    // 先提取当前页条目。
    const pageResult = await extractBrowserList(ctx, {
      selector,
      maxItems: maxItemsPerPage,
      save: false,
    })
    const items = isArray(pageResult.items) ? pageResult.items : []
    // 翻页没生效（按钮点了没反应、链接指回当前页）时条目不变：停下，别把同一页重复收集。
    const pageItems = JSON.stringify(items)
    if (pageItems === previousPageItems) break
    previousPageItems = pageItems
    pagesVisited++
    allItems.push(...items)

    // 当前页没有条目时认为提取结束，避免空页继续翻。
    if (items.length === 0) break

    // 检查下一页按钮是否存在且未禁用；disabled 是布尔属性、值常为空串，只能用 hasAttribute 判断。
    const hasNext = await ctx.browser.evaluateScript({
      script: `(() => { const el = document.querySelector(${nextButtonSelectorLiteral}); return !!(el && !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true') })()`,
      mode: 'expression',
      timeoutMs: 5000,
    })
    if (!isTrue(hasNext.result)) break

    // 点击走宿主端口而不是页面里的 el.click()：后者在宿主的动作策略里被当成「执行脚本」，
    // 绕开了点击该有的遮挡检测与效果指纹。点不中就停，别把同一页再收一遍。
    const clicked = await ctx.browser.performTargetAction({
      action: 'click',
      target: nextPageTarget,
    })
    if (!clicked.matched) break

    // 点击下一页后短暂等待页面内容更新。
    await TimerScope.sleep(1_200, { signal: ctx.abortSignal })
  }

  const summary = { pagesVisited, totalItems: allItems.length, items: allItems }
  // 默认保存批量提取结果，方便用户后续读取 artifact 而不是重新跑翻页。
  if (!save) return summary

  const saved = await saveBrowserExtraction(ctx, {
    format: 'json',
    content: `${stringifyPretty(summary)}\n`,
    name,
  })
  return { ...summary, ...saved }
}

/** 提取页面可见正文为 plain/markdown/html。 */
async function browserExtractPageContent(
  {
    format = 'markdown',
    selector,
    ignoreSelectors,
    maxChars = 50_000,
    save = false,
    name,
  }: {
    format?: 'plain' | 'markdown' | 'html'
    selector?: string
    ignoreSelectors?: string[]
    maxChars?: number
    save?: boolean
    name?: string
  },
  ctx: BrowserToolContext
) {
  ctx.abortSignal.throwIfAborted()
  requireActiveBrowserSite(ctx)

  return extractBrowserPageContent(ctx, {
    format,
    selector,
    ignoreSelectors,
    maxChars,
    save,
    name,
  })
}

/** 页面结构化抽取工具出口。 */
const browserExtract = defineBrowserTool<z.input<typeof browserExtractSchema>>({
  name: 'browser:extract',
  role: 'inspect',
  summary: '统一提取当前页面的表格、列表、分页列表或正文。',
  suitable: [
    '需要把当前页面内容转为结构化 table/list 结果。',
    '需要提取正文为 plain/markdown/html，或跨分页收集列表项。',
  ],
  forbidden: [
    '不要用于截图、PDF、媒体或资源清单导出；这些仍用 browser:export_page。',
    '不要用它操作页面表单或按钮；页面动作使用 browser:act。',
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
  notes: [
    '这是 browser 页面结构化提取的唯一公开入口；内部仍按 action 复用有界提取实现。',
    '返回：table 给 headers/rows/rowCount（没找到表格时 ok=false 并附 error）；list 给 items（title/href/description）；paginate 给 pagesVisited/totalItems/items；content 给 content/format/truncated 与 contentBoundary。',
    'save=true 且提取成功时写入 extracts/，并追加 savedPath/savedRelativePath；paginate 默认保存。',
    '单次提取结果按 JSON 计超过约 20 万字符时直接报错而不是截断；按提示调小 maxRows/maxItems/maxChars 或收窄 selector。',
  ],
  schema: browserExtractSchema,
  permissions: ['network', 'fs:read', 'fs:write'],
  capabilities: BrowserArtifactWriteCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  execute: async (input, ctx) => {
    const parsed = parseBrowserExtractInput(input)

    switch (parsed.action) {
      case 'table':
        return browserExtractTable(
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
        return browserExtractList(
          {
            selector: parsed.selector,
            maxItems: parsed.maxItems,
            save: parsed.save,
            name: parsed.name,
          },
          ctx
        )
      case 'paginate':
        return browserPaginateExtract(
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
        return browserExtractPageContent(
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
        throw new AppError('VALIDATION', 'Unsupported browser:extract action.')
    }
  },
})

const browserExtractionTools = {
  'browser:extract': browserExtract,
}
export { browserExtractionTools }
