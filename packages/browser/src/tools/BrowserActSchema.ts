import { z } from 'zod'

import { isNumber, isPresent, isString } from '@velaros-ai/core'
import { renderParameterDescription as parameterDescription } from '@velaros-ai/core/utils/ToolDescription'

import type { BrowserEmulationOptions, BrowserNetworkControlOptions, BrowserPageNavigationOptions, BrowserPageScrollOptions, BrowserPageWaitOptions, BrowserPageZoomOptions, BrowserPressKeyOptions, BrowserTargetActionKind, BrowserTargetActionValue } from '../core'

import {
  type BrowserTargetHintInput,
  browserTargetHintSchema,
} from './Target'

const browserActActionSchema = z.enum([
  'target',
  'navigate',
  'scroll',
  'type',
  'press_key',
  'move_mouse',
  'click_coordinates',
  'drag',
  'wait_for_selector',
  'wait_for_url',
  'wait_for_function',
  'wait_for_text',
  'wait',
  'set_viewport',
  'set_page_zoom',
  'configure_network',
  'configure_emulation',
])

const browserActTargetSchema = z
  .object({
    action: z.literal('target'),
    targetAction: z.enum(['click', 'fill', 'select', 'clear', 'select_all', 'scroll_into_view', 'focus', 'hover', 'check', 'uncheck']).describe(
      parameterDescription({
        description: '要执行的元素动作。',
        values: [
          'click：点击目标元素。',
          'fill：向目标输入控件写入 value。',
          'select：选择原生 select 的一个或多个选项。',
          'clear：清空输入控件或可编辑内容。',
          'select_all：选中输入控件或可编辑区域内的文本。',
          'scroll_into_view：把目标滚动到视口中心。',
          'focus：聚焦目标元素。',
          'hover：把鼠标移动到目标元素中心。',
          'check：勾选复选框或单选项。',
          'uncheck：取消勾选复选框。',
        ],
        usage: ['targetAction=fill 或 targetAction=select 时必须传 value；select 可传字符串数组。'],
      })
    ),
    target: browserTargetHintSchema.describe(
      parameterDescription({
        description: '要操作的元素定位线索。',
        usage: ['优先使用 inspect/query 返回的 target。'],
      })
    ),
    value: z.union([z.string(), z.array(z.string().max(1000)).min(1).max(50)]).optional().describe(
      parameterDescription({
        description: '填充动作的输入文本，或 select 动作要选择的选项值/文本。',
        usage: ['targetAction=fill 使用字符串；targetAction=select 可使用字符串或字符串数组。'],
      })
    ),
    waitForNavigation: z.boolean().optional().describe(
      parameterDescription({
        description: '动作后是否等待可能的页面导航完成。',
        notes: ['默认对 click 短暂等待；显式 true 时按完整导航稳定窗口等待。'],
      })
    ),
  })
  .superRefine((input, ctx) => {
    if (input.targetAction === 'fill' && !isString(input.value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: 'fill 动作必须提供字符串 value。',
      })
    }
    if (input.targetAction === 'select' && !isPresent(input.value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: 'select 动作必须提供 value。',
      })
    }
  })

const browserActNavigateSchema = z
  .object({
    action: z.literal('navigate'),
    navigationAction: z.enum(['back', 'forward', 'reload', 'goto']).optional().describe(
      parameterDescription({
        description: '导航动作。',
        values: [
          'back：后退。',
          'forward：前进。',
          'reload：刷新。',
          'goto：跳转到 url。',
        ],
        notes: ['提供 url 且省略 navigationAction 时默认 goto。'],
      })
    ),
    url: z.string().min(1).max(2048).optional().describe(
      parameterDescription({
        description: '跳转目标 URL。',
        usage: ['navigationAction=goto 时必须传 url。'],
      })
    ),
  })
  .superRefine((input, ctx) => {
    if (!input.navigationAction && !input.url?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['navigationAction'],
        message: '必须提供 navigationAction，或提供 url 进行 goto。',
      })
    }
    if (input.navigationAction === 'goto' && !input.url?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: 'goto 导航必须提供 url。',
      })
    }
  })

