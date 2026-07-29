import { z } from 'zod'

import { isString } from '@velaros-ai/core'
import { renderParameterDescription as parameterDescription } from '@velaros-ai/core/utils/ToolDescription'

import type { BrowserElementQueryResult, BrowserObserveActionsResult, BrowserPageDiagnostics } from '../core'
import { buildBrowserScreenshotOptions } from '../core'

import { BrowserArtifactWriteCapability, BrowserObserveCapability } from './Capabilities'
import type { BrowserConsoleEventsResult } from './ConsoleEvents'
import { buildBrowserConsoleEventsResult } from './ConsoleEvents'
import { requireActiveBrowserSite } from './Context'
import type {
  BrowserGetNetworkRequestInput,
  BrowserGetNetworkResponseBodyInput,
  BrowserGetPageDiagnosticsInput,
  BrowserListConsoleEventsInput,
  BrowserListNetworkEventsInput,
  BrowserListPageErrorsInput,
  BrowserQueryElementsInput,
} from './Inspection'
import {
  browserGetNetworkRequestGuidedSchema,
  browserGetNetworkRequestSchema,
  browserGetNetworkResponseBodyGuidedSchema,
  browserGetNetworkResponseBodySchema,
  browserGetPageDiagnosticsGuidedSchema,
  browserGetPageDiagnosticsSchema,
  browserListConsoleEventsGuidedSchema,
  browserListConsoleEventsSchema,
  browserListNetworkEventsGuidedSchema,
  browserListNetworkEventsSchema,
  browserListPageErrorsGuidedSchema,
  browserListPageErrorsSchema,
  browserQueryElementsGuidedSchema,
  browserQueryElementsSchema,
  normalizeBrowserGetNetworkRequestGuided,
  normalizeBrowserGetNetworkResponseBodyGuided,
  normalizeBrowserGetPageDiagnosticsGuided,
  normalizeBrowserListConsoleEventsGuided,
  normalizeBrowserListNetworkEventsGuided,
  normalizeBrowserListPageErrorsGuided,
  normalizeBrowserQueryElementsGuided,
} from './Inspection'
import type { BrowserNetworkEventsResult } from './NetworkEvents'
import { buildBrowserNetworkEventsResult } from './NetworkEvents'
import { buildObserveActionsResult, clampObserveActionLimit } from './ObserveActions'
import type { BrowserPageErrorsResult } from './PageErrors'
import { buildBrowserPageErrorsResult } from './PageErrors'
import { defineBrowserTool } from './Types'

/** 读取当前页面轻量状态，不做完整 DOM 抽取。 */
const browserGetPageState = defineBrowserTool<Record<string, never>>({
  name: 'browser_get_page_state',
  role: 'inspect',
  summary: '轻量查询当前浏览器页面状态。',
  suitable: ['需要在操作前快速确认 URL、标题、加载状态或最近导航错误。'],
  forbidden: ['不要用它读取页面正文或元素列表；需要内容时用 browser_inspect_page。'],
  usage: ['无需参数。'],
  examples: [{}],
  notes: ['比完整页面检查更轻。'],
  schema: z.object({}),
  permissions: ['network'],
  capabilities: BrowserObserveCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => true,
  execute: async (_args, ctx) => {
    ctx.abortSignal.throwIfAborted()
    // 页面状态依赖当前站点 session，执行前统一确认 browser mode 仍激活。
    requireActiveBrowserSite(ctx)
    return ctx.browser.getPageState()
  },
})

