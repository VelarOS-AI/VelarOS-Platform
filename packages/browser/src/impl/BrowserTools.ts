/**
 * 浏览器包的**工具文件**：40 个模型面工具的定义、七个职责分类、常驻集与随包 mod 的清单。
 *
 * 人看这个包先看这里：每个工具的说明、示例、参数 schema、权限与能力标注都在自己的定义里；
 * `execute` 只写一两步，实现多的一行交给 `impl/operations/` 的执行类。入参 schema 本身放在
 * `utils/schemas/`（它们是一批常量与解析函数，和工具定义分开看更清楚），说明与 schema 里的
 * 上限一律引 `contract/constants.ts` 的常量表，改一处模型看到的跟着变。
 */
import { z } from 'zod'

import type { ToolCategoryDefinition } from '@velaros-ai/agent/protocol'
import {
  renderParameterDescription as parameterDescription,
  structureToolDescriptionsForCategory,
} from '@velaros-ai/agent/tool-contract'
import { isBoolean, isNull, isString, optionalWhen } from '@velaros-ai/core'

import {
  BrowserModId,
  BrowserSpaceId,
} from '../contract/constants'
import type {
  BrowserElementQueryResult,
  BrowserEvaluateScriptResult,
  BrowserPageStorageResult,
  BrowserPendingEventKind,
} from '../types/browser.js'
import type {
  BrowserEvaluateScriptInput,
  BrowserGetNetworkRequestInput,
  BrowserGetNetworkResponseBodyInput,
  BrowserGetPageDiagnosticsInput,
  BrowserQueryElementsInput,
  BrowserReadPageDataInput,
  BrowserReadPageStorageInput,
  BrowserTargetHintInput,
  BrowserToolCapabilitySchema,
} from '../types/tools.js'
import { waitForPendingEvent } from '../utils/pending-events'
import { browserActSchema, parseBrowserActInput } from '../utils/schemas/act'
import { browserExtractSchema, parseBrowserExtractInput } from '../utils/schemas/extract'
import { browserFilesSchema, parseBrowserFilesInput } from '../utils/schemas/files'
import {
  browserGetNetworkRequestGuidedSchema,
  browserGetNetworkRequestSchema,
  browserGetNetworkResponseBodyGuidedSchema,
  browserGetNetworkResponseBodySchema,
  browserGetPageDiagnosticsGuidedSchema,
  browserGetPageDiagnosticsSchema,
  browserQueryElementsGuidedSchema,
  browserQueryElementsSchema,
  normalizeBrowserGetNetworkRequestGuided,
  normalizeBrowserGetNetworkResponseBodyGuided,
  normalizeBrowserGetPageDiagnosticsGuided,
  normalizeBrowserQueryElementsGuided,
} from '../utils/schemas/inspection'
import {
  browserEvaluateScriptSchema,
  browserReadPageDataSchema,
  browserReadPageStorageGuidedSchema,
  browserReadPageStorageSchema,
  normalizeBrowserReadPageData,
  normalizeBrowserReadPageStorageGuided,
} from '../utils/schemas/page-data'
import { browserRecipeSchema, parseBrowserRecipeInput } from '../utils/schemas/recipe'
import { browserTargetHintSchema, normalizeBrowserTargetHint } from '../utils/schemas/target'
import { browserUserScriptsSchema } from '../utils/schemas/user-scripts.js'
import { buildBrowserScreenshotOptions } from '../utils/screenshot-options'
import {
  defineBrowserTool,
  hasPendingBrowserEvent,
  requireActiveBrowserSite,
} from '../utils/tool.js'
import { requireBrowserToolCategoryId } from '../utils/tool-categories'

import { BrowserActOperations } from './operations/BrowserActOperations.js'
import { BrowserDevtoolsOperations } from './operations/BrowserDevtoolsOperations.js'
import { BrowserExtractOperations } from './operations/BrowserExtractOperations.js'
import { BrowserFileOperations } from './operations/BrowserFileOperations.js'
import { BrowserInspectOperations } from './operations/BrowserInspectOperations.js'
import { BrowserRecipeOperations } from './operations/BrowserRecipeOperations.js'
import { BrowserSiteOperations } from './operations/BrowserSiteOperations.js'

// ── 能力标注：七个工具族共用的几份，写在这里而不是每个工具各写一遍 ──

const BrowserObserveCapability = {
  effectKind: 'read',
  readScopes: ['browser'],
  canReadArbitrarySource: true,
  concurrency: 'safe',
  metadata: {
    browserAccess: 'observe',
  },
  reason: 'browser page observation',
} satisfies BrowserToolCapabilitySchema

/** 只读等待会占用同一页面事件通道，不能与其它等待并发。 */
const BrowserWaitCapability = {
  ...BrowserObserveCapability,
  concurrency: 'unsafe',
  reason: 'browser pending event wait',
} satisfies BrowserToolCapabilitySchema

const BrowserControlCapability = {
  effectKind: 'external',
  readScopes: ['browser'],
  writeScopes: ['browser'],
  canReadArbitrarySource: true,
  concurrency: 'unsafe',
  metadata: {
    browserAccess: 'control',
    canMutateProject: false,
  },
  reason: 'browser page control',
} satisfies BrowserToolCapabilitySchema

const BrowserArtifactWriteCapability = {
  effectKind: 'write',
  readScopes: ['browser'],
  writeScopes: ['browser'],
  filesystem: { read: 'browser', write: 'browser' },
  canReadArbitrarySource: true,
  concurrency: 'unsafe',
  metadata: {
    browserAccess: 'artifact',
    canMutateProject: false,
  },
  reason: 'browser workspace artifact write',
} satisfies BrowserToolCapabilitySchema

const BrowserSessionCapability = {
  effectKind: 'external',
  readScopes: ['browser', 'system'],
  writeScopes: ['browser'],
  filesystem: { read: 'browser', write: 'browser' },
  canReadArbitrarySource: true,
  concurrency: 'unsafe',
  metadata: {
    browserAccess: 'control',
    canMutateProject: false,
  },
  reason: 'browser session management',
} satisfies BrowserToolCapabilitySchema

// ── 来自 Sessions.tool.ts ──
/** 进入或切换当前 session 的 browser site 工作区。 */
const enterBrowserSite = defineBrowserTool<{ url: string }>({
  name: 'browser:enter_site',
  role: 'control',
  summary: '打开网站并进入浏览器会话。',
  suitable: [
      '用户要求打开、访问、分析或操作某个网页。',
      '当前浏览器会话绑定的网站与目标网站不一致。',
    ],
  forbidden: [
      '不要在没有目标网站时调用。',
    ],
  protocol: [
      '先进入目标网站，再使用 inspect、query、click、screenshot 等浏览器工具。',
      '切换主站点时保留旧站点工作区，并为新站点创建独立工作区。',
    ],
  usage: ['传目标 URL；调用成功后后续 browser 工具绑定该站点。'],
  examples: [{ url: "http://localhost:3000" }],
  notes: ['浏览器工作区按站点隔离，不能跨站点直接读写。'],
  schema: z.object({
    url: z
      .string()
      .min(1)
      .describe(
        parameterDescription({
          description: '要绑定的目标网站 URL。',
          usage: ['支持 https://、http:// 和 localhost。'],
          notes: ['不带协议时默认补全 https://。'],
        })
      ),
  }),
  permissions: ['network', 'fs:write'],
  capabilities: BrowserSessionCapability,
  isConcurrencySafe: () => false,
  execute: async ({ url }, ctx) => new BrowserSiteOperations(ctx).enterSite(url),
})

/** 退出当前 browser site 模式。 */
const leaveBrowserSite = defineBrowserTool<Record<string, never>>({
  name: 'browser:leave_site',
  role: 'control',
  summary: '退出当前浏览器网站会话。',
  suitable: ['不再需要当前网站的浏览器能力。'],
  forbidden: ['不要在仍需继续操作当前网页时调用。'],
  usage: ['调用时传空对象。'],
  examples: [{}],
  notes: ['退出不会删除该站点已有浏览器工作区产物。'],
  schema: z.object({}),
  permissions: [],
  capabilities: BrowserControlCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  execute: async (_input, ctx) => {
    ctx.abortSignal.throwIfAborted()
    // 只解除当前 session 的 browser mode，不删除站点工作区产物。
    await ctx.browser.leaveSite()

    return {
      active: false,
      message: '已退出当前浏览器网站工作区。',
    }
  },
})

/** 显示并连接当前受控浏览器页面。 */
const browserShowPage = defineBrowserTool<Record<string, never>>({
  name: 'browser:show_page',
  role: 'control',
  summary: '显示并连接当前受控浏览器页面。',
  suitable: ['需要让当前已绑定网页在内嵌浏览器中可见。'],
  forbidden: ['不要用它切换网站；切换网站用 browser:enter_site。'],
  usage: ['调用前必须已有 active browser site。'],
  examples: [{}],
  notes: ['只连接当前受控页面，不提供任意脚本执行。'],
  schema: z.object({}),
  permissions: ['network'],
  capabilities: BrowserControlCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  execute: async (_input, ctx) => {
    ctx.abortSignal.throwIfAborted()
    // 即使 isAvailable 已判断一次，执行前仍校验，防止状态在调用间变化。
    requireActiveBrowserSite(ctx)

    return ctx.browser.showPage()
  },
})