const browserActScrollSchema = z
  .object({
    action: z.literal('scroll'),
    direction: z.enum(['up', 'down', 'left', 'right', 'top', 'bottom']).optional().describe(
      parameterDescription({
        description: '滚动方向。',
        values: [
          'up：向上滚动。',
          'down：向下滚动。',
          'left：向左滚动。',
          'right：向右滚动。',
          'top：滚到顶部。',
          'bottom：滚到底部。',
        ],
        notes: ['未提供 x/y 时默认 down。'],
      })
    ),
    amount: z.number().int().positive().max(5000).optional().describe(
      parameterDescription({
        description: '按方向滚动的像素数。',
      })
    ),
    x: z.number().int().min(-10000).max(10000).optional().describe(
      parameterDescription({
        description: '水平滚动偏移像素。',
      })
    ),
    y: z.number().int().min(-10000).max(10000).optional().describe(
      parameterDescription({
        description: '垂直滚动偏移像素。',
      })
    ),
  })

const browserActTypeSchema = z
  .object({
    action: z.literal('type'),
    text: z.string().min(1).max(20000).describe(
      parameterDescription({
        description: '要输入到当前焦点元素的文本。',
      })
    ),
  })

const browserActPressKeySchema = z
  .object({
    action: z.literal('press_key'),
    key: z.string().min(1).max(80).describe(
      parameterDescription({
        description: '要按下的按键。',
        notes: ['例如 Enter、Tab、Escape、ArrowDown、a；也可传 Ctrl+a、Command+Shift+p 这类组合键。'],
      })
    ),
    modifiers: z
      .array(z.enum(['shift', 'control', 'alt', 'meta']))
      .max(4)
      .optional()
      .describe(
        parameterDescription({
          description: '可选修饰键。',
          values: [
            'shift：Shift 键。',
            'control：Control 键。',
            'alt：Alt/Option 键。',
            'meta：Command/Windows 键。',
          ],
        })
      ),
    repeat: z.number().int().positive().max(50).optional().describe(
      parameterDescription({
        description: '重复按键次数。',
        notes: ['默认 1。'],
      })
    ),
    waitForNavigation: z.boolean().optional().describe(
      parameterDescription({
        description: '按键后是否等待可能的页面导航完成。',
        notes: ['默认 false。'],
      })
    ),
  })

const browserActMoveMouseSchema = z
  .object({
    action: z.literal('move_mouse'),
    x: z.number().int().min(0).max(10000).describe(
      parameterDescription({
        description: '视口内横向坐标。',
      })
    ),
    y: z.number().int().min(0).max(10000).describe(
      parameterDescription({
        description: '视口内纵向坐标。',
      })
    ),
  })

const browserActClickCoordinatesSchema = z
  .object({
    action: z.literal('click_coordinates'),
    x: z.number().int().min(0).max(10000).describe(
      parameterDescription({
        description: '视口内横向坐标。',
      })
    ),
    y: z.number().int().min(0).max(10000).describe(
      parameterDescription({
        description: '视口内纵向坐标。',
      })
    ),
    button: z.enum(['left', 'middle', 'right']).optional().describe(
      parameterDescription({
        description: '鼠标按钮。',
        values: ['left：左键。', 'middle：中键。', 'right：右键。'],
        notes: ['默认 left。'],
      })
    ),
    clickCount: z.number().int().positive().max(5).optional().describe(
      parameterDescription({
        description: '点击次数。',
        notes: ['默认 1。'],
      })
    ),
    waitForNavigation: z.boolean().optional().describe(
      parameterDescription({
        description: '点击后是否等待可能的页面导航完成。',
        notes: ['默认 true。'],
      })
    ),
  })

const browserActDragSchema = z
  .object({
    action: z.literal('drag'),
    source: browserTargetHintSchema.describe(
      parameterDescription({
        description: '拖拽起点元素定位线索。',
        usage: ['优先使用 inspect/query 返回的 target。'],
      })
    ),
    target: browserTargetHintSchema.describe(
      parameterDescription({
        description: '拖拽终点元素定位线索。',
        usage: ['优先使用 inspect/query 返回的 target。'],
      })
    ),
    steps: z.number().int().positive().max(60).optional().describe(
      parameterDescription({
        description: '拖拽过程中的鼠标移动步数。',
        notes: ['默认 10。'],
      })
    ),
    waitForNavigation: z.boolean().optional().describe(
      parameterDescription({
        description: '拖拽后是否等待可能的页面导航完成。',
        notes: ['默认 false。'],
      })
    ),
  })