/** 检查当前页面正文、标题、链接和可交互元素。 */
const browserInspectPage = defineBrowserTool<{
  maxTextChars?: number
  includeHtml?: boolean
  maxHtmlChars?: number
  maxElements?: number
}>({
  name: 'browser_inspect_page',
  role: 'inspect',
  summary: '检查当前浏览器页面的可读内容。',
  suitable: ['需要理解真实网页状态、正文、标题结构、链接摘要和主要交互元素。'],
  forbidden: ['不要用它执行页面动作或读取浏览器工作区文件。'],
  usage: ['按需设置 maxTextChars、maxElements；需要 HTML 时传 includeHtml=true。'],
  examples: [
    // 默认检查
    {},
    // 收紧上限，节省上下文
    { maxTextChars: 20000, maxElements: 120 },
    // 需要原始 HTML 时
    { includeHtml: true, maxTextChars: 8000 },
  ],
  notes: ['交互元素按常见控件优先排序。'],
  schema: z.object({
    maxTextChars: z
      .number()
      .int()
      .positive()
      .max(100000)
      .optional()
      .describe(
        parameterDescription({
          description: '最多返回多少正文字符。',
          notes: ['默认 20000。'],
        })
      ),
    includeHtml: z.boolean().optional().describe(
      parameterDescription({
        description: '是否同时返回裁剪后的 HTML。',
      })
    ),
    maxHtmlChars: z
      .number()
      .int()
      .positive()
      .max(100000)
      .optional()
      .describe(
        parameterDescription({
          description: '最多返回多少 HTML 字符。',
          usage: ['仅 includeHtml=true 时使用。'],
          notes: ['默认 30000。'],
        })
      ),
    maxElements: z
      .number()
      .int()
      .positive()
      .max(400)
      .optional()
      .describe(
        parameterDescription({
          description: '最多返回多少个交互元素。',
          usage: ['大型页面建议显式设置，避免上下文膨胀。'],
          notes: ['默认 80，最大 400。'],
        })
      ),
  }),
  permissions: ['network'],
  capabilities: BrowserObserveCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => true,
  execute: async ({ maxTextChars, includeHtml, maxHtmlChars, maxElements }, ctx) => {
    ctx.abortSignal.throwIfAborted()
    // inspect 是只读，但可能较重；入参上限由 schema 控制。
    requireActiveBrowserSite(ctx)

    return ctx.browser.inspectPage({
      maxTextChars,
      includeHtml,
      maxHtmlChars,
      maxElements,
    })
  },
})

/** 从当前页面检查结果生成可执行动作候选。 */
const browserObserveActions = defineBrowserTool<{
  instruction?: string
  limit?: number
  ignoreSelectors?: string[]
}>({
  name: 'browser_observe_actions',
  role: 'inspect',
  summary: '观察当前页面可执行动作候选。',
  suitable: [
    '需要先找出页面上可能要点击或填写的元素，再选择一个动作执行。',
    '需要生成可缓存、可预览、可传给 browser_act 的动作候选。',
  ],
  forbidden: ['不要用它执行动作；执行候选动作时用 browser_act。'],
  protocol: ['先 observe 候选，展示 preview；执行时调用候选的 replay.tool，并把 replay.input 作为入参。'],
  usage: ['可传 instruction 做轻量过滤和排序；limit 控制返回数量；ignoreSelectors 可排除导航、弹窗、广告等噪音区域。'],
  examples: [{ instruction: 'email', limit: 5 }, { instruction: 'checkout', ignoreSelectors: ['nav', '.cookie-banner'] }],
  notes: [
    '候选来自当前页面 inspection，不调用外部 LLM。',
    'ignoreSelectors 会在生成候选前过滤对应子树，适合排除 cookie banner、固定导航和广告容器。',
    '每个候选包含 actionId、preview 和 replay；target 类动作额外保留兼容旧调用方的 actionInput。',
    '原生 select 会作为需要 value 的 select 候选返回；value 可按 option value 或可见文本匹配。',
    'file input 会作为 upload 候选返回；执行时用 browser_upload_file 并补 filePath。',
    '自定义 dropdown 触发器会带 twoStep=true；先执行 click，再重新 observe 选项。',
  ],
  schema: z.object({
    instruction: z.string().min(1).max(500).optional().describe(
      parameterDescription({
        description: '要观察的动作或元素意图。',
        notes: ['省略时返回页面上优先级最高的常见动作候选。'],
      })
    ),
    limit: z.number().int().positive().max(80).optional().describe(
      parameterDescription({
        description: '最多返回多少个候选动作。',
        notes: ['默认 20。'],
      })
    ),
    ignoreSelectors: z.array(z.string().min(1).max(1000)).max(50).optional().describe(
      parameterDescription({
        description: '生成候选前要忽略的 CSS selector 子树。',
        notes: ['用于过滤导航、cookie banner、广告、侧栏等噪音区域。'],
      })
    ),
  }),
  permissions: ['network'],
  capabilities: BrowserObserveCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => true,
  execute: async ({ instruction, limit, ignoreSelectors }, ctx): Promise<BrowserObserveActionsResult> => {
    ctx.abortSignal.throwIfAborted()
    requireActiveBrowserSite(ctx)

    const normalizedLimit = clampObserveActionLimit(limit)
    const inspection = await ctx.browser.inspectPage({
      maxTextChars: 2_000,
      maxElements: Math.max(80, normalizedLimit * 4),
      ignoreSelectors,
    })

    return buildObserveActionsResult(inspection, instruction, normalizedLimit)
  },
})