/** 枚举当前受控浏览器页面 target。 */
const browserListPageTargets = defineBrowserTool<Record<string, never>>({
  name: 'browser:list_page_targets',
  role: 'inspect',
  summary: '列出当前受控浏览器页面 target。',
  suitable: [
      '需要判断当前浏览器是内嵌 WebView 还是外部 CDP 页面。',
      '需要查看外部浏览器可见的 page target 列表，为后续多标签页控制做判断。',
    ],
  forbidden: [
      '不要用它切换、新建或关闭标签页；它只读当前 target 库存。',
    ],
  usage: ['调用前必须已有 active browser site；传空对象。'],
  examples: [{}],
  notes: ['WebView 路径返回单个 synthetic current target；外部 CDP 路径尽量读取真实 page target list。'],
  schema: z.object({}),
  permissions: ['network'],
  capabilities: BrowserObserveCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => true,
  execute: async (_input, ctx) => {
    ctx.abortSignal.throwIfAborted()
    requireActiveBrowserSite(ctx)

    return ctx.browser.listPageTargets()
  },
})

/** 切换当前受控的外部 CDP 页面 target。 */
const browserSwitchPageTarget = defineBrowserTool<{ targetId: string }>({
  name: 'browser:switch_page_target',
  role: 'control',
  summary: '切换当前受控的外部 CDP page target。',
  suitable: [
      '外部浏览器已有多个 page target，需要把后续 browser 工具绑定到另一个标签页。',
      'browser:list_page_targets 返回了目标 targetId，且用户或任务需要操作该页面。',
    ],
  forbidden: [
      '不要用它切换网站工作区；主站点切换仍使用 browser:enter_site。',
      '不要在内嵌 WebView 路径使用；WebView 当前只有单个 synthetic target。',
    ],
  protocol: [
      '先调用 browser:list_page_targets 获取 targetId。',
      '切换后继续用 browser:inspect_page 或 browser:get_page_state 确认当前受控页面。',
    ],
  usage: ['传 browser:list_page_targets 返回的 targetId。'],
  examples: [{ targetId: 'page-2' }],
  notes: ['只切换当前受控 page driver，不关闭外部浏览器窗口。'],
  schema: z.object({
    targetId: z
      .string()
      .min(1)
      .describe(
        parameterDescription({
          description: '要切换到的 CDP page target id。',
          usage: ['来自 browser:list_page_targets 返回的 targets[].id。'],
        })
      ),
  }),
  permissions: ['network'],
  capabilities: BrowserControlCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  execute: async ({ targetId }, ctx) => {
    ctx.abortSignal.throwIfAborted()
    requireActiveBrowserSite(ctx)

    return ctx.browser.switchPageTarget({ targetId })
  },
})

/** session 类 browser 工具出口。 */

// ── 来自 Inspection.tool.ts ──
/** 读取当前浏览器会话与页面的轻量状态；未进站点时也能调。 */
const browserGetPageState = defineBrowserTool<Record<string, never>>({
  name: 'browser:get_page_state',
  role: 'inspect',
  summary: '查看浏览器会话状态与当前页面的 URL、标题、加载状态。',
  suitable: [
    '动作之前先确认现在是不是已经进了站点、在哪一页。',
    '需要快速确认 URL、标题、加载状态或最近一次导航错误。',
  ],
  forbidden: ['不要用它读页面正文或元素列表；要内容用 browser:inspect_page。'],
  notes: [
    '未进站点时返回 active=false，此时其余浏览器工具都不可用，先调 browser:enter_site。',
    '已进站点时返回 active=true、站点信息与页面状态。',
  ],
  schema: z.object({}),
  permissions: ['network'],
  capabilities: BrowserObserveCapability,
  isConcurrencySafe: () => true,
  execute: async (_input, ctx) => new BrowserSiteOperations(ctx).readPageState(),
})