const browserActWaitForSelectorSchema = z
  .object({
    action: z.literal('wait_for_selector'),
    selector: z.string().min(1).max(1000).describe(
      parameterDescription({
        description: '要等待的 CSS selector；同源 iframe 内元素可用 iframe selector >> inner selector。',
      })
    ),
    state: z.enum(['attached', 'visible', 'hidden', 'detached']).optional().describe(
      parameterDescription({
        description: '等待 selector 达到的状态。',
        values: [
          'attached：元素出现在 DOM 中。',
          'visible：元素存在且可见。',
          'hidden：元素不存在或不可见。',
          'detached：元素不在 DOM 中。',
        ],
        notes: ['省略时保持旧行为，等待 attached；visible=true 时等价于 state=visible。'],
      })
    ),
    visible: z.boolean().optional().describe(
      parameterDescription({
        description: '是否要求匹配元素可见。',
        notes: ['兼容旧字段；新调用优先使用 state=visible。'],
      })
    ),
    timeoutMs: z.number().int().positive().max(60000).optional().describe(
      parameterDescription({
        description: '最长等待毫秒数。',
        notes: ['默认 5000。'],
      })
    ),
  })

const browserActWaitForUrlSchema = z
  .object({
    action: z.literal('wait_for_url'),
    urlPattern: z.string().min(1).max(2048).describe(
      parameterDescription({
        description: '要等待出现在当前页面 URL 中的字符串，支持 * 通配。',
        usage: ['例如 urlPattern="/settings" 或 urlPattern="*/settings*"。'],
      })
    ),
    timeoutMs: z.number().int().positive().max(60000).optional().describe(
      parameterDescription({
        description: '最长等待毫秒数。',
        notes: ['默认 5000。'],
      })
    ),
  })

const browserActWaitForFunctionSchema = z
  .object({
    action: z.literal('wait_for_function'),
    expression: z.string().min(1).max(5000).describe(
      parameterDescription({
        description: '要重复执行直到返回 truthy 的页面 JavaScript 表达式。',
        usage: ['例如 expression=document.readyState === "complete"。'],
        notes: ['表达式在页面上下文执行；需要任意脚本取值时用 browser_evaluate_script。'],
      })
    ),
    timeoutMs: z.number().int().positive().max(60000).optional().describe(
      parameterDescription({
        description: '最长等待毫秒数。',
        notes: ['默认 5000。'],
      })
    ),
  })

const browserActWaitForTextSchema = z
  .object({
    action: z.literal('wait_for_text'),
    text: z.string().min(1).max(5000).describe(
      parameterDescription({
        description: '要等待出现在页面正文中的文本。',
        usage: ['用于等待 toast、结果标题、加载后的可见文案等。'],
      })
    ),
    timeoutMs: z.number().int().positive().max(60000).optional().describe(
      parameterDescription({
        description: '最长等待毫秒数。',
        notes: ['默认 5000。'],
      })
    ),
  })

const browserActWaitSchema = z
  .object({
    action: z.literal('wait'),
    durationMs: z.number().int().positive().max(60000).optional().describe(
      parameterDescription({
        description: '额外等待的毫秒数。',
        notes: ['适合等待动画、轻量 SPA 更新或懒加载。'],
      })
    ),
    loadState: z.enum(['domcontentloaded', 'load', 'networkidle']).optional().describe(
      parameterDescription({
        description: '要等待的页面加载状态。',
        values: [
          'domcontentloaded：等待 document.readyState 不再是 loading。',
          'load：等待 document.readyState 为 complete。',
          'networkidle：等待近期网络请求结束并保持短暂空闲。',
        ],
      })
    ),
    timeoutMs: z.number().int().positive().max(60000).optional().describe(
      parameterDescription({
        description: '等待 loadState 的最长毫秒数。',
        notes: ['默认 5000。'],
      })
    ),
  })
  .superRefine((input, ctx) => {
    if (!isNumber(input.durationMs) && !isPresent(input.loadState)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['durationMs'],
        message: 'wait 动作必须提供 durationMs 或 loadState。',
      })
    }
  })

const browserActSetViewportSchema = z
  .object({
    action: z.literal('set_viewport'),
    width: z.number().int().min(320).max(3840).describe(
      parameterDescription({
        description: '视口宽度。',
      })
    ),
    height: z.number().int().min(240).max(2160).describe(
      parameterDescription({
        description: '视口高度。',
      })
    ),
  })