/** 截图当前页面并保存到 browser 工作区。 */
const browserCaptureScreenshot = defineBrowserTool<{
  path?: string
  width?: number
  height?: number
  waitForNetworkIdle?: boolean | number
  waitForDomStable?:
    | boolean
    | { stableFrames?: number; sampleIntervalMs?: number; maxWaitMs?: number }
  fullPage?: boolean | { enabled?: boolean; maxWidth?: number; maxHeight?: number }
  annotateElements?: boolean | { enabled?: boolean; maxElements?: number }
  compareWithPrevious?: boolean
}>({
  name: 'browser_capture_screenshot',
  role: 'inspect',
  summary: '截取当前浏览器页面并保存到网站工作区。',
  suitable: ['需要做视觉检查、调试、坐标定位或归档页面状态。'],
  forbidden: ['不要用截图替代可结构化读取的表格、列表或文本。'],
  protocol: ['截图前按需等待网络空闲或 DOM 稳定；截图后使用返回的坐标映射做点击定位。'],
  usage: ['可设置 width/height、fullPage、annotateElements 和等待选项。'],
  examples: [
    // 只截当前视口（默认）
    {},
    // 整页 + 元素编号标注（返回 @e1 这类可直接给 browser_act 的 ref）
    { fullPage: true, annotateElements: true },
  ],
  notes: [
    '图片保存到当前网站浏览器工作区。',
    'annotateElements=true 时 metadata.elementLegend 会返回编号元素的可读 legend；条目的 target.ref 形如 @e1，可在页面变化前直接交给 browser_act。',
  ],
  schema: z.object({
    path: z
      .string()
      .min(1)
      .max(180)
      .optional()
      .describe(
        parameterDescription({
          description: '截图保存到当前网站浏览器工作区内的相对路径。',
          notes: ['省略时写入默认 screenshots 目录。'],
        })
      ),
    width: z.number().int().min(320).max(3840).optional().describe(
      parameterDescription({
        description: '截图视口宽度。',
      })
    ),
    height: z.number().int().min(240).max(2160).optional().describe(
      parameterDescription({
        description: '截图视口高度。',
      })
    ),
    waitForNetworkIdle: z
      .union([z.boolean(), z.number().int().min(100).max(5000)])
      .optional()
      .describe(
        parameterDescription({
          description: '截图前等待网络空闲。',
          values: ['true：使用默认等待。', '数字：表示空闲毫秒数。'],
        })
      ),
    waitForDomStable: z
      .union([
        z.boolean(),
        z.object({
          stableFrames: z.number().int().min(3).max(16).optional(),
          sampleIntervalMs: z.number().int().min(16).max(250).optional(),
          maxWaitMs: z.number().int().min(250).max(8000).optional(),
        }),
      ])
      .optional()
      .describe(
        parameterDescription({
          description: '截图前等待 DOM/layout 连续多帧稳定。',
          usage: ['适合 SPA、动画和骨架屏页面。'],
        })
      ),
    fullPage: z
      .union([
        z.boolean(),
        z.object({
          enabled: z.boolean().optional(),
          maxWidth: z.number().int().min(320).max(32000).optional(),
          maxHeight: z.number().int().min(240).max(32000).optional(),
        }),
      ])
      .optional()
      .describe(
        parameterDescription({
          description: '是否截取完整页面可渲染范围。',
        })
      ),
    annotateElements: z
      .union([
        z.boolean(),
        z.object({
          enabled: z.boolean().optional(),
          maxElements: z.number().int().min(1).max(120).optional(),
        }),
      ])
      .optional()
      .describe(
        parameterDescription({
          description: '截图前是否临时给可交互元素绘制编号。',
          usage: ['用于视觉定位和坐标点击前确认。'],
        })
      ),
    compareWithPrevious: z
      .boolean()
      .optional()
      .describe(
        parameterDescription({
          description: '是否返回与上一次截图的轻量 diff 元数据。',
        })
      ),
  }),
  permissions: ['screen:capture', 'fs:write'],
  capabilities: BrowserArtifactWriteCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  execute: async (
    {
      path,
      width,
      height,
      waitForNetworkIdle,
      waitForDomStable,
      fullPage,
      annotateElements,
      compareWithPrevious,
    },
    ctx
  ) => {
    ctx.abortSignal.throwIfAborted()
    // 截图会写入站点工作区，因此需要 screen:capture 与 fs:write 权限。
    requireActiveBrowserSite(ctx)

    return ctx.browser.captureScreenshot(
      buildBrowserScreenshotOptions({
        path,
        width,
        height,
        waitForNetworkIdle,
        waitForDomStable,
        fullPage,
        annotateElements,
        compareWithPrevious,
        modelFacing: true,
      })
    )
  },
})