/** 检查当前页面正文、标题、链接和可交互元素。 */
const browserInspectPage = defineBrowserTool<{
  maxTextChars?: number
  includeHtml?: boolean
  maxHtmlChars?: number
  maxElements?: number
}>({
  name: 'browser:inspect_page',
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
  notes: [
    '交互元素按常见控件优先排序。',
    '返回 target.ref 时应原样用于 browser:act；每次新观察都会生成新的 generation，旧 ref 会明确失效。',
  ],
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
  name: 'browser:observe_actions',
  role: 'inspect',
  summary: '观察当前页面可执行动作候选。',
  suitable: [
    '需要先找出页面上可能要点击或填写的元素，再选择一个动作执行。',
    '需要生成可缓存、可预览、可传给 browser:act 的动作候选。',
  ],
  forbidden: ['不要用它执行动作；执行候选动作时用 browser:act。'],
  protocol: ['先 observe 候选，展示 preview；执行时调用候选的 replay.tool，并把 replay.input 作为入参。'],
  usage: ['可传 instruction 做轻量过滤和排序；limit 控制返回数量；ignoreSelectors 可排除导航、弹窗、广告等噪音区域。'],
  examples: [{ instruction: 'email', limit: 5 }, { instruction: 'checkout', ignoreSelectors: ['nav', '.cookie-banner'] }],
  notes: [
    '候选来自当前页面 inspection，不调用外部 LLM。',
    'ignoreSelectors 会在生成候选前过滤对应子树，适合排除 cookie banner、固定导航和广告容器。',
    '每个候选包含 actionId、preview 和 replay；target 类动作同时提供 actionInput。',
    '原生 select 会作为需要 value 的 select 候选返回；value 可按 option value 或可见文本匹配。',
    'file input 会作为 upload 候选返回；执行时用 browser:upload_file 并补 filePath。',
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
  execute: async (input, ctx) => new BrowserInspectOperations(ctx).observeActions(input),
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
  region?: { selector: string } | { x: number; y: number; width: number; height: number }
}>({
  name: 'browser:capture_screenshot',
  role: 'inspect',
  summary: '截取当前浏览器页面并保存到网站工作区。',
  suitable: ['需要做视觉检查、调试、坐标定位或归档页面状态。'],
  forbidden: ['不要用截图替代可结构化读取的表格、列表或文本。'],
  protocol: ['截图前按需等待网络空闲或 DOM 稳定；截图后使用返回的坐标映射做点击定位。'],
  usage: ['可设置 width/height、fullPage、annotateElements 和等待选项。'],
  examples: [
    // 只截当前视口（默认）
    {},
    // 整页 + 元素编号标注（返回 @e1:g1 这类可直接给 browser:act 的 ref）
    { fullPage: true, annotateElements: true },
  ],
  notes: [
    '图片保存到当前网站浏览器工作区。',
    'annotateElements=true 时 metadata.elementLegend 会返回编号元素的可读 legend；条目的 target.ref 形如 @e1:g1，需原样交给 browser:act。新一次 inspect/标注截图会生成新 generation。',
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
    region: z
      .union([
        z.object({
          selector: z.string().min(1).max(1000).describe('要截的那个元素的 CSS selector。'),
        }),
        z.object({
          x: z.number().int().min(0).max(20000),
          y: z.number().int().min(0).max(20000),
          width: z.number().int().min(1).max(20000),
          height: z.number().int().min(1).max(20000),
        }),
      ])
      .optional()
      .describe(
        parameterDescription({
          description: '只截页面上的一块：给 selector 或给完整的 x/y/width/height。',
          notes: ['省略时截整个视口；与 fullPage 同时给时以 region 为准。'],
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
      region,
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
        region,
        modelFacing: true,
      })
    )
  },
})

/** 按 CSS selector 查询元素并返回可复用 target hint。 */
const browserQueryElements = defineBrowserTool<BrowserQueryElementsInput>({
  name: 'browser:query_elements',
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

/** 读取页面诊断事件：console、网络与未处理异常同一份缓存，按 kind 过滤。 */
const browserGetPageDiagnostics = defineBrowserTool<BrowserGetPageDiagnosticsInput>({
  name: 'browser:get_page_diagnostics',
  role: 'inspect',
  summary: '读取当前页面的 console、网络与未处理异常诊断。',
  suitable: ['调试网页报错、加载失败、接口异常或自动化失败。'],
  forbidden: ['不要用它读页面正文；网络响应体用 browser:get_network_response_body。'],
  examples: [
    // 看整页最近出了什么问题
    { kind: 'all' },
    // 只看失败的请求（过滤先做，再取这么多条）
    { kind: 'network', failedOnly: true, limit: 20 },
    // 只看 console 报错，读完把 console 这一类清掉
    { kind: 'console', errorsOnly: true, clear: true },
  ],
  notes: [
    'kind 选种类；limit 是过滤之后最多返回几条；clear 只清所选的这一类，别的种类不受影响。',
    'kind=network 的回执带 requestId，交给 browser:get_network_request 或 browser:get_network_response_body 读详情。',
  ],
  schema: browserGetPageDiagnosticsSchema,
  surfaces: {
    guided: {
      role: 'inspect',
      summary: '读取当前页面诊断事件。',
      suitable: ['需要调整条数或读完清掉这一类缓存。'],
      forbidden: ['不要用它调试别的页面。'],
      examples: [{ kind: 'network', limit: 80, clear: true }],
      notes: ['省略 limit 时默认 50。'],
      schema: browserGetPageDiagnosticsGuidedSchema,
      normalize: normalizeBrowserGetPageDiagnosticsGuided,
    },
  },
  permissions: ['network'],
  capabilities: BrowserObserveCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  // clear=true 会改诊断缓存，不能并发。
  isConcurrencySafe: ({ clear }) => !clear,
  execute: async (input, ctx) => new BrowserInspectOperations(ctx).readDiagnostics(input),
})

/** 按网络诊断事件 requestId 读取外部 CDP 浏览器捕获的响应体。 */
const browserGetNetworkResponseBody = defineBrowserTool<BrowserGetNetworkResponseBodyInput>({
  name: 'browser:get_network_response_body',
  role: 'inspect',
  summary: '读取当前页面某个已捕获网络请求的响应体。',
  suitable: [
    'browser:list_network_events 返回了 requestId，需要查看对应 API 响应体。',
    '需要调试当前页面 XHR/fetch 的 JSON、文本或 base64 响应。',
  ],
  forbidden: [
    '不要用它下载任意 URL；下载资源用 browser:fetch_resource。',
    '不要在没有当前页面 requestId 时调用；先用 browser:list_network_events 找 requestId。',
  ],
  protocol: ['先调用 browser:list_network_events 获取 requestId，再用该 requestId 读取响应体。'],
  usage: ['传 requestId；大响应按需设置 maxChars。'],
  examples: [{ requestId: '12345.67', maxChars: 20000 }],
  notes: [
    'requestId 来自 browser:list_network_events 的网络事件。',
    '浏览器只保留近期响应体：过旧或跨标签页的 requestId 可能已经读不到。',
  ],
  schema: browserGetNetworkResponseBodySchema,
  surfaces: {
    guided: {
      role: 'inspect',
      summary: '按 requestId 读取网络响应体。',
      suitable: ['已经从 browser:list_network_events 拿到 requestId。'],
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
  name: 'browser:get_network_request',
  role: 'inspect',
  summary: '读取当前页面某个已捕获网络请求的完整详情。',
  suitable: [
    'browser:list_network_events 返回了 requestId，需要查看请求 headers、postData、响应 headers、timing 或 body size。',
    '需要调试当前页面 XHR/fetch、资源加载、缓存命中或失败原因。',
  ],
  forbidden: [
    '不要把它当作 HAR 导出；这里只返回单个 requestId 的详情。',
    '不要传 URL；必须先通过 browser:list_network_events 获取 requestId。',
  ],
  protocol: [
    '先调用 browser:list_network_events 定位请求；需要 body 时设置 includeResponseBody=true 或改用 browser:get_network_response_body。',
  ],
  usage: ['传 requestId；需要响应体时传 includeResponseBody=true 和可选 maxBodyChars。'],
  examples: [{ requestId: '12345.67' }, { requestId: '12345.67', includeResponseBody: true }],
  notes: [
    'requestId 来自 browser:list_network_events 的网络事件。',
    '详情缓存有上限：过旧的 requestId 可能已经读不到。',
  ],
  schema: browserGetNetworkRequestSchema,
  surfaces: {
    guided: {
      role: 'inspect',
      summary: '按 requestId 读取网络请求详情。',
      suitable: ['已经从 browser:list_network_events 拿到 requestId。'],
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

/** 页面检查类工具出口。 */

// ── 来自 Interaction.tool.ts ──
/** 页面交互类工具出口。 */
const browserAct = defineBrowserTool<z.input<typeof browserActSchema>>({
  name: 'browser:act',
  role: 'control',
  summary: '在已进入的浏览器会话中跳转 URL、点击、填写、滚动或等待页面。',
  suitable: [
    '需要直接访问 URL，或点击、填写、选择、清空、选中文本、前进、后退、刷新、滚动、键鼠、等待、视口、缩放、网络或环境模拟控制当前 browser 页面。',
  ],
  forbidden: [
    '不要用它进入或退出 browser site 模式；站点会话仍用 browser:enter_site/browser:leave_site。',
    '不要用坐标点击替代稳定 selector；能定位元素时优先 action=target。',
  ],
  usage: [
    '传 action 选择动作类型，再传该动作需要的字段。',
    'action=target 时传 targetAction，并优先把 inspect 返回的完整 @e…:g… ref 原样放进 targetRef；也可传完整 target。targetAction=fill/select 必须传 value。',
    'action=drag 时传 sourceRef 和 targetRef（或完整 source/target）；action=navigate 可只传 url，系统会按 goto 处理。',
    '页面是异步的：动作之后用 wait_for_selector/wait_for_text/wait 等到位再读结果，别靠重试。',
  ],
  examples: [
    // 点击定位到的元素
    {
      action: 'target',
      targetAction: 'click',
      targetRef: '@e3:g1',
    },
    // 填写输入框：targetAction=fill 必须带字符串 value
    {
      action: 'target',
      targetAction: 'fill',
      targetRef: '@e4:g1',
      value: 'user@example.com',
    },
    // 原生 select 多选：value 传字符串数组
    {
      action: 'target',
      targetAction: 'select',
      targetCss: 'select[multiple]',
      value: ['red', 'blue'],
    },
    // 只传 url，系统按 goto 处理
    {
      action: 'navigate',
      url: 'https://example.com/settings',
    },
    // 向下滚动 800 像素触发懒加载
    {
      action: 'scroll',
      direction: 'down',
      amount: 800,
    },
    // 向当前焦点元素输入文本
    {
      action: 'type',
      text: 'VelarOS',
    },
    // 提交表单：按 Enter；组合键可直接写 Ctrl+a
    {
      action: 'press_key',
      key: 'Enter',
    },
    // 无法稳定定位时按视口坐标点击（兜底）
    {
      action: 'click_coordinates',
      x: 200,
      y: 320,
    },
    // 把一个元素拖到另一个元素
    {
      action: 'drag',
      sourceRef: '@e3:g1',
      targetRef: '@e8:g1',
    },
    // 操作后等待结果元素可见
    {
      action: 'wait_for_selector',
      selector: '.results',
      state: 'visible',
    },
    // 等待加载状态或短暂停顿
    {
      action: 'wait',
      loadState: 'networkidle',
    },
    // 设置页面缩放：zoomAction=set 必须带 zoomFactor
    {
      action: 'set_page_zoom',
      zoomAction: 'set',
      zoomFactor: 1.25,
    },
    // 模拟深色模式 + 慢速 3G（外部 CDP 浏览器）
    {
      action: 'configure_emulation',
      colorScheme: 'dark',
      networkThrottling: 'slow-3g',
    },
  ],
  notes: ['这是 browser 页面动作的唯一公开入口；内部仍按 action 复用导航、键鼠、等待和视口控制实现。'],
  usageSkillId: 'browser-automation-recipes',
  schema: browserActSchema,
  permissions: ['network', 'input:control'],
  capabilities: BrowserControlCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  execute: async (input, ctx) =>
    new BrowserActOperations(ctx).perform(parseBrowserActInput(input)),
})

// ── 来自 PageData.tool.ts ──
/** 读取当前页面 storage；外部 CDP 模式可读取浏览器 cookie jar 元数据。 */
const browserReadPageStorage = defineBrowserTool<BrowserReadPageStorageInput>({
  name: "browser:read_page_storage",
  role: "inspect",
  summary: "读取当前页面的浏览器存储。",
  suitable: ["需要检查页面 localStorage、sessionStorage 或当前页 cookie。"],
  forbidden: ["不要用它读取 Electron、系统级 cookie 或其他站点存储。"],
  usage: [
    "传 limit；按需开启 includeCookies、storageScope 或调整 maxValueChars。",
  ],
  examples: [{ includeCookies: true, limit: 50 }],
  notes: [
    "webview 读取页面可见 cookie；外部 CDP 模式可返回 cookie jar 元数据和 frame origin storage。",
  ],
  schema: browserReadPageStorageSchema,
  surfaces: {
    guided: {
      role: "inspect",
      summary: "读取当前页面的浏览器存储。",
      suitable: ["需要调整读取范围或启用 cookie 读取。"],
      forbidden: ["不要用它读取当前页面之外的存储。"],
      usage: [
        "可传 includeLocalStorage、includeSessionStorage、includeCookies、storageScope 和 limit。",
      ],
      examples: [{ includeCookies: true, limit: 80 }],
      notes: ["省略 limit 时默认每类 50 项。"],
      schema: browserReadPageStorageGuidedSchema,
      normalize: normalizeBrowserReadPageStorageGuided,
    },
    preset: {
      role: "inspect",
      summary: "用默认上限读取当前页面常用存储。",
      suitable: ["需要快速查看 localStorage 和 sessionStorage。"],
      forbidden: ["不要用它调整读取上限。"],
      usage: ["可传 includeCookies。"],
      examples: [{ includeCookies: true }],
      notes: ["需要精细上限时切到 guided/direct。"],
      schema: z.object({
        includeCookies: z
          .boolean()
          .optional()
          .describe(
            parameterDescription({
              description: "是否读取当前页 cookie。",
              notes: ["默认 false。"],
            }),
          ),
      }),
      normalize: (input) => {
        const includeCookies = input.includeCookies;
        return {
          includeCookies: optionalWhen(
            isBoolean(includeCookies),
            Boolean(includeCookies),
          ),
          limit: 50,
        };
      },
    },
  },
  permissions: ["network"],
  capabilities: BrowserObserveCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => true,
  execute: async (
    {
      includeLocalStorage,
      includeSessionStorage,
      includeCookies,
      storageScope,
      cookieScope,
      limit,
      maxValueChars,
    },
    ctx,
  ): Promise<BrowserPageStorageResult> => {
    ctx.abortSignal.throwIfAborted();
    requireActiveBrowserSite(ctx);

    // external CDP 模式会读当前页对应的浏览器 cookie jar；webview 保持页面可见 cookie。
    return ctx.browser.readPageStorage({
      includeLocalStorage,
      includeSessionStorage,
      includeCookies,
      storageScope,
      cookieScope,
      limit,
      maxValueChars,
    });
  },
});

/** 用固定读取预设查询当前页面数据，不向模型开放 JavaScript。 */
const browserReadPageData = defineBrowserTool<BrowserReadPageDataInput>({
  name: "browser:read_page_data",
  role: "inspect",
  summary: "用受控预设读取当前页面数据。",
  suitable: ["需要读取标题、URL、正文、selector 信息、JSON-LD 或媒体 URL。"],
  forbidden: [
    "不要用它执行页面动作或表达任意脚本逻辑。",
    "需要完整页面结构、链接和交互元素时优先用 browser:inspect_page。",
  ],
  protocol: ["选择最窄的 preset，并按需限制 maxChars 或 limit。"],
  usage: ["传 preset；selector_* 预设按需传 selector 和 attribute。"],
  examples: [
    { preset: "body_text", maxChars: 4000 },
    { preset: "selector_text", selector: ".title", limit: 5 },
  ],
  notes: [
    "所有预设只读取页面状态；需要任意 JavaScript 时改用 browser:evaluate_script。",
  ],
  schema: browserReadPageDataSchema,
  permissions: ["network"],
  capabilities: BrowserObserveCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => true,
  execute: async (input, ctx): Promise<BrowserEvaluateScriptResult> => {
    ctx.abortSignal.throwIfAborted();
    requireActiveBrowserSite(ctx);

    return ctx.browser.evaluateScript(normalizeBrowserReadPageData(input));
  },
});

/** 在当前页面沙盒中执行任意 JavaScript。 */
const browserEvaluateScript = defineBrowserTool<BrowserEvaluateScriptInput>({
  name: "browser:evaluate_script",
  role: "control",
  summary: "在当前浏览器页面上下文执行 JavaScript。",
  suitable: [
    "明确需要用自定义 JavaScript 完成其他 browser 工具未覆盖的检查或调试。",
  ],
  forbidden: [
    "不要用它访问 Node、Electron 主进程或系统资源。",
    "不要用它读取标题、URL、正文、selector、JSON-LD 或媒体 URL；改用 browser:read_page_data。",
    "不要在可用专用 browser 工具时优先写脚本。",
  ],
  protocol: [
    "先判断是否有专用工具；必须执行脚本时限制 timeoutMs 和 maxResultChars。",
  ],
  usage: ["传 script；按脚本形态选择 mode。"],
  examples: [
    // 单表达式：mode=expression，直接返回表达式的值
    { script: "document.title", mode: "expression" },
    // 多语句/需要 return：mode=function-body
    {
      script: 'const els = document.querySelectorAll("a"); return els.length',
      mode: "function-body",
      maxResultChars: 2000,
    },
  ],
  notes: ["结果会结构化序列化并裁剪。"],
  schema: browserEvaluateScriptSchema,
  permissions: ["network"],
  capabilities: BrowserControlCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  execute: async (
    { script, mode, timeoutMs, maxResultChars },
    ctx,
  ): Promise<BrowserEvaluateScriptResult> => {
    ctx.abortSignal.throwIfAborted();
    requireActiveBrowserSite(ctx);

    // runtime 会限制执行环境、等待超时，并裁剪序列化后的返回值。
    return ctx.browser.evaluateScript({
      script,
      mode,
      timeoutMs,
      maxResultChars,
    });
  },
});

/** 页面数据类工具出口。 */

// ── 来自 Extraction.tool.ts ──
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
    '返回：table 给 headers/rows/rowCount（没找到表格时 ok=false 并附 error）；list 给 items（title/href/description）；paginate 给 pagesVisited/totalItems/items；content 给 content/format/truncated。',
    'save=true 且提取成功时写入 extracts/，并追加 savedPath/savedRelativePath；paginate 默认保存。',
    '单次提取结果按 JSON 计超过约 20 万字符时直接报错而不是截断；按提示调小 maxRows/maxItems/maxChars 或收窄 selector。',
  ],
  schema: browserExtractSchema,
  permissions: ['network', 'fs:read', 'fs:write'],
  capabilities: BrowserArtifactWriteCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  execute: async (input, ctx) =>
    new BrowserExtractOperations(ctx).run(parseBrowserExtractInput(input)),
})

// ── 来自 Export.tool.ts ──

/** 浏览器网站工作区文件与结构化 artifact 的统一原语入口。 */
const browserFiles = defineBrowserTool<z.input<typeof browserFilesSchema>>({
  name: 'browser:files',
  role: 'edit',
  summary: '统一管理当前网站浏览器工作区文件和结构化 artifact。',
  suitable: [
    '需要列出、读取或写入当前网站工作区文件。',
    '需要列出/写入标准 artifact，或保存当前页面快照。',
  ],
  forbidden: ['不要用它跨网站访问其他 browser 工作区。', '读取文件必须传 endLine 或 maxChars。'],
  protocol: [
    'action=list_files/read_file/write_file 对应普通路径。',
    'action=list_artifacts/write_artifact/save_page_snapshot 对应标准 artifact 目录。',
  ],
  usage: ['传 action，再按 action 提供对应参数；覆盖已有内容必须显式 overwrite=true。'],
  examples: [
    // 列出工作区文件（limit 必填）
    { action: 'list_files', limit: 100 },
    // 读取文件：必须传 maxChars 或 endLine
    { action: 'read_file', path: 'recipes/login.json', maxChars: 12000 },
    // 写普通文件；覆盖已有必须 overwrite=true
    { action: 'write_file', path: 'notes/todo.md', content: '# TODO\n- ...' },
    // 列出标准 artifact
    { action: 'list_artifacts', kind: 'extract', limit: 50 },
    // 写结构化 artifact
    { action: 'write_artifact', kind: 'extract', format: 'json', content: '{...}' },
    // 保存当前页面快照
    { action: 'save_page_snapshot', name: 'login-page' },
  ],
  notes: [
    '这是 browser 文件/产物的唯一公开入口；内部按 action 分派到有界读写实现。',
    'write_file 返回 absolute path 供本机文件链接打开，并返回 relativePath 供展示和持久化。',
  ],
  schema: browserFilesSchema,
  permissions: ['network', 'fs:read', 'fs:write'],
  capabilities: BrowserArtifactWriteCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  execute: async (input, ctx) =>
    new BrowserFileOperations(ctx).run(parseBrowserFilesInput(input)),
})

/** browser 工作区文件/artifact 工具出口。 */

// ── 来自 Fetch.tool.ts ──
const browserFetchResource = defineBrowserTool<{
  url: string;
  savePath: string;
  referer?: string;
}>({
  name: "browser:fetch_resource",
  role: "control",
  summary: "用当前浏览器会话下载远程图片或视频到工作区。",
  suitable: [
    "已从页面拿到可直接访问的 http(s) 媒体 URL。",
    "需要保留登录态或站点 cookie 才能下载的资源。",
  ],
  forbidden: [
    "不要用于 blob:、data: 或 DRM 受保护流。",
    "savePath 只能是当前站点工作区里的相对路径；指向区外的符号链接会被拒绝。",
  ],
  usage: [
    "先用 browser:list_media_sources 或 browser:read_page_data preset=media_sources 找 URL。",
    "传 url 和 savePath（建议 downloads/ 下）；需要时传 referer。",
  ],
  examples: [
    {
      url: "https://example.com/assets/hero.jpg",
      savePath: "downloads/hero.jpg",
    },
  ],
  notes: ["使用当前页面 session cookie；单文件上限 50MB。"],
  schema: z.object({
    url: z
      .string()
      .url()
      .max(4096)
      .describe(
        parameterDescription({
          description: "要下载的 http(s) 资源 URL。",
        }),
      ),
    savePath: z
      .string()
      .min(1)
      .max(4096)
      .describe(
        parameterDescription({
          description: "保存路径（相对 browser workspace）。",
          usage: ["建议放在 downloads/ 目录。"],
        }),
      ),
    referer: z
      .string()
      .url()
      .max(4096)
      .optional()
      .describe(
        parameterDescription({
          description: "可选 Referer；省略时使用当前页面 URL。",
        }),
      ),
  }),
  permissions: ["network", "fs:write"],
  capabilities: BrowserControlCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  execute: async (args, ctx) => {
    ctx.abortSignal.throwIfAborted();
    requireActiveBrowserSite(ctx);
    return ctx.browser.fetchResource(args);
  },
});

const browserListMediaSources = defineBrowserTool<{
  limit?: number;
  includeDataUrls?: boolean;
  includeBlobUrls?: boolean;
}>({
  name: "browser:list_media_sources",
  role: "inspect",
  summary: "列出当前页面上的图片、视频和音频 URL。",
  suitable: [
    "需要批量发现页面媒体资源再逐个下载。",
    "browser:inspect_page 未直接给出媒体 URL 时。",
  ],
  forbidden: ["不要指望枚举到跨域 iframe 内或 DRM 保护的媒体。"],
  usage: ["无需参数；按需调整 limit 或包含 data/blob URL。"],
  examples: [{ limit: 40 }],
  notes: ["fetchable=true 的 URL 可直接传给 browser:fetch_resource。"],
  schema: z.object({
    limit: z
      .number()
      .transform((value) => Math.min(200, Math.max(1, Math.round(value))))
      .optional()
      .describe(
        parameterDescription({
          description: "最多返回多少条。",
          notes: ["默认 80。", "上限 200,超出自动钳制。"],
        }),
      ),
    includeDataUrls: z
      .boolean()
      .optional()
      .describe(
        parameterDescription({
          description: "是否包含 data: URL。",
          notes: ["默认 false。"],
        }),
      ),
    includeBlobUrls: z
      .boolean()
      .optional()
      .describe(
        parameterDescription({
          description: "是否包含 blob: URL。",
          notes: ["默认 false；blob URL 无法直接 fetch。"],
        }),
      ),
  }),
  permissions: ["network"],
  capabilities: BrowserObserveCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => true,
  execute: async (args, ctx) => {
    ctx.abortSignal.throwIfAborted();
    requireActiveBrowserSite(ctx);
    return ctx.browser.listMediaSources(args);
  },
});

const browserListPageResources = defineBrowserTool<{
  limit?: number;
  includeIframes?: boolean;
}>({
  name: "browser:list_page_resources",
  role: "inspect",
  summary: "枚举页面链接、iframe 与媒体资源概览。",
  suitable: [
    "需要盘点页面全部可见链接与嵌入资源。",
    "制定批量下载或提取计划前的资源清单。",
  ],
  forbidden: ["跨域 iframe 内部链接无法枚举。"],
  usage: ["无需参数；按需调整 limit 或 includeIframes。"],
  examples: [{ limit: 80, includeIframes: true }],
  notes: [
    "媒体详情用 browser:list_media_sources；fetchable URL 用 browser:fetch_resource。",
  ],
  schema: z.object({
    limit: z
      .number()
      .transform((value) => Math.min(500, Math.max(1, Math.round(value))))
      .optional()
      .describe(
        parameterDescription({
          description: "链接/iframe 最多返回多少条。",
          notes: ["默认 120。", "上限 500,超出自动钳制。"],
        }),
      ),
    includeIframes: z
      .boolean()
      .optional()
      .describe(
        parameterDescription({
          description: "是否包含 iframe 列表。",
          notes: ["默认 true。"],
        }),
      ),
  }),
  permissions: ["network"],
  capabilities: BrowserObserveCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => true,
  execute: async (args, ctx) => {
    ctx.abortSignal.throwIfAborted();
    requireActiveBrowserSite(ctx);
    return ctx.browser.listPageResources(args);
  },
});

// ── 来自 Upload.tool.ts ──
const browserUploadFile = defineBrowserTool<{
  target: BrowserTargetHintInput
  filePath: string
}>({
  name: 'browser:upload_file',
  role: 'control',
  summary: '向 file input 上传本地文件。',
  suitable: [
    '页面有 <input type="file"> 需要选择文件。',
    'target 来自 inspect/query 或元素选择器。',
  ],
  forbidden: [
    '不要传绝对路径或站点工作区外的文件；工作区里指向区外的符号链接同样会被拒绝。',
    '不要用于非 file input 元素。',
  ],
  usage: ['传 target 定位 file input；filePath 是当前站点工作区里的相对路径，例如 downloads/report.pdf。'],
  examples: [
    {
      target: { css: 'input[type=file][name=document]' },
      filePath: 'artifacts/uploads/sample.pdf',
    },
  ],
  notes: ['底层使用 CDP DOM.setFileInputFiles。'],
  schema: z.object({
    target: browserTargetHintSchema.describe(
      parameterDescription({
        description: 'file input 元素定位线索。',
      })
    ),
    filePath: z.string().min(1).max(4096).describe(
      parameterDescription({
        description: '要上传的文件路径（browser workspace 内）。',
      })
    ),
  }),
  permissions: ['network'],
  capabilities: BrowserControlCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  execute: async ({ target, filePath }, ctx) => {
    ctx.abortSignal.throwIfAborted()
    requireActiveBrowserSite(ctx)

    return ctx.browser.uploadFile({
      target: normalizeBrowserTargetHint(target),
      filePath,
    })
  },
})

// ── 来自 Events.tool.ts ──
const browserListPendingEvents = defineBrowserTool<Record<string, never>>({
  name: 'browser:list_pending_events',
  role: 'inspect',
  summary: '列出当前页面待处理的阻塞事件。',
  suitable: [
    '需要确认是否有未处理的 JS 弹窗、下载或权限请求。',
    'browser:get_page_diagnostics 显示 pending 事件后进一步定位 eventId。',
  ],
  forbidden: ['不要用它代替具体的 handle 工具。'],
  usage: ['无需参数；返回 pending 数组。'],
  examples: [{}],
  notes: ['事件会在超时后自动回退到默认策略。'],
  schema: z.object({}),
  permissions: ['network'],
  capabilities: BrowserObserveCapability,
  isAvailable: (ctx) => hasPendingBrowserEvent(ctx),
  isConcurrencySafe: () => true,
  execute: async (_args, ctx) => {
    ctx.abortSignal.throwIfAborted()
    requireActiveBrowserSite(ctx)
    return ctx.browser.listPendingEvents()
  },
})

const browserWaitForPendingEvent = defineBrowserTool<{
  kind?: BrowserPendingEventKind
  timeoutMs?: number
}>({
  name: 'browser:wait_for_pending_event',
  role: 'inspect',
  summary: '等待当前页面出现待处理的浏览器阻塞事件。',
  suitable: [
    '点击下载、触发权限请求或弹窗后，需要等待 pending 事件出现。',
    '下载动作后等待 download 事件，再调用 browser:handle_download 接受或取消。',
  ],
  forbidden: ['不要用它处理事件；处理仍使用 browser:handle_dialog/browser:handle_download/browser:handle_permission。'],
  usage: ['默认 kind=download；可传 kind=dialog/download/permission 和 timeoutMs。'],
  examples: [{ kind: 'download', timeoutMs: 1000 }],
  notes: ['返回 event 后，再用对应 handle 工具处理 eventId。'],
  schema: z.object({
    kind: z.enum(['dialog', 'download', 'permission']).optional().describe(
      parameterDescription({
        description: '要等待的 pending 事件类型。',
        notes: ['默认 download。'],
      })
    ),
    timeoutMs: z.number().transform((value) => Math.min(60000, Math.max(1, Math.round(value)))).optional().describe(
      parameterDescription({
        description: '最长等待毫秒数。',
        notes: ['默认 5000。', '上限 60000,超出自动钳制。'],
      })
    ),
  }),
  permissions: ['network'],
  capabilities: BrowserWaitCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  execute: async ({ kind = 'download', timeoutMs }, ctx) => {
    ctx.abortSignal.throwIfAborted()
    requireActiveBrowserSite(ctx)

    return waitForPendingEvent({
      kind,
      timeoutMs,
      abortSignal: ctx.abortSignal,
      listPendingEvents: () => ctx.browser.listPendingEvents(),
    })
  },
})

const browserHandleDialog = defineBrowserTool<{
  eventId?: string
  accept: boolean
  promptText?: string
}>({
  name: 'browser:handle_dialog',
  role: 'control',
  summary: '处理待处理的 JS 弹窗（alert/confirm/prompt）。',
  suitable: ['页面出现 alert、confirm 或 prompt 弹窗阻塞自动化。'],
  forbidden: ['不要在无 pending dialog 时调用。'],
  usage: ['accept=true 确认；accept=false 取消；prompt 可传 promptText。'],
  examples: [
    // 确认 alert/confirm
    { accept: true },
    // 取消/拒绝
    { accept: false },
    // 给 prompt 弹窗填值并确认
    { accept: true, promptText: 'VelarOS' },
  ],
  notes: ['可先调用 browser:list_pending_events 获取 eventId。'],
  schema: z.object({
    eventId: z.string().optional().describe(
      parameterDescription({
        description: '待处理事件 ID；省略时处理最早的一个 dialog。',
      })
    ),
    accept: z.boolean().describe(
      parameterDescription({
        description: 'true 确认，false 取消/拒绝。',
      })
    ),
    promptText: z.string().optional().describe(
      parameterDescription({
        description: 'prompt 弹窗的输入文本。',
        usage: ['仅 prompt 类型需要。'],
      })
    ),
  }),
  permissions: ['network'],
  capabilities: BrowserControlCapability,
  isAvailable: (ctx) => hasPendingBrowserEvent(ctx, 'dialog'),
  isConcurrencySafe: () => false,
  execute: async (args, ctx) => {
    ctx.abortSignal.throwIfAborted()
    requireActiveBrowserSite(ctx)
    return ctx.browser.handleDialog(args)
  },
})

const browserHandleDownload = defineBrowserTool<{
  eventId?: string
  action: 'accept' | 'cancel'
  savePath?: string
}>({
  name: 'browser:handle_download',
  role: 'control',
  summary: '接受或取消待处理的页面下载。',
  suitable: ['页面触发文件下载并阻塞后续操作时。'],
  forbidden: ['accept 时不要省略 savePath。'],
  usage: ['action=accept 时传 savePath（浏览器工作区相对路径）；action=cancel 取消下载。'],
  examples: [{ action: 'accept', savePath: 'downloads/report.pdf' }],
  notes: ['savePath 只能是当前站点工作区里的相对路径；指向区外的符号链接会被拒绝。'],
  schema: z
    .object({
      eventId: z.string().optional().describe(
        parameterDescription({
          description: '待处理下载事件 ID；省略时处理最早的一个。',
        })
      ),
      action: z.enum(['accept', 'cancel']).describe(
        parameterDescription({
          description: 'accept 保存到 savePath；cancel 取消下载。',
        })
      ),
      savePath: z.string().optional().describe(
        parameterDescription({
          description: '保存路径（相对 browser workspace）。',
          usage: ['action=accept 时必填。'],
        })
      ),
    })
    .superRefine((input, issueCtx) => {
      if (input.action === 'accept' && !input.savePath?.trim()) {
        issueCtx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['savePath'],
          message: 'accept 下载必须提供 savePath。',
        })
      }
    }),
  permissions: ['network'],
  capabilities: BrowserControlCapability,
  isAvailable: (ctx) => hasPendingBrowserEvent(ctx, 'download'),
  isConcurrencySafe: () => false,
  execute: async (args, ctx) => {
    ctx.abortSignal.throwIfAborted()
    requireActiveBrowserSite(ctx)
    return ctx.browser.handleDownload(args)
  },
})

const browserHandlePermission = defineBrowserTool<{
  eventId?: string
  grant: boolean
}>({
  name: 'browser:handle_permission',
  role: 'control',
  summary: '允许或拒绝待处理的浏览器权限请求。',
  suitable: ['页面请求 geolocation、notifications、clipboard 等权限时。'],
  forbidden: ['不要对非 pending 权限随意调用。'],
  usage: ['grant=true 允许；grant=false 拒绝。'],
  examples: [{ grant: true }],
  notes: ['可先调用 browser:list_pending_events 查看 permission 详情。'],
  schema: z.object({
    eventId: z.string().optional().describe(
      parameterDescription({
        description: '待处理权限事件 ID；省略时处理最早的一个。',
      })
    ),
    grant: z.boolean().describe(
      parameterDescription({
        description: 'true 允许权限；false 拒绝。',
      })
    ),
  }),
  permissions: ['network'],
  capabilities: BrowserControlCapability,
  isAvailable: (ctx) => hasPendingBrowserEvent(ctx, 'permission'),
  isConcurrencySafe: () => false,
  execute: async (args, ctx) => {
    ctx.abortSignal.throwIfAborted()
    requireActiveBrowserSite(ctx)
    return ctx.browser.handlePermission(args)
  },
})

// ── 来自 Performance.tool.ts ──
/**
 * 性能分析工具，沿用 `chrome-devtools-mcp` 的 `performance_*` 工具能力。
 *
 * 底层使用开发者工具官方追踪引擎：通过 `CDP Tracing` 录制数据，解析 `LCP`、`INP`、`CLS`
 * 等指标与诊断结论，并支持按需深入分析单项结论。
 */
const browserPerformance = defineBrowserTool<{
  // action 可省略:带 insightSetId/insightName 时 schema transform 推断为 analyze_insight。
  action?: 'start_trace' | 'stop_trace' | 'analyze_insight' | 'take_heapsnapshot'
  reload?: boolean
  autoStopMs?: LooseOptional<number>
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
    {
      action: 'analyze_insight',
      insightSetId: 'NAV-1',
      insightName: 'LCPBreakdown',
    },
    // 采集 V8 堆快照落盘（配合 memlab 排查泄漏）
    { action: 'take_heapsnapshot' },
  ],
  notes: ['trace 与堆快照落盘 artifacts/ 下，DevTools 面板或 memlab 可直接消费。'],
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
      reload: z
        .boolean()
        .optional()
        .describe(
          parameterDescription({
            description: 'start_trace 是否先重载页面录完整加载；默认 true，录交互时传 false。',
          })
        ),
      autoStopMs: z
        .number()
        .nullable()
        .transform((value) =>
          isNull(value) ? null : Math.min(60_000, Math.max(1000, Math.round(value)))
        )
        .optional()
        .describe(
          parameterDescription({
            description: 'start_trace 录制窗口毫秒数；默认 5000，null 表示录到 stop_trace。',
            notes: ['范围 [1000,60000],超出自动钳制。'],
          })
        ),
      insightSetId: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe(
          parameterDescription({
            description: 'analyze_insight 的 insight 集合 id（取自 trace 摘要清单）。',
          })
        ),
      insightName: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe(
          parameterDescription({
            description: 'analyze_insight 的 insight 名称，例如 LCPBreakdown。',
          })
        ),
      path: z
        .string()
        .min(1)
        .max(300)
        .optional()
        .describe(
          parameterDescription({
            description: 'take_heapsnapshot 保存相对路径；缺省 artifacts/memory/ 下按时间戳命名。',
          })
        ),
    })
    // 缺 action 但带 insight 字段 → 推断 analyze_insight(这两个字段只属于该动作,推断无歧义)。
    .transform((input) => {
      if (!input.action && (input.insightSetId?.trim() || input.insightName?.trim()))
        return { ...input, action: 'analyze_insight' as const }
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
  execute: async (input, ctx) => new BrowserDevtoolsOperations(ctx).performance(input),
})

// ── 来自 Screencast.tool.ts ──
/** 页面录屏：CDP screencast 帧流 → GIF 产物,点开即播。 */
const browserScreencast = defineBrowserTool<{
  action: 'start' | 'stop'
  maxWidth?: number
  everyNthFrame?: number
  name?: string
}>({
  name: 'browser:screencast',
  role: 'control',
  summary: '录制页面操作过程并合成 GIF（回放/取证/演示）。',
  suitable: ['用户要求录下操作过程，或需要给关键流程留可回放的操作证据。'],
  forbidden: ['静态页面截图用 browser:capture_screenshot；录屏只为过程。'],
  usage: [
    'action=start 开始录制 → 执行页面操作 → action=stop 合成 GIF 并返回路径。',
    '页面无变化不产生新帧；达到帧数上限会自动截断。',
  ],
  examples: [{ action: 'start' }, { action: 'stop', name: 'login-flow' }],
  notes: ['GIF 落盘 artifacts/recordings/，文件管理器/聊天里点开即播。'],
  schema: z
    .object({
      action: z.enum(['start', 'stop']).describe(
        parameterDescription({
          description: '录屏动作。',
          values: ['start：开始录制。', 'stop：停止并合成 GIF。'],
        })
      ),
      maxWidth: z.number().int().min(240).max(1600).optional().describe(
        parameterDescription({
          description: 'start 的帧最大宽度；默认 800，越大文件越大。',
        })
      ),
      everyNthFrame: z.number().int().min(1).max(10).optional().describe(
        parameterDescription({
          description: 'start 的抽帧间隔（每 N 帧取 1）；默认 2。',
        })
      ),
      name: z.string().min(1).max(60).optional().describe(
        parameterDescription({
          description: 'stop 的产物名；缺省按时间戳命名。',
        })
      ),
    })
    ,
  permissions: ['fs:write'],
  capabilities: BrowserControlCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  execute: async (input, ctx) => new BrowserDevtoolsOperations(ctx).screencast(input),
})

// ── 来自 Recipe.tool.ts ──
/** recipe 自动化工具出口。 */
const browserRecipe = defineBrowserTool<z.input<typeof browserRecipeSchema>>({
  name: 'browser:recipe',
  role: 'edit',
  summary: '统一管理当前网站的 browser recipe skeleton 和运行记录。',
  suitable: [
    '需要生成、预览、执行或重跑当前 browser site 的 recipe。',
    '需要读取 recipe skeleton 或历史 run record。',
  ],
  forbidden: [
    '不要用它读取普通 browser 工作区文件；文件和 artifact 读写使用 browser:files。',
    '不要首次运行新 recipe 时直接跳过 dryRun 预检。',
  ],
  protocol: ['真实执行前先 action=run_skeleton dryRun=true 预检；确认目标命中后再执行。'],
  usage: [
    '传 action 选择 generate/read/run/rerun，再传 path、inputs 或模板参数。',
    'rerun_from_run 不沿用历史 inputs，必须重新传。',
  ],
  examples: [
    // 从当前页面生成 recipe 草稿
    { action: 'generate_skeleton', template: 'search', name: 'site-search' },
    // 读取草稿步骤
    { action: 'read_skeleton', path: 'recipes/search.json', maxSteps: 20 },
    // 真跑前先 dryRun 预检
    { action: 'run_skeleton', path: 'recipes/search.json', dryRun: true },
    // 确认命中后真实执行并传输入
    { action: 'run_skeleton', path: 'recipes/search.json', inputs: { q: 'VelarOS' } },
    // 基于历史 run 重跑（须重新传 inputs）
    { action: 'rerun_from_run', path: 'runs/search-001.json', inputs: { q: 'VelarOS' } },
  ],
  notes: ['这是 browser recipe 的唯一公开入口；内部仍按 action 复用 skeleton、run 和 rerun 实现。'],
  usageSkillId: 'browser-automation-recipes',
  schema: browserRecipeSchema,
  permissions: ['network', 'fs:read', 'fs:write'],
  capabilities: BrowserControlCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  execute: async (input, ctx) =>
    new BrowserRecipeOperations(ctx).run(parseBrowserRecipeInput(input)),
})

// ── 来自 UserScripts.tool.ts ──
const browserUserScripts = defineBrowserTool<z.input<typeof browserUserScriptsSchema>>({
  name: 'browser:user_scripts',
  role: 'edit',
  summary: '按 VelarOS 自有契约管理可跨站匹配并自动注入的浏览器脚本。',
  suitable: [
    '用户希望下次进入某个网站时自动执行一段 plain JavaScript。',
    '需要列出、读取、创建、修改、启停、删除或立即运行站点脚本。',
  ],
  forbidden: [
    '不要从 JavaScript 源码注释推断元数据；名称、URL 规则、运行时机和执行环境只认 VelarOS 契约字段。',
    '不要为内部页、file: 或非 http/https URL 创建规则。',
    '未经用户明确确认，不要启用脚本、扩大 match 范围或切换到 main world。',
  ],
  protocol: [
    'create 总是以 disabled 保存；先向用户展示 name/match/world/runAt，再经明确确认调用 set_enabled。',
    'update 修改代码或执行范围后会自动 disabled，必须重新确认后启用。',
    '默认 world=isolated；只有脚本必须访问页面自身 JavaScript 对象时才考虑 main。',
    '禁用或删除不会回滚当前文档已执行的副作用，需要刷新页面。',
  ],
  usage: [
    '优先使用精确 host/path match，避免 <all_urls>；用 list 查看摘要，只有确需源码时再 read。',
  ],
  examples: [
    {
      action: 'create',
      name: 'Hide newsletter popup',
      code: "document.querySelector('[data-newsletter-popup]')?.remove()",
      match: ['https://example.com/*'],
      runAt: 'document-end',
      world: 'isolated',
    },
  ],
  notes: [
    'external CDP 与 document-start v1 会返回 unsupported，不会伪报注入成功。',
    '脚本按 document + revision 幂等，单脚本失败不会阻断页面或其他脚本。',
  ],
  usageSkillId: 'browser-automation-recipes',
  schema: browserUserScriptsSchema,
  permissions: ['network', 'fs:read', 'fs:write'],
  capabilities: BrowserArtifactWriteCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  execute: async (input, ctx) =>
    new BrowserSiteOperations(ctx).manageUserScripts(browserUserScriptsSchema.parse(input)),
})

/** session 类工具。 */
const browserSessionTools = {
  'browser:enter_site': enterBrowserSite,
  'browser:leave_site': leaveBrowserSite,
  'browser:show_page': browserShowPage,
  'browser:list_page_targets': browserListPageTargets,
  'browser:switch_page_target': browserSwitchPageTarget,
}

/** 页面观察类工具。 */
const browserInspectionTools = {
  'browser:get_page_state': browserGetPageState,
  'browser:inspect_page': browserInspectPage,
  'browser:observe_actions': browserObserveActions,
  'browser:capture_screenshot': browserCaptureScreenshot,
  'browser:query_elements': browserQueryElements,
  'browser:get_page_diagnostics': browserGetPageDiagnostics,
  'browser:get_network_response_body': browserGetNetworkResponseBody,
  'browser:get_network_request': browserGetNetworkRequest,
}

/** 页面交互类工具。 */
const browserInteractionTools = {
  'browser:act': browserAct,
}

/** 页面数据读取类工具。 */
const browserPageDataTools = {
  'browser:read_page_storage': browserReadPageStorage,
  'browser:read_page_data': browserReadPageData,
  'browser:evaluate_script': browserEvaluateScript,
}

/** 页面结构化抽取类工具。 */
const browserExtractionTools = {
  'browser:extract': browserExtract,
}

/** 站点工作区文件与产物类工具。 */
const browserArtifactTools = {
  'browser:files': browserFiles,
}

/** 资源抓取与清单类工具。 */
const browserFetchTools = {
  'browser:fetch_resource': browserFetchResource,
  'browser:list_media_sources': browserListMediaSources,
  'browser:list_page_resources': browserListPageResources,
}

/** 文件上传类工具。 */
const browserUploadTools = {
  'browser:upload_file': browserUploadFile,
}

/** 挂起事件类工具。 */
const browserEventTools = {
  'browser:list_pending_events': browserListPendingEvents,
  'browser:wait_for_pending_event': browserWaitForPendingEvent,
  'browser:handle_dialog': browserHandleDialog,
  'browser:handle_download': browserHandleDownload,
  'browser:handle_permission': browserHandlePermission,
}

/** 性能分析类工具。 */
const browserPerformanceTools = {
  'browser:performance': browserPerformance,
}

/** 录屏类工具。 */
const browserScreencastTools = {
  'browser:screencast': browserScreencast,
}

/** recipe 类工具。 */
const browserRecipeTools = {
  'browser:recipe': browserRecipe,
}

/** 站点用户脚本类工具。 */
const browserUserScriptTools = {
  'browser:user_scripts': browserUserScripts,
}

/** 40 个模型面工具的全集：分类里的七页并起来就是它。 */
const rawBrowserTools = {
  ...browserSessionTools,
  ...browserInspectionTools,
  ...browserInteractionTools,
  ...browserEventTools,
  ...browserUploadTools,
  ...browserFetchTools,
  ...browserPageDataTools,
  ...browserExtractionTools,
  ...browserPerformanceTools,
  ...browserScreencastTools,
  ...browserArtifactTools,
  ...browserRecipeTools,
  ...browserUserScriptTools,
}

/** Browser Use 工具集合：说明按 browser 类别统一结构化之后的那一份。 */
const browserTools = structureToolDescriptionsForCategory(rawBrowserTools, 'browser')

// @arch-guard:suspend code-style/require-chinese-comments 理由：本块为中文说明，技术标识符（availableInSpaces/localhost/composeAgentModSpaces 等）密度触发启发式误报。
/**
 * 浏览器工具**客居**的绑根空间（project 空间由 `@velaros-ai/project` 贡献）。
 *
 * 为什么浏览器能力要伸进项目空间：前端开发最高频的一句话是「起服务，打开 localhost:3000
 * 看看渲染对不对」。此前项目空间唯一的取网口是 `web:read`——只回正文文本，不能截图、
 * 不能点击，于是「改一行 CSS 看效果」在产品里跨不过去，用户只能另开一个没有项目根的
 * 浏览器会话（看不到代码、也改不了代码）。跨空间重复能力会让这条常见工作流付出额外切换代价。
 *
 * 只写进 `availableInSpaces`、**不写** `residentInSpaces`：客居 = 可用不常驻。项目空间每轮
 * 的 schema 仍是项目那套，浏览器工具留在 loadable 由模型按名换入（`browser:enter_site`
 * 没有 `isAvailable` 门，可自举）。写进常驻集就等于给每个项目会话每轮塞六个浏览器工具。
 *
 * 装配前提：本 mod 与 project mod 同装（Desktop 出厂即如此）。`composeAgentModSpaces`
 * 对不存在的空间**当场抛错**——那是刻意的，引用一个没人贡献的空间属于无效装配。
 * 继承 project 配方的其他空间也会自动继承本条，不需要再点名一次。
 */
const BrowserGuestSpaceIds = ['project'] as const

/**
 * 浏览器空间的常驻工具（每轮都带真实 schema 进请求）。
 *
 * 只钉「进站 — 看 — 动 — 等 — 取」这条主回路：不进站点其余工具全都隐身，所以
 * `browser:enter_site` 必须常驻，否则模型得先换入一个工具才能开始。看页面是动作的前提，
 * 动作后要等事件、要取内容。其余二十多个工具（网络/媒体/录屏/下载/用户脚本/性能…）都是
 * 排障或特化场景，留在 loadable，由模型从 `tooling:map` 按名换入——常驻不是「装得下就都装」。
 */
const BrowserResidentToolNames = new Set<string>([
  'browser:enter_site',
  'browser:inspect_page',
  'browser:act',
  'browser:extract',
  'browser:capture_screenshot',
  'browser:get_page_state',
  'browser:wait_for_pending_event',
])

/**
 * 浏览器职责分类：一个分类 = 一个使用场景（4–8 个工具），不是一个实现文件。
 *
 * 32 个工具全压在一个 `browser` 分类里时，「按类换入」的粒度等于「全都换进来」——
 * 模型要一个 `browser:handle_dialog` 就得把网络、录屏、用户脚本一起拖进目录。
 * 拆成七页之后跨场景需求走**一次 pageIn 传多页**（协议本就收数组），不需要新机制。
 *
 * 分类归属是**唯一事实来源**：每个工具恰好落一页，七页并集 = `browserTools` 全集。
 */
const BrowserToolNamesByCategory = {
  /** 跑通一次自动化的最小回路：进站 — 看 — 动 — 取 — 等。恰好等于常驻集。 */
  'browser-core': [
    'browser:enter_site',
    'browser:inspect_page',
    'browser:act',
    'browser:extract',
    'browser:capture_screenshot',
    'browser:get_page_state',
    'browser:wait_for_pending_event',
  ],
  /** 站点工作区与页面（tab）的进出、显示与切换。 */
  'browser-session': [
    'browser:leave_site',
    'browser:show_page',
    'browser:switch_page_target',
    'browser:list_page_targets',
  ],
  /** 页面结构、元素与本地状态的细粒度观察。 */
  'browser-observe': [
    'browser:query_elements',
    'browser:observe_actions',
    'browser:get_page_diagnostics',
    'browser:read_page_data',
    'browser:read_page_storage',
  ],
  /** 网络与性能信号——排障时才需要。 */
  'browser-network': [
    'browser:get_network_request',
    'browser:get_network_response_body',
    'browser:performance',
  ],
  /** 弹窗、下载、权限等待用户裁决的页面事件。 */
  'browser-events': [
    'browser:handle_dialog',
    'browser:handle_download',
    'browser:handle_permission',
    'browser:list_pending_events',
  ],
  /** 文件进出：站点产物、导出、上传与资源抓取。 */
  'browser-files': [
    'browser:files',
    'browser:upload_file',
    'browser:fetch_resource',
    'browser:list_page_resources',
    'browser:list_media_sources',
  ],
  /** 任意脚本、配方与录屏等特化能力。 */
  'browser-advanced': [
    'browser:evaluate_script',
    'browser:user_scripts',
    'browser:recipe',
    'browser:screencast',
  ],
} as const satisfies Record<string, readonly string[]>

type BrowserToolCategoryId = keyof typeof BrowserToolNamesByCategory

const BrowserToolCategoryDefinitions = Object.freeze<
  Record<BrowserToolCategoryId, ToolCategoryDefinition>
>({
  'browser-core': {
    id: 'browser-core',
    label: 'Browser core',
    description: '浏览器主回路：读页面、执行动作、取内容、等事件。',
    toolOs: { domain: 'browser', defaultState: 'resident' },
  },
  'browser-session': {
    id: 'browser-session',
    label: 'Browser session',
    description: '站点工作区与页面标签的进出、显隐和切换。',
    toolOs: { domain: 'browser', defaultState: 'loadable' },
  },
  'browser-observe': {
    id: 'browser-observe',
    label: 'Browser inspection',
    description: '元素查询、坐标、动作回放与页面本地状态读取。',
    toolOs: { domain: 'browser', defaultState: 'loadable' },
  },
  'browser-network': {
    id: 'browser-network',
    label: 'Browser network',
    description: '网络请求、控制台、页面错误与性能采集。',
    toolOs: { domain: 'browser', defaultState: 'loadable' },
  },
  'browser-events': {
    id: 'browser-events',
    label: 'Browser events',
    description: '弹窗、下载与权限等待处理的页面事件。',
    toolOs: { domain: 'browser', defaultState: 'loadable' },
  },
  'browser-files': {
    id: 'browser-files',
    label: 'Browser files',
    description: '站点产物、页面导出、文件上传与资源抓取。',
    toolOs: { domain: 'browser', defaultState: 'loadable' },
  },
  'browser-advanced': {
    id: 'browser-advanced',
    label: 'Browser advanced',
    description: '任意脚本执行、用户脚本、配方、录屏与区域截图。',
    toolOs: { domain: 'browser', defaultState: 'loadable' },
  },
})

const BrowserToolCategoryIds = Object.keys(
  BrowserToolCategoryDefinitions
) as BrowserToolCategoryId[]

/**
 * 工具名 → 分类的反向索引。
 *
 * 建表时对着 `browserTools` 全集校验：漏登记一个工具就当场抛错，而不是让它静默落进
 * 一个没人认识的分类、于是所有按类别把门的判定对它失灵。
 */
const BrowserToolCategoryByName = new Map<string, BrowserToolCategoryId>()
for (const categoryId of BrowserToolCategoryIds) {
  for (const toolName of BrowserToolNamesByCategory[categoryId]) {
    BrowserToolCategoryByName.set(toolName, categoryId)
  }
}

const BrowserAgentModManifest = Object.freeze({
  id: BrowserModId,
  version: '0.2.6',
  publisher: 'VelarOS',
  displayName: 'VelarOS Browser',
  description: '浏览器空间与浏览器职责工具。',
  manifestSchemaVersion: 1,
  engines: { velaros: '*', agent: '*' },
  trust: 'bundled-official',
  requiredAxes: ['tools', 'toolCategories', 'spaces'],
  contributes: {
    toolCategories: BrowserToolCategoryIds.map((categoryId, index) => ({
      id: categoryId,
      label: BrowserToolCategoryDefinitions[categoryId].label,
      description: BrowserToolCategoryDefinitions[categoryId].description,
      order: 20 + index,
    })),
    tools: Object.keys(browserTools).map((name) => ({
      name,
      categoryId: requireBrowserToolCategoryId(BrowserToolCategoryByName, name),
      availableInSpaces: [BrowserSpaceId, ...BrowserGuestSpaceIds],
      residentInSpaces: optionalWhen(BrowserResidentToolNames.has(name), [BrowserSpaceId]),
    })),
    /*
     * 只声明**真被消费**的那几格：身份策略、绑定能力、职责类别。
     *
     * 空间的标题 / 提示 / 图标 / 顺序不在这里——权威是产品壳的枚举表（Desktop 的
     * `DesktopCapabilityScopeDescriptors`，文案还要走 i18n 键）。此处曾另有一份
     * `descriptor` + `iconId`，与壳里那份逐字不同（'Browser' vs「浏览器站点」）且零消费者：
     * 改 manifest 无效、改壳才生效——「空间叫什么」于是被两处各推一遍。删掉是承认现状。
     */
    spaces: [{
      id: BrowserSpaceId,
      identityStrategy: 'origin',
      boundCapabilityIds: [BrowserModId],
      toolCategoryIds: BrowserToolCategoryIds,
    }],
  },
})

interface BrowserBundledModDefinition {
  readonly id: typeof BrowserModId
  readonly specifier: string
  readonly defaultEnabled: true
  readonly manifest: typeof BrowserAgentModManifest
  readonly bindings: {
    readonly tools: typeof browserTools
    readonly toolCategories: Readonly<Record<BrowserToolCategoryId, ToolCategoryDefinition>>
  }
}

function createBrowserBundledModDefinition(): BrowserBundledModDefinition {
  return Object.freeze({
    id: BrowserModId,
    specifier: `bundled:${BrowserModId}`,
    defaultEnabled: true,
    manifest: BrowserAgentModManifest,
    bindings: Object.freeze({
      tools: browserTools,
      toolCategories: BrowserToolCategoryDefinitions,
    }),
  })
}

export {
  BrowserResidentToolNames,
  BrowserToolCategoryDefinitions,
  BrowserToolCategoryIds,
  BrowserToolNamesByCategory,
  browserTools,
  createBrowserBundledModDefinition,
}
export type { BrowserBundledModDefinition, BrowserToolCategoryId }