const browserActSetPageZoomSchema = z
  .object({
    action: z.literal('set_page_zoom'),
    zoomAction: z.enum(['in', 'out', 'reset', 'set']).describe(
      parameterDescription({
        description: '缩放动作。',
        values: [
          'in：放大。',
          'out：缩小。',
          'reset：回到 100%。',
          'set：设置指定比例。',
        ],
        usage: ['zoomAction=set 时必须传 zoomFactor。'],
      })
    ),
    zoomFactor: z.number().min(0.25).max(3).optional().describe(
      parameterDescription({
        description: '要设置的缩放比例。',
        usage: ['仅 zoomAction=set 时使用。'],
        notes: ['1 表示 100%，1.25 表示 125%。'],
      })
    ),
    step: z.number().min(0.05).max(0.5).optional().describe(
      parameterDescription({
        description: '放大或缩小时的步进。',
        notes: ['默认 0.1。'],
      })
    ),
  })
  .superRefine((input, ctx) => {
    if (input.zoomAction === 'set' && !isNumber(input.zoomFactor)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['zoomFactor'],
        message: 'zoomAction=set 时必须提供 zoomFactor。',
      })
    }
  })

const browserNetworkMockResponseSchema = z
  .object({
    urlPattern: z.string().min(1).max(2048).describe(
      parameterDescription({
        description: '要 mock 的 URL pattern。',
        notes: ['使用 CDP urlPattern 语法。'],
      })
    ),
    status: z.number().int().min(100).max(599).optional().describe(
      parameterDescription({
        description: 'mock 响应的 HTTP status code。',
      })
    ),
    contentType: z.string().min(1).max(200).optional().describe(
      parameterDescription({
        description: 'mock 响应的 Content-Type。',
      })
    ),
    body: z.string().max(1_000_000).optional().describe(
      parameterDescription({
        description: 'mock 响应 body，按 UTF-8 文本返回。',
      })
    ),
    headers: z.record(z.string().min(1).max(120), z.string().max(4000)).optional().describe(
      parameterDescription({
        description: 'mock 响应额外 headers；content-type 由 contentType 字段控制。',
      })
    ),
  })

const browserActConfigureNetworkSchema = z
  .object({
    action: z.literal('configure_network'),
    offline: z.boolean().optional().describe(
      parameterDescription({
        description: '是否把外部 CDP 浏览器切到离线网络状态。',
        notes: ['仅外部 CDP 浏览器支持；false 会恢复在线。'],
      })
    ),
    extraHTTPHeaders: z.record(z.string().min(1).max(120), z.string().max(4000)).optional().describe(
      parameterDescription({
        description: '要注入到后续请求里的额外 HTTP headers。',
        notes: ['传空对象会清空已设置的额外 headers。'],
      })
    ),
    blockedURLPatterns: z.array(z.string().min(1).max(2048)).max(100).optional().describe(
      parameterDescription({
        description: '要阻断的 URL pattern 列表。',
        notes: ['使用 CDP urlPattern 语法；传空数组会清空阻断规则。'],
      })
    ),
    blockedResourceTypes: z.array(z.string().min(1).max(80)).max(32).optional().describe(
      parameterDescription({
        description: '把阻断规则限定到指定资源类型。',
        notes: ['大小写不敏感，例如 script、xhr、fetch、image；传空数组会清空资源类型限定。'],
      })
    ),
    mockResponses: z.array(browserNetworkMockResponseSchema).max(50).optional().describe(
      parameterDescription({
        description: '要直接返回静态响应的 URL pattern 列表。',
        notes: ['传空数组会清空已有 mock 响应规则。'],
      })
    ),
  })
  .superRefine((input, ctx) => {
    if (
      !isPresent(input.offline)
      && !isPresent(input.extraHTTPHeaders)
      && !isPresent(input.blockedURLPatterns)
      && !isPresent(input.blockedResourceTypes)
      && !isPresent(input.mockResponses)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['offline'],
        message: 'configure_network 动作必须提供 offline、extraHTTPHeaders、blockedURLPatterns、blockedResourceTypes 或 mockResponses。',
      })
    }
  })