/** 按 CSS selector 查询元素并返回可复用 target hint。 */
const browserQueryElements = defineBrowserTool<BrowserQueryElementsInput>({
  name: 'browser_query_elements',
  role: 'inspect',
  summary: '用 CSS selector 查询当前页面元素。',
  suitable: ['需要读取列表、表格、组件文本、属性或可复用 target。'],
  forbidden: ['不要用它执行任意脚本或页面动作。'],
  usage: ['传 selector；按需传 attributes、includeHtml、limit；一层同源 iframe 内元素可用 `iframe[...] >> .inner`。'],
  examples: [{ selector: "[data-testid=price]", limit: 10 }, { selector: 'iframe[name="checkout"] >> .total', limit: 5 }],
  notes: ['只使用受控查询接口。', '`>>` 只进入一层同源 iframe；跨域 iframe、OOPIF 和递归 frame traversal 不在当前页面脚本路径内。'],
  schema: browserQueryElementsSchema,
  surfaces: {
    preset: {
      role: 'inspect',
      summary: '用 CSS selector 查询当前页面元素。',
      suitable: ['只需要默认上限的元素文本和常用属性。'],
      forbidden: ['不要用它请求 HTML 或额外属性；需要时切到 guided/direct。'],
      usage: ['传 selector。'],
      examples: [{ selector: ".product-card" }],
      notes: ['默认最多返回 20 个匹配元素。'],
      schema: z.object({
        selector: z.string().min(1).max(1000).describe(
          parameterDescription({
            description: 'CSS selector；一层同源 iframe 内元素可用 iframe selector >> inner selector。',
          })
        ),
      }),
      normalize: (input) => ({
        selector: isString(input.selector) ? input.selector : '',
        limit: 20,
      }),
    },
    guided: {
      role: 'inspect',
      summary: '用 CSS selector 查询元素并返回 target。',
      suitable: ['需要调整返回上限、属性或 HTML。'],
      forbidden: ['不要用它执行页面动作。'],
      usage: ['传 selector；limit 可省略；一层同源 iframe 内元素可用 `iframe[...] >> .inner`。'],
      examples: [{ selector: "article", limit: 5, attributes: ["href"] }, { selector: 'iframe[name="checkout"] >> .total', limit: 5 }],
      notes: ['省略 limit 时默认 20。'],
      schema: browserQueryElementsGuidedSchema,
      normalize: normalizeBrowserQueryElementsGuided,
    },
  },
  permissions: ['network'],
  capabilities: BrowserObserveCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => true,
  execute: async (input, ctx): Promise<BrowserElementQueryResult> => {
    ctx.abortSignal.throwIfAborted()
    // 仅调用受控查询接口，不执行任意页面脚本。
    requireActiveBrowserSite(ctx)

    return ctx.browser.queryElements(input)
  },
})

/** 读取页面诊断事件，如 console、加载错误和渲染异常。 */
const browserGetPageDiagnostics = defineBrowserTool<BrowserGetPageDiagnosticsInput>({
  name: 'browser_get_page_diagnostics',
  role: 'inspect',
  summary: '读取当前浏览器页面的诊断事件。',
  suitable: ['需要调试网页功能、前端报错、加载失败或自动化失败。'],
  forbidden: ['不要用它读取页面正文或网络响应体。'],
  usage: ['传 limit；读取后需要清空缓存时传 clear=true。'],
  examples: [{ limit: 100 }],
  notes: ['包含近期 console、加载错误、网络诊断和按 level/kind/origin/status/resourceType 聚合的 summary。'],
  schema: browserGetPageDiagnosticsSchema,
  surfaces: {
    preset: {
      role: 'inspect',
      summary: '读取当前页面最近的诊断事件。',
      suitable: ['需要快速查看默认数量的页面诊断。'],
      forbidden: ['不要用它清空诊断缓存。'],
      usage: ['无需参数。'],
      examples: [{}],
      notes: ['默认返回最近 50 条，并包含聚合 summary。'],
      schema: z.object({}),
      normalize: () => ({
        limit: 50,
      }),
    },
    guided: {
      role: 'inspect',
      summary: '读取当前页面诊断事件。',
      suitable: ['需要调整诊断数量或读取后清空缓存。'],
      forbidden: ['不要用它调试非当前页面。'],
      usage: ['可传 limit 和 clear。'],
      examples: [{ limit: 80, clear: true }],
      notes: ['省略 limit 时默认 50，并包含聚合 summary。'],
      schema: browserGetPageDiagnosticsGuidedSchema,
      normalize: normalizeBrowserGetPageDiagnosticsGuided,
    },
  },
  permissions: ['network'],
  capabilities: BrowserObserveCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  // clear=true 会修改诊断缓存，因此不能并发。
  isConcurrencySafe: ({ clear }) => !clear,
  execute: async ({ limit, clear }, ctx): Promise<BrowserPageDiagnostics> => {
    ctx.abortSignal.throwIfAborted()
    // 诊断事件绑定当前受控页面。
    requireActiveBrowserSite(ctx)

    return ctx.browser.getPageDiagnostics({
      limit,
      clear,
    })
  },
})

/** 列出当前页面捕获到的网络诊断事件。 */
const browserListNetworkEvents = defineBrowserTool<BrowserListNetworkEventsInput>({
  name: 'browser_list_network_events',
  role: 'inspect',
  summary: '列出当前页面捕获的网络诊断事件。',
  suitable: ['需要快速定位失败请求、HTTP 错误、被拦截资源或网络异常。'],
  forbidden: ['不要把它当作完整 HAR 或响应体读取工具；这里只返回 diagnostics 中已捕获的网络事件。'],
  usage: ['传 limit；可用 status、resourceType 或 failedOnly 缩小范围。'],
  examples: [{ limit: 100, failedOnly: true }, { limit: 80, status: 404 }],
  notes: ['复用 browser_get_page_diagnostics 的网络事件缓存，并重算过滤后的 summary。'],
  schema: browserListNetworkEventsSchema,
  surfaces: {
    preset: {
      role: 'inspect',
      summary: '列出当前页面最近的网络诊断事件。',
      suitable: ['需要快速查看近期网络错误。'],
      forbidden: ['不要用它清空诊断缓存。'],
      usage: ['无需参数。'],
      examples: [{}],
      notes: ['默认读取最近 50 条诊断事件后只返回网络事件。'],
      schema: z.object({}),
      normalize: () => ({
        limit: 50,
      }),
    },
    guided: {
      role: 'inspect',
      summary: '列出当前页面网络诊断事件。',
      suitable: ['需要按 HTTP status、resourceType 或失败状态过滤。'],
      forbidden: ['不要用它读取完整请求/响应 payload。'],
      usage: ['可传 limit、clear、status、resourceType、failedOnly。'],
      examples: [{ limit: 100, resourceType: 'Fetch', failedOnly: true }],
      notes: ['省略 limit 时默认 50。'],
      schema: browserListNetworkEventsGuidedSchema,
      normalize: normalizeBrowserListNetworkEventsGuided,
    },
  },
  permissions: ['network'],
  capabilities: BrowserObserveCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  // clear=true 会修改诊断缓存，因此不能并发。
  isConcurrencySafe: ({ clear }) => !clear,
  execute: async ({ limit, clear, status, resourceType, failedOnly }, ctx): Promise<BrowserNetworkEventsResult> => {
    ctx.abortSignal.throwIfAborted()
    // 网络事件来自当前受控页面的 diagnostics 缓存。
    requireActiveBrowserSite(ctx)

    const diagnostics = await ctx.browser.getPageDiagnostics({
      limit,
      clear,
    })

    return buildBrowserNetworkEventsResult(diagnostics, {
      limit,
      clear,
      status,
      resourceType,
      failedOnly,
    })
  },
})

/** 按网络诊断事件 requestId 读取外部 CDP 浏览器捕获的响应体。 */
const browserGetNetworkResponseBody = defineBrowserTool<BrowserGetNetworkResponseBodyInput>({
  name: 'browser_get_network_response_body',
  role: 'inspect',
  summary: '读取当前页面某个已捕获网络请求的响应体。',
  suitable: [
    'browser_list_network_events 返回了 requestId，需要查看对应 API 响应体。',
    '需要调试当前页面 XHR/fetch 的 JSON、文本或 base64 响应。',
  ],
  forbidden: [
    '不要用它下载任意 URL；下载资源用 browser_fetch_resource。',
    '不要在没有当前页面 requestId 时调用；先用 browser_list_network_events 找 requestId。',
  ],
  protocol: ['先调用 browser_list_network_events 获取 requestId，再用该 requestId 读取响应体。'],
  usage: ['传 requestId；大响应按需设置 maxChars。'],
  examples: [{ requestId: '12345.67', maxChars: 20000 }],
  notes: [
    '仅外部 CDP 浏览器支持；webview 模式会明确报错。',
    'CDP 可能只保留近期响应体；过旧或跨 target 的 requestId 可能不可读。',
  ],
  schema: browserGetNetworkResponseBodySchema,
  surfaces: {
    guided: {
      role: 'inspect',
      summary: '按 requestId 读取网络响应体。',
      suitable: ['已经从 browser_list_network_events 拿到 requestId。'],
      forbidden: ['不要传 URL；这里只接受 requestId。'],
      usage: ['传 requestId；maxChars 可省略。'],
      examples: [{ requestId: '12345.67' }],
      notes: ['省略 maxChars 时默认 20000。'],
      schema: browserGetNetworkResponseBodyGuidedSchema,
      normalize: normalizeBrowserGetNetworkResponseBodyGuided,
    },
  },
  permissions: ['network'],
  capabilities: BrowserObserveCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => true,
  execute: async (input, ctx) => {
    ctx.abortSignal.throwIfAborted()
    // 响应体来自当前受控页面 CDP Network 缓存，requestId 必须先由网络事件取得。
    requireActiveBrowserSite(ctx)

    return ctx.browser.readNetworkResponseBody(input)
  },
})