const browserGeolocationSchema = z
  .object({
    latitude: z.number().min(-90).max(90).describe(
      parameterDescription({
        description: '地理位置纬度。',
      })
    ),
    longitude: z.number().min(-180).max(180).describe(
      parameterDescription({
        description: '地理位置经度。',
      })
    ),
    accuracy: z.number().min(0).max(100000).optional().describe(
      parameterDescription({
        description: '地理位置精度，单位米。',
        notes: ['默认 1。'],
      })
    ),
  })

const browserActConfigureEmulationSchema = z
  .object({
    action: z.literal('configure_emulation'),
    colorScheme: z.enum(['light', 'dark', 'no-preference']).optional().describe(
      parameterDescription({
        description: '模拟 CSS prefers-color-scheme。',
        values: ['light：浅色模式。', 'dark：深色模式。', 'no-preference：取消偏好。'],
      })
    ),
    reducedMotion: z.enum(['reduce', 'no-preference']).optional().describe(
      parameterDescription({
        description: '模拟 CSS prefers-reduced-motion。',
        values: ['reduce：减少动效。', 'no-preference：取消减少动效偏好。'],
      })
    ),
    timezoneId: z.string().max(120).optional().describe(
      parameterDescription({
        description: '模拟浏览器时区。',
        notes: ['例如 Asia/Shanghai；传空字符串会清除时区 override。'],
      })
    ),
    locale: z.string().max(80).optional().describe(
      parameterDescription({
        description: '模拟浏览器 locale。',
        notes: ['例如 zh-CN、en-US；传空字符串会清除 locale override。'],
      })
    ),
    geolocation: browserGeolocationSchema.optional().describe(
      parameterDescription({
        description: '模拟浏览器地理位置。',
        notes: ['页面仍可能需要先授权 geolocation 权限。'],
      })
    ),
    cpuThrottlingRate: z.number().min(1).max(20).optional().describe(
      parameterDescription({
        description: '模拟 CPU 减速倍率。',
        notes: ['1 = 不减速；4 ≈ 中端手机；20 为上限。用于性能压测与复现低端设备表现。'],
      })
    ),
    networkThrottling: z.enum(['none', 'slow-3g', 'fast-3g', 'slow-4g', 'fast-4g']).optional().describe(
      parameterDescription({
        description: '模拟网络节流预设。',
        values: [
          'none：恢复原速。',
          'slow-3g：约 500kbps / 2s 延迟。',
          'fast-3g / slow-4g：约 1.6Mbps / 562ms 延迟（同档）。',
          'fast-4g：约 9Mbps / 165ms 延迟。',
        ],
        notes: ['与 configure_network 的 offline 独立叠加。'],
      })
    ),
  })
  .superRefine((input, ctx) => {
    if (
      !isPresent(input.colorScheme)
      && !isPresent(input.reducedMotion)
      && !isPresent(input.timezoneId)
      && !isPresent(input.locale)
      && !isPresent(input.geolocation)
      && !isPresent(input.cpuThrottlingRate)
      && !isPresent(input.networkThrottling)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['colorScheme'],
        message:
          'configure_emulation 动作必须提供 colorScheme、reducedMotion、timezoneId、locale、geolocation、cpuThrottlingRate 或 networkThrottling。',
      })
    }
  })

const browserActExactSchema = z.discriminatedUnion('action', [
  browserActTargetSchema,
  browserActNavigateSchema,
  browserActScrollSchema,
  browserActTypeSchema,
  browserActPressKeySchema,
  browserActMoveMouseSchema,
  browserActClickCoordinatesSchema,
  browserActDragSchema,
  browserActWaitForSelectorSchema,
  browserActWaitForUrlSchema,
  browserActWaitForFunctionSchema,
  browserActWaitForTextSchema,
  browserActWaitSchema,
  browserActSetViewportSchema,
  browserActSetPageZoomSchema,
  browserActConfigureNetworkSchema,
  browserActConfigureEmulationSchema,
])