/** 按网络诊断事件 requestId 读取请求/响应详情。 */
const browserGetNetworkRequest = defineBrowserTool<BrowserGetNetworkRequestInput>({
  name: 'browser_get_network_request',
  role: 'inspect',
  summary: '读取当前页面某个已捕获网络请求的完整详情。',
  suitable: [
    'browser_list_network_events 返回了 requestId，需要查看请求 headers、postData、响应 headers、timing 或 body size。',
    '需要调试当前页面 XHR/fetch、资源加载、缓存命中或失败原因。',
  ],
  forbidden: [
    '不要把它当作 HAR 导出；这里只返回单个 requestId 的详情。',
    '不要传 URL；必须先通过 browser_list_network_events 获取 requestId。',
  ],
  protocol: [
    '先调用 browser_list_network_events 定位请求；需要 body 时设置 includeResponseBody=true 或改用 browser_get_network_response_body。',
  ],
  usage: ['传 requestId；需要响应体时传 includeResponseBody=true 和可选 maxBodyChars。'],
  examples: [{ requestId: '12345.67' }, { requestId: '12345.67', includeResponseBody: true }],
  notes: [
    '仅外部 CDP 浏览器支持；webview 模式会明确报错。',
    '详情缓存有上限，过旧 requestId 可能不可读。',
  ],
  schema: browserGetNetworkRequestSchema,
  surfaces: {
    guided: {
      role: 'inspect',
      summary: '按 requestId 读取网络请求详情。',
      suitable: ['已经从 browser_list_network_events 拿到 requestId。'],
      forbidden: ['不要传 URL；这里只接受 requestId。'],
      usage: ['传 requestId；includeResponseBody 和 maxBodyChars 可省略。'],
      examples: [{ requestId: '12345.67', includeResponseBody: true }],
      notes: ['省略 includeResponseBody 时不读取响应体；省略 maxBodyChars 时默认 20000。'],
      schema: browserGetNetworkRequestGuidedSchema,
      normalize: normalizeBrowserGetNetworkRequestGuided,
    },
  },
  permissions: ['network'],
  capabilities: BrowserObserveCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => true,
  execute: async (input, ctx) => {
    ctx.abortSignal.throwIfAborted()
    // 详情来自当前受控页面 CDP Network 缓存，requestId 必须先由网络事件取得。
    requireActiveBrowserSite(ctx)

    return ctx.browser.readNetworkRequestDetails(input)
  },
})