const browserActSchema = z
  .object({
    action: browserActActionSchema.describe(
      parameterDescription({
        description: '要执行的浏览器页面动作。',
        values: [
          'target：点击、填写、选择、清空、选中文本、滚动到视口、聚焦或悬停定位到的元素。',
          'navigate：后退、前进、刷新或跳转 URL。',
          'scroll：滚动当前页面。',
          'type：向当前焦点输入文本。',
          'press_key：发送键盘按键。',
          'move_mouse：移动虚拟鼠标。',
          'click_coordinates：按视口坐标点击。',
          'drag：把一个目标元素拖拽到另一个目标元素。',
          'wait_for_selector：等待 CSS selector。',
          'wait_for_url：等待当前页面 URL 命中 urlPattern。',
          'wait_for_function：等待页面表达式返回 truthy。',
          'wait_for_text：等待页面正文出现指定文本。',
          'wait：等待页面加载状态或短暂停顿。',
          'set_viewport：设置页面 CSS viewport 分辨率，用于响应式设计检查；工作区外框不变。',
          'set_page_zoom：调整页面缩放。',
          'configure_network：配置外部 CDP 浏览器网络状态。',
          'configure_emulation：配置外部 CDP 浏览器环境模拟。',
        ],
      })
    ),
    targetAction: z.enum(['click', 'fill', 'select', 'clear', 'select_all', 'scroll_into_view', 'focus', 'hover', 'check', 'uncheck']).optional().describe(
      parameterDescription({
        description: 'target 动作下的元素操作。',
      })
    ),
    target: browserTargetHintSchema.optional().describe(
      parameterDescription({
        description: 'target 动作要操作的元素定位线索，或 drag 动作的终点元素定位线索。',
      })
    ),
    source: browserTargetHintSchema.optional().describe(
      parameterDescription({
        description: 'drag 动作的起点元素定位线索。',
      })
    ),
    value: z.union([z.string(), z.array(z.string().max(1000)).min(1).max(50)]).optional().describe(
      parameterDescription({
        description: 'targetAction=fill 时的输入文本，或 targetAction=select 时的选项值/文本。',
      })
    ),
    navigationAction: z.enum(['back', 'forward', 'reload', 'goto']).optional().describe(
      parameterDescription({
        description: 'navigate 动作下的导航类型。',
      })
    ),
    url: z.string().min(1).max(2048).optional().describe(
      parameterDescription({
        description: 'navigate/goto 的跳转目标 URL。',
      })
    ),
    direction: z.enum(['up', 'down', 'left', 'right', 'top', 'bottom']).optional().describe(
      parameterDescription({
        description: 'scroll 动作的方向。',
      })
    ),
    amount: z.number().int().positive().max(5000).optional().describe(
      parameterDescription({
        description: 'scroll 动作的方向滚动像素数。',
      })
    ),
    x: z.number().int().min(-10000).max(10000).optional().describe(
      parameterDescription({
        description: 'scroll/move/click 动作的横向坐标或偏移。',
      })
    ),
    y: z.number().int().min(-10000).max(10000).optional().describe(
      parameterDescription({
        description: 'scroll/move/click 动作的纵向坐标或偏移。',
      })
    ),
    text: z.string().min(1).max(20000).optional().describe(
      parameterDescription({
        description: 'type 动作要输入的文本，或 wait_for_text 动作要等待出现的页面正文文本。',
      })
    ),
    key: z.string().min(1).max(80).optional().describe(
      parameterDescription({
        description: 'press_key 动作要按下的按键。',
        notes: ['可传 Enter，也可传 Ctrl+a、Command+Shift+p 这类组合键。'],
      })
    ),
    modifiers: z.array(z.enum(['shift', 'control', 'alt', 'meta'])).max(4).optional().describe(
      parameterDescription({
        description: 'press_key 动作的可选修饰键。',
      })
    ),
    repeat: z.number().int().positive().max(50).optional().describe(
      parameterDescription({
        description: 'press_key 动作的重复次数。',
      })
    ),
    button: z.enum(['left', 'middle', 'right']).optional().describe(
      parameterDescription({
        description: 'click_coordinates 动作的鼠标按钮。',
      })
    ),
    clickCount: z.number().int().positive().max(5).optional().describe(
      parameterDescription({
        description: 'click_coordinates 动作的点击次数。',
      })
    ),
    steps: z.number().int().positive().max(60).optional().describe(
      parameterDescription({
        description: 'drag 动作的鼠标移动步数。',
      })
    ),
    waitForNavigation: z.boolean().optional().describe(
      parameterDescription({
        description: '按键或点击后是否等待可能的页面导航完成。',
      })
    ),
    selector: z.string().min(1).max(1000).optional().describe(
      parameterDescription({
        description: 'wait_for_selector 动作要等待的 CSS selector；同源 iframe 内元素可用 iframe selector >> inner selector。',
      })
    ),
    urlPattern: z.string().min(1).max(2048).optional().describe(
      parameterDescription({
        description: 'wait_for_url 动作要等待的 URL 字符串或 * 通配模式。',
      })
    ),
    expression: z.string().min(1).max(5000).optional().describe(
      parameterDescription({
        description: 'wait_for_function 动作要等待为 truthy 的页面 JavaScript 表达式。',
      })
    ),
    state: z.enum(['attached', 'visible', 'hidden', 'detached']).optional().describe(
      parameterDescription({
        description: 'wait_for_selector 要等待的状态。',
      })
    ),
    visible: z.boolean().optional().describe(
      parameterDescription({
        description: 'wait_for_selector 是否要求匹配元素可见。',
      })
    ),
    durationMs: z.number().transform((value) => Math.min(60000, Math.max(1, Math.round(value)))).optional().describe(
      parameterDescription({
        description: 'wait 动作额外等待的毫秒数。',
        notes: ['上限 60000,超出自动钳制。'],
      })
    ),
    loadState: z.enum(['domcontentloaded', 'load', 'networkidle']).optional().describe(
      parameterDescription({
        description: 'wait 动作要等待的页面加载状态。',
      })
    ),
    timeoutMs: z.number().transform((value) => Math.min(60000, Math.max(1, Math.round(value)))).optional().describe(
      parameterDescription({
        description: 'wait_for_selector、wait_for_url、wait_for_function、wait_for_text 或 wait 动作最长等待毫秒数。',
        notes: ['上限 60000,超出自动钳制。'],
      })
    ),
    width: z.number().int().min(320).max(3840).optional().describe(
      parameterDescription({
        description: 'set_viewport 动作的视口宽度。',
      })
    ),
    height: z.number().int().min(240).max(2160).optional().describe(
      parameterDescription({
        description: 'set_viewport 动作的视口高度。',
      })
    ),
    zoomAction: z.enum(['in', 'out', 'reset', 'set']).optional().describe(
      parameterDescription({
        description: 'set_page_zoom 动作的缩放类型。',
      })
    ),
    zoomFactor: z.number().min(0.25).max(3).optional().describe(
      parameterDescription({
        description: 'set_page_zoom 动作设置的缩放比例。',
      })
    ),
    step: z.number().min(0.05).max(0.5).optional().describe(
      parameterDescription({
        description: 'set_page_zoom 放大或缩小时的步进。',
      })
    ),
    offline: z.boolean().optional().describe(
      parameterDescription({
        description: 'configure_network 动作是否切换离线状态。',
      })
    ),
    extraHTTPHeaders: z.record(z.string().min(1).max(120), z.string().max(4000)).optional().describe(
      parameterDescription({
        description: 'configure_network 动作设置的额外 HTTP headers。',
      })
    ),
    blockedURLPatterns: z.array(z.string().min(1).max(2048)).max(100).optional().describe(
      parameterDescription({
        description: 'configure_network 动作要阻断的 URL pattern 列表。',
      })
    ),
    blockedResourceTypes: z.array(z.string().min(1).max(80)).max(32).optional().describe(
      parameterDescription({
        description: 'configure_network 动作要限定阻断的资源类型。',
      })
    ),
    mockResponses: z.array(browserNetworkMockResponseSchema).max(50).optional().describe(
      parameterDescription({
        description: 'configure_network 动作要静态返回的 mock 响应规则。',
      })
    ),
    colorScheme: z.enum(['light', 'dark', 'no-preference']).optional().describe(
      parameterDescription({
        description: 'configure_emulation 动作模拟的 prefers-color-scheme。',
      })
    ),
    reducedMotion: z.enum(['reduce', 'no-preference']).optional().describe(
      parameterDescription({
        description: 'configure_emulation 动作模拟的 prefers-reduced-motion。',
      })
    ),
    timezoneId: z.string().max(120).optional().describe(
      parameterDescription({
        description: 'configure_emulation 动作模拟的浏览器时区。',
      })
    ),
    locale: z.string().max(80).optional().describe(
      parameterDescription({
        description: 'configure_emulation 动作模拟的浏览器 locale。',
      })
    ),
    geolocation: browserGeolocationSchema.optional().describe(
      parameterDescription({
        description: 'configure_emulation 动作模拟的浏览器地理位置。',
      })
    ),
    cpuThrottlingRate: z.number().min(1).max(20).optional().describe(
      parameterDescription({
        description: 'configure_emulation 动作模拟的 CPU 减速倍率（1 = 不减速）。',
      })
    ),
    networkThrottling: z.enum(['none', 'slow-3g', 'fast-3g', 'slow-4g', 'fast-4g']).optional().describe(
      parameterDescription({
        description: 'configure_emulation 动作模拟的网络节流预设。',
      })
    ),
  })
  .superRefine((input, ctx) => {
    const exactParseResult = browserActExactSchema.safeParse(input)
    if (exactParseResult.success) return

    for (const issue of exactParseResult.error.issues) {
      ctx.addIssue({
        code: 'custom',
        message: issue.message,
        path: issue.path,
      })
    }
  })