/** 列出当前页面捕获到的 console 诊断事件。 */
const browserListConsoleEvents = defineBrowserTool<BrowserListConsoleEventsInput>({
  name: 'browser_list_console_events',
  role: 'inspect',
  summary: '列出当前页面捕获的 console 诊断事件。',
  suitable: ['需要快速定位 console error、warning 或前端运行时报错。'],
  forbidden: ['不要把它当作页面正文读取工具；这里只有 diagnostics 中已捕获的 console 事件。'],
  usage: ['传 limit；可用 level 或 errorsOnly 缩小范围。'],
  examples: [{ limit: 100, errorsOnly: true }, { limit: 80, level: 'warning' }],
  notes: ['复用 browser_get_page_diagnostics 的 console 事件缓存，并重算过滤后的 summary。'],
  schema: browserListConsoleEventsSchema,
  surfaces: {
    preset: {
      role: 'inspect',
      summary: '列出当前页面最近的 console 诊断事件。',
      suitable: ['需要快速查看近期 console 输出。'],
      forbidden: ['不要用它清空诊断缓存。'],
      usage: ['无需参数。'],
      examples: [{}],
      notes: ['默认读取最近 50 条诊断事件后只返回 console 事件。'],
      schema: z.object({}),
      normalize: () => ({
        limit: 50,
      }),
    },
    guided: {
      role: 'inspect',
      summary: '列出当前页面 console 诊断事件。',
      suitable: ['需要按 console level 或 error-only 过滤。'],
      forbidden: ['不要用它读取非 console 诊断事件。'],
      usage: ['可传 limit、clear、level、errorsOnly。'],
      examples: [{ limit: 100, errorsOnly: true }],
      notes: ['省略 limit 时默认 50。'],
      schema: browserListConsoleEventsGuidedSchema,
      normalize: normalizeBrowserListConsoleEventsGuided,
    },
  },
  permissions: ['network'],
  capabilities: BrowserObserveCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  // clear=true 会修改诊断缓存，因此不能并发。
  isConcurrencySafe: ({ clear }) => !clear,
  execute: async ({ limit, clear, level, errorsOnly }, ctx): Promise<BrowserConsoleEventsResult> => {
    ctx.abortSignal.throwIfAborted()
    // Console 事件来自当前受控页面的 diagnostics 缓存。
    requireActiveBrowserSite(ctx)

    const diagnostics = await ctx.browser.getPageDiagnostics({
      limit,
      clear,
    })

    return buildBrowserConsoleEventsResult(diagnostics, {
      limit,
      clear,
      level,
      errorsOnly,
    })
  },
})

/** 列出当前页面捕获到的未处理异常诊断事件。 */
const browserListPageErrors = defineBrowserTool<BrowserListPageErrorsInput>({
  name: 'browser_list_page_errors',
  role: 'inspect',
  summary: '列出当前页面捕获的未处理异常。',
  suitable: ['需要快速定位页面运行时异常、未捕获 JS 错误或自动化后页面报错。'],
  forbidden: ['不要把它当作 console 输出列表；console 输出用 browser_list_console_events。'],
  usage: ['传 limit；读取后需要清空缓存时传 clear=true。'],
  examples: [{ limit: 50, clear: true }],
  notes: ['复用 browser_get_page_diagnostics 的 page-error 事件缓存，并重算过滤后的 summary。'],
  schema: browserListPageErrorsSchema,
  surfaces: {
    preset: {
      role: 'inspect',
      summary: '列出当前页面最近的未处理异常。',
      suitable: ['需要快速查看近期页面异常。'],
      forbidden: ['不要用它清空诊断缓存。'],
      usage: ['无需参数。'],
      examples: [{}],
      notes: ['默认读取最近 50 条诊断事件后只返回 page-error 事件。'],
      schema: z.object({}),
      normalize: () => ({
        limit: 50,
      }),
    },
    guided: {
      role: 'inspect',
      summary: '列出当前页面未处理异常。',
      suitable: ['需要调整诊断数量或读取后清空缓存。'],
      forbidden: ['不要用它读取非 page-error 诊断事件。'],
      usage: ['可传 limit 和 clear。'],
      examples: [{ limit: 80, clear: true }],
      notes: ['省略 limit 时默认 50。'],
      schema: browserListPageErrorsGuidedSchema,
      normalize: normalizeBrowserListPageErrorsGuided,
    },
  },
  permissions: ['network'],
  capabilities: BrowserObserveCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  // clear=true 会修改诊断缓存，因此不能并发。
  isConcurrencySafe: ({ clear }) => !clear,
  execute: async ({ limit, clear }, ctx): Promise<BrowserPageErrorsResult> => {
    ctx.abortSignal.throwIfAborted()
    // 页面异常来自当前受控页面的 diagnostics 缓存。
    requireActiveBrowserSite(ctx)

    const diagnostics = await ctx.browser.getPageDiagnostics({
      limit,
      clear,
    })

    return buildBrowserPageErrorsResult(diagnostics, {
      limit,
      clear,
    })
  },
})

/** 查询 CSS selector 匹配的第一个元素的精确视口坐标（getBoundingClientRect）。 */
const browserGetElementBounds = defineBrowserTool<{
  selector: string
}>({
  name: 'browser_get_element_bounds',
  role: 'inspect',
  summary: '查询元素的精确视口坐标。',
  suitable: ['需要在坐标点击前定位元素的边界和中心点。'],
  forbidden: ['不要用它执行点击；点击用 browser_act action=click_coordinates 或 action=target。'],
  usage: ['传 CSS selector。'],
  examples: [{ selector: "button[type=submit]" }],
  notes: ['未匹配时返回 found=false。'],
  schema: z.object({
    selector: z.string().min(1).max(1000).describe(
      parameterDescription({
        description: '要查询的 CSS selector。',
      })
    ),
  }),
  permissions: ['network'],
  capabilities: BrowserObserveCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => true,
  execute: async ({ selector }, ctx) => {
    ctx.abortSignal.throwIfAborted()
    requireActiveBrowserSite(ctx)

    const selectorLiteral = JSON.stringify(selector)
    return ctx.browser.evaluateScript({
      script: [
        `const el = document.querySelector(${selectorLiteral});`,
        `if (!el) return { found: false, selector: ${selectorLiteral} };`,
        'const r = el.getBoundingClientRect();',
        'return {',
        '  found: true,',
        `  selector: ${selectorLiteral},`,
        '  x: Math.round(r.x),',
        '  y: Math.round(r.y),',
        '  width: Math.round(r.width),',
        '  height: Math.round(r.height),',
        '  centerX: Math.round(r.x + r.width / 2),',
        '  centerY: Math.round(r.y + r.height / 2),',
        '};',
      ].join('\n'),
      mode: 'function-body',
    })
  },
})

/** 截取页面指定区域（selector 或 page-css 矩形）并保存 PNG。 */
const browserCaptureRegion = defineBrowserTool<{
  selector?: string
  x?: number
  y?: number
  width?: number
  height?: number
  path?: string
}>({
  name: 'browser_capture_region',
  role: 'inspect',
  summary: '截取页面指定区域的 PNG 截图。',
  suitable: [
    '需要保存某个 DOM 区块、卡片或图表的所见即所得截图。',
    'browser_capture_screenshot 全页/视口过大时使用。',
  ],
  forbidden: ['跨域 iframe 内区域无法截取。'],
  usage: ['传 selector；或传 x/y/width/height（page CSS 坐标）。'],
  examples: [{ selector: 'article.main', path: 'artifacts/screenshots/article.png' }],
  notes: ['坐标系为 page-css-px（含 scroll）。'],
  schema: z.object({
    selector: z.string().optional().describe(
      parameterDescription({
        description: '要截取区域的 CSS selector。',
        usage: ['与 x/y/width/height 二选一，优先 selector。'],
      })
    ),
    x: z.number().optional().describe(
      parameterDescription({
        description: '区域左上角 page CSS x 坐标。',
      })
    ),
    y: z.number().optional().describe(
      parameterDescription({
        description: '区域左上角 page CSS y 坐标。',
      })
    ),
    width: z.number().positive().optional().describe(
      parameterDescription({
        description: '区域宽度（page CSS px）。',
      })
    ),
    height: z.number().positive().optional().describe(
      parameterDescription({
        description: '区域高度（page CSS px）。',
      })
    ),
    path: z.string().optional().describe(
      parameterDescription({
        description: '保存相对路径。',
        notes: ['默认 artifacts/screenshots/region-<timestamp>.png。'],
      })
    ),
  }),
  permissions: ['screen:capture', 'fs:write'],
  capabilities: BrowserArtifactWriteCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  execute: async ({ selector, x, y, width, height, path }, ctx) => {
    ctx.abortSignal.throwIfAborted()
    requireActiveBrowserSite(ctx)

    if (!selector?.trim() && !(Number.isFinite(x) && Number.isFinite(y) && width && height)) {
      throw new Error('browser_capture_region 需要 selector 或完整的 x/y/width/height。')
    }

    return ctx.browser.captureScreenshot(
      buildBrowserScreenshotOptions({
        path: path ?? `artifacts/screenshots/region-${Date.now()}.png`,
        region: { selector, x, y, width, height },
        modelFacing: true,
      })
    )
  },
})

/** 页面检查类工具出口。 */
const browserInspectionTools = {
  browser_get_page_state: browserGetPageState,
  browser_inspect_page: browserInspectPage,
  browser_observe_actions: browserObserveActions,
  browser_capture_screenshot: browserCaptureScreenshot,
  browser_capture_region: browserCaptureRegion,
  browser_query_elements: browserQueryElements,
  browser_get_page_diagnostics: browserGetPageDiagnostics,
  browser_list_console_events: browserListConsoleEvents,
  browser_list_network_events: browserListNetworkEvents,
  browser_get_network_request: browserGetNetworkRequest,
  browser_get_network_response_body: browserGetNetworkResponseBody,
  browser_list_page_errors: browserListPageErrors,
  browser_get_element_bounds: browserGetElementBounds,
}
export { browserInspectionTools }