type BrowserActExactInput = z.output<typeof browserActExactSchema>

type ParsedBrowserActInput =
  | {
      action: 'target'
      targetAction: BrowserTargetActionKind
      target: BrowserTargetHintInput
      value?: BrowserTargetActionValue
      waitForNavigation?: boolean
    }
  | {
      action: 'navigate'
      navigationAction: BrowserPageNavigationOptions['action']
      url?: string
    }
  | {
      action: 'scroll'
      direction?: BrowserPageScrollOptions['direction']
      amount?: number
      x?: number
      y?: number
    }
  | { action: 'type'; text: string }
  | {
      action: 'press_key'
      key: string
      modifiers?: BrowserPressKeyOptions['modifiers']
      repeat?: number
      waitForNavigation?: boolean
    }
  | { action: 'move_mouse'; x: number; y: number }
  | {
      action: 'click_coordinates'
      x: number
      y: number
      button?: 'left' | 'middle' | 'right'
      clickCount?: number
      waitForNavigation?: boolean
    }
  | {
      action: 'drag'
      source: BrowserTargetHintInput
      target: BrowserTargetHintInput
      steps?: number
      waitForNavigation?: boolean
    }
  | {
      action: 'wait_for_selector'
      selector: string
      state?: 'attached' | 'visible' | 'hidden' | 'detached'
      visible?: boolean
      timeoutMs?: number
    }
  | {
      action: 'wait_for_url'
      urlPattern: string
      timeoutMs?: number
    }
  | {
      action: 'wait_for_function'
      expression: string
      timeoutMs?: number
    }
  | {
      action: 'wait_for_text'
      text: string
      timeoutMs?: number
    }
  | {
      action: 'wait'
      durationMs?: number
      loadState?: BrowserPageWaitOptions['loadState']
      timeoutMs?: number
    }
  | { action: 'set_viewport'; width: number; height: number }
  | {
      action: 'set_page_zoom'
      zoomAction: BrowserPageZoomOptions['action']
      zoomFactor?: number
      step?: number
    }
  | {
      action: 'configure_network'
      offline?: BrowserNetworkControlOptions['offline']
      extraHTTPHeaders?: BrowserNetworkControlOptions['extraHTTPHeaders']
      blockedURLPatterns?: BrowserNetworkControlOptions['blockedURLPatterns']
      blockedResourceTypes?: BrowserNetworkControlOptions['blockedResourceTypes']
      mockResponses?: BrowserNetworkControlOptions['mockResponses']
    }
  | {
      action: 'configure_emulation'
      colorScheme?: BrowserEmulationOptions['colorScheme']
      reducedMotion?: BrowserEmulationOptions['reducedMotion']
      timezoneId?: BrowserEmulationOptions['timezoneId']
      locale?: BrowserEmulationOptions['locale']
      geolocation?: BrowserEmulationOptions['geolocation']
      cpuThrottlingRate?: BrowserEmulationOptions['cpuThrottlingRate']
      networkThrottling?: BrowserEmulationOptions['networkThrottling']
    }

function normalizeBrowserActInput(input: BrowserActExactInput): ParsedBrowserActInput {
  if (input.action === 'navigate') return {
      action: input.action,
      navigationAction: input.navigationAction ?? 'goto',
      url: input.url,
    }

  return input
}

function parseBrowserActInput(input: unknown): ParsedBrowserActInput {
  const parsed = browserActSchema.parse(input)
  const exactParseResult = browserActExactSchema.safeParse(parsed)
  if (!exactParseResult.success) throw exactParseResult.error

  return normalizeBrowserActInput(exactParseResult.data)
}

export {
  browserActSchema,
  parseBrowserActInput,
}
export type {
  ParsedBrowserActInput,
}
