import { z } from 'zod'

import { renderParameterDescription as parameterDescription } from '@velaros-ai/agent/tool-contract'
import { isNumber, isPresent, isString, numberOrNull, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { optionalWhenLazy } from '@velaros-ai/core/utils/optionalWhen'

import type { BrowserClickCoordinatesOptions, BrowserClickCoordinatesResult, BrowserMoveMouseResult, BrowserPageNavigationOptions, BrowserPageNavigationResult, BrowserPageScrollOptions, BrowserPageScrollResult, BrowserPageWaitOptions, BrowserPageWaitResult, BrowserPageZoomOptions, BrowserPageZoomResult, BrowserPressKeyOptions, BrowserPressKeyResult, BrowserTargetActionOptions, BrowserTypeTextResult, BrowserViewportResult, BrowserWaitForSelectorResult } from '../core'

import { browserActSchema, parseBrowserActInput } from './BrowserActSchema'
import { BrowserControlCapability, BrowserObserveCapability } from './Capabilities'
import { requireActiveBrowserSite } from './Context'
import { browserClickCoordinatesGuidedSchema, browserNavigatePageGuidedSchema, browserPerformTargetActionGuidedSchema, normalizeBrowserClickCoordinatesGuided, normalizeBrowserNavigatePageGuided, normalizeBrowserPerformTargetActionGuided } from './Interaction'
import {
  type BrowserTargetHintInput,
  browserTargetHintSchema,
  normalizeBrowserTargetHint,
} from './Target'
import { performTargetActionWithRecovery } from './TargetActionRecovery'
import { defineBrowserTool } from './Types'

/** 对 inspect/query 得到的 target 执行点击、填充、聚焦或悬停。 */
const browserPerformTargetAction = defineBrowserTool<{
  action: BrowserTargetActionOptions['action']
  target: BrowserTargetHintInput
  value?: BrowserTargetActionOptions['value']
  waitForNavigation?: boolean
}>({
  name: 'browser:perform_target_action',
  role: 'control',
  summary: '操作当前页面上的目标元素。',
  suitable: [
      '需要点击、填写、选择、清空、选中文本、聚焦或悬停已经定位到的页面元素。',
      'target 来自页面检查、元素查询或 recipe 草稿。',
    ],
  forbidden: [
      '不要用它执行任意脚本或跨站点操作。',
      '不要在 target 不稳定时强行操作；先重新查询元素。',
    ],
  usage: ['传 action 和 target；action=fill 或 action=select 时必须传 value。'],
  examples: [
    { action: 'click', target: { css: 'button[type=submit]' } },
    // fill 必须带字符串 value
    { action: 'fill', target: { css: 'input[name=email]' }, value: 'user@example.com' },
    // 清空输入
    { action: 'clear', target: { css: 'input[name=q]' } },
    // 原生 select 选一项
    { action: 'select', target: { css: 'select#country' }, value: 'US' },
    // 多选 select 传字符串数组
    { action: 'select', target: { css: 'select[multiple]' }, value: ['red', 'blue'] },
    // 勾选 / 取消勾选
    { action: 'check', target: { css: 'input[type=checkbox][name=agree]' } },
    { action: 'uncheck', target: { css: 'input[type=checkbox][name=news]' } },
    // 悬停 / 聚焦 / 滚动进视口
    { action: 'hover', target: { css: 'nav .dropdown' } },
    { action: 'focus', target: { css: 'input[name=search]' } },
    { action: 'scroll_into_view', target: { css: 'footer .contact' } },
  ],
  notes: ['只作用于当前受控页面。'],
  schema: z
    .object({
      action: z.enum(['click', 'fill', 'select', 'clear', 'select_all', 'scroll_into_view', 'focus', 'hover', 'check', 'uncheck']).describe(
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
          usage: ['action=fill 或 action=select 时必须传 value；select 可传字符串数组。'],
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
          usage: ['action=fill 使用字符串；action=select 可使用字符串或字符串数组。'],
        })
      ),
    })
    .superRefine((input, issueCtx) => {
      // fill 必须有 value，否则页面操作没有明确输入内容。
      if (input.action === 'fill' && !isString(input.value)) {
        issueCtx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['value'],
          message: 'fill 动作必须提供字符串 value。',
        })
      }
      if (input.action === 'select' && !isPresent(input.value)) {
        issueCtx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['value'],
          message: 'select 动作必须提供 value。',
        })
      }
    }),
  permissions: ['network'],
  capabilities: BrowserControlCapability,
  surfaces: {
    guided: {
      role: 'control',
      summary: '用扁平参数操作页面元素。',
      suitable: ['需要用 css、文本、名称或属性直接定位元素。'],
      forbidden: ['不要在缺少定位线索时调用。'],
      usage: ['传 action 和至少一种定位字段；fill 还要传 value。'],
      examples: [{ action: "fill", css: "input[name=q]", value: "VelarOS" }],
      notes: ['normalize 会把扁平字段转换为 target。'],
      schema: browserPerformTargetActionGuidedSchema,
      normalize: normalizeBrowserPerformTargetActionGuided,
    },
    preset: {
      role: 'control',
      summary: '按 CSS selector 点击页面元素。',
      suitable: ['只需要点击一个 CSS selector 明确的元素。'],
      forbidden: ['不要用于填写输入框或多线索定位。'],
      usage: ['传 css。'],
      examples: [{ css: "button[type=submit]" }],
      notes: ['需要 fill 时使用 guided 或 direct。'],
      schema: z.object({
        css: z.string().min(1).max(1000).describe(
          parameterDescription({
            description: '要点击的元素 CSS selector。',
          })
        ),
      }),
      normalize: (input) => ({
        action: 'click',
        target: {
          css: isString(input.css) ? input.css : '',
        },
      }),
    },
  },
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  execute: async ({ action, target, value, waitForNavigation }, ctx) => {
    ctx.abortSignal.throwIfAborted()
    requireActiveBrowserSite(ctx)

    return performTargetActionWithRecovery(
      {
        action,
        target: normalizeBrowserTargetHint(target),
        value,
        waitForNavigation,
      },
      ctx
    )
  },
})

/** 控制当前页面导航：后退、前进、刷新或 goto。 */
const browserNavigatePage = defineBrowserTool<{
  action: BrowserPageNavigationOptions['action']
  url?: string
}>({
  name: 'browser:navigate_page',
  role: 'control',
  summary: '控制当前页面导航。',
  suitable: ['需要后退、前进、刷新或跳转 URL。'],
  forbidden: ['不要用它进入新站点工作区；新站点用 browser:enter_site。'],
  usage: ['传 action；action=goto 时传 url。'],
  examples: [{ action: "goto", url: "https://example.com" }],
  notes: ['导航后会同步当前 browser context。'],
  schema: z
    .object({
      action: z.enum(['back', 'forward', 'reload', 'goto']).describe(
        parameterDescription({
          description: '导航动作。',
          values: [
            'back：后退。',
            'forward：前进。',
            'reload：刷新。',
            'goto：跳转到 url。',
          ],
          usage: ['action=goto 时必须传 url。'],
        })
      ),
      url: z.string().min(1).max(2048).optional().describe(
        parameterDescription({
          description: '跳转目标 URL。',
          usage: ['仅 action=goto 时使用。'],
        })
      ),
    })
    .superRefine((input, issueCtx) => {
      // goto 没有 URL 时无法执行，提前用 zod 返回结构化错误。
      // (注:action 必填,「两参皆空」在基础 parse 就挡住,无需 ① 判别路径的那道空校验。)
      if (input.action === 'goto' && !input.url?.trim()) {
        issueCtx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['url'],
          message: 'goto 导航必须提供 url。',
        })
      }
    }),
  permissions: ['network'],
  capabilities: BrowserControlCapability,
  surfaces: {
    preset: {
      role: 'control',
      summary: '跳转到指定 URL。',
      suitable: ['需要直接打开当前站点内的某个 URL。'],
      forbidden: ['不要用于后退、前进或刷新。'],
      usage: ['传 url。'],
      examples: [{ url: "https://example.com/search" }],
      notes: ['跨主站点切换优先使用 browser:enter_site。'],
      schema: z.object({
        url: z.string().min(1).max(2048).describe(
          parameterDescription({
            description: '要跳转到的 URL。',
          })
        ),
      }),
      normalize: (input) => {
        const url = input.url
        return {
          action: 'goto',
          url: optionalWhenLazy(isString(url), () => String(url)),
        }
      },
    },
    guided: {
      role: 'control',
      summary: '用紧凑参数控制页面导航。',
      suitable: ['需要 url 默认 goto，或显式 back、forward、reload。'],
      forbidden: ['不要同时表达互相冲突的导航意图。'],
      usage: ['传 url 可省略 action；否则传 action。'],
      examples: [{ url: "https://example.com" }],
      notes: ['normalize 会把仅 url 的输入转换为 goto。'],
      schema: browserNavigatePageGuidedSchema,
      normalize: normalizeBrowserNavigatePageGuided,
    },
  },
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  execute: async ({ action, url }, ctx): Promise<BrowserPageNavigationResult> => {
    ctx.abortSignal.throwIfAborted()
    requireActiveBrowserSite(ctx)

    // navigatePage 会在 runtime 内等待导航并同步页面状态。
    return ctx.browser.navigatePage({
      action,
      url,
    })
  },
})

/** 滚动当前页面。 */
const browserScrollPage = defineBrowserTool<{
  direction?: BrowserPageScrollOptions['direction']
  amount?: number
  x?: number
  y?: number
}>({
  name: 'browser:scroll_page',
  role: 'control',
  summary: '滚动当前页面。',
  suitable: ['需要查看页面其他区域或触发懒加载内容。'],
  forbidden: ['不要用滚动替代导航或元素定位。'],
  usage: ['传 direction/amount，或传 x/y 像素偏移。'],
  examples: [{ direction: "down", amount: 800 }],
  notes: ['返回滚动后的位置和页面可滚动范围。'],
  schema: z.object({
    direction: z
      .enum(['up', 'down', 'left', 'right', 'top', 'bottom'])
      .optional()
      .describe(
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
  }),
  permissions: ['network'],
  capabilities: BrowserControlCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  execute: async ({ direction, amount, x, y }, ctx): Promise<BrowserPageScrollResult> => {
    ctx.abortSignal.throwIfAborted()
    requireActiveBrowserSite(ctx)

    // 方向滚动和像素偏移都交给 runtime 统一解释。
    return ctx.browser.scrollPage({
      direction,
      amount,
      x,
      y,
    })
  },
})

/** 向当前焦点输入文本。 */
const browserTypeText = defineBrowserTool<{
  text: string
}>({
  name: 'browser:type_text',
  role: 'control',
  summary: '向当前焦点元素输入文本。',
  suitable: ['需要模拟真实键盘输入。'],
  forbidden: ['不要在未确认焦点位置时输入敏感或破坏性内容。'],
  usage: ['先点击或 Tab 到目标控件，再传 text。'],
  examples: [{ text: "VelarOS" }],
  notes: ['不会直接修改 DOM value。'],
  schema: z.object({
    text: z.string().min(1).max(20000).describe(
      parameterDescription({
        description: '要输入到当前焦点元素的文本。',
      })
    ),
  }),
  permissions: ['network', 'input:control'],
  capabilities: BrowserControlCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  execute: async ({ text }, ctx): Promise<BrowserTypeTextResult> => {
    ctx.abortSignal.throwIfAborted()
    requireActiveBrowserSite(ctx)

    // 这里只模拟真实输入，不直接改 DOM value。
    return ctx.browser.typeText({
      text,
    })
  },
})

/** 发送键盘按键。 */
const browserPressKey = defineBrowserTool<{
  key: string
  modifiers?: BrowserPressKeyOptions['modifiers']
  repeat?: number
  waitForNavigation?: boolean
}>({
  name: 'browser:press_key',
  role: 'control',
  summary: '向当前页面发送键盘按键。',
  suitable: ['需要提交表单、切换焦点或触发键盘快捷键。'],
  forbidden: ['不要在不清楚焦点位置时发送破坏性快捷键。'],
  usage: ['传 key；组合键可直接传 Ctrl+a，也可用 key 加 modifiers。'],
  examples: [{ key: "Enter" }, { key: "Ctrl+a" }],
  notes: ['按键作用于当前页面焦点。'],
  schema: z.object({
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
    waitForNavigation: z
      .boolean()
      .optional()
      .describe(
        parameterDescription({
          description: '按键后是否等待可能的页面导航完成。',
          notes: ['默认 false。'],
        })
      ),
  }),
  permissions: ['network', 'input:control'],
  capabilities: BrowserControlCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  execute: async (
    { key, modifiers, repeat, waitForNavigation },
    ctx
  ): Promise<BrowserPressKeyResult> => {
    ctx.abortSignal.throwIfAborted()
    requireActiveBrowserSite(ctx)

    // waitForNavigation 由调用者显式控制，避免普通按键误等导航。
    return ctx.browser.pressKey({
      key,
      modifiers,
      repeat,
      waitForNavigation,
    })
  },
})

/** 移动虚拟鼠标。 */
const browserMoveMouse = defineBrowserTool<{
  x: number
  y: number
}>({
  name: 'browser:move_mouse',
  role: 'control',
  summary: '移动当前页面的虚拟鼠标。',
  suitable: ['需要悬停触发 UI，或在坐标点击前移动光标。'],
  forbidden: ['不要用它点击；点击用 browser:click_coordinates。'],
  usage: ['传视口坐标 x 和 y。'],
  examples: [{ x: 120, y: 240 }],
  notes: ['坐标基于当前 viewport。'],
  schema: z.object({
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
  }),
  permissions: ['network', 'input:control'],
  capabilities: BrowserControlCapability,
  surfaces: {
    preset: {
      role: 'control',
      summary: '按视口坐标移动鼠标。',
      suitable: ['需要用简化参数移动光标。'],
      forbidden: ['不要用于点击页面。'],
      usage: ['传 x 和 y。'],
      examples: [{ x: 80, y: 160 }],
      notes: ['坐标基于当前 viewport。'],
      schema: z.object({
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
      }),
      normalize: (input) => ({
        x: isNumber(input.x) ? input.x : 0,
        y: isNumber(input.y) ? input.y : 0,
      }),
    },
    guided: {
      role: 'control',
      summary: '用紧凑参数移动鼠标。',
      suitable: ['截图定位后需要把鼠标移到固定坐标。'],
      forbidden: ['不要用它点击页面。'],
      usage: ['传 x 和 y。'],
      examples: [{ x: 120, y: 240 }],
      notes: ['坐标基于当前 viewport。'],
      schema: browserClickCoordinatesGuidedSchema,
      normalize: normalizeBrowserClickCoordinatesGuided,
    },
  },
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  execute: async ({ x, y }, ctx): Promise<BrowserMoveMouseResult> => {
    ctx.abortSignal.throwIfAborted()
    requireActiveBrowserSite(ctx)

    // 鼠标坐标基于当前 viewport，而不是整个页面文档坐标。
    return ctx.browser.moveMouse({
      x,
      y,
    })
  },
})

/** 以 viewport 坐标点击页面。 */
const browserClickCoordinates = defineBrowserTool<{
  x: number
  y: number
  button?: BrowserClickCoordinatesOptions['button']
  clickCount?: number
  waitForNavigation?: boolean
}>({
  name: 'browser:click_coordinates',
  role: 'control',
  summary: '按视口坐标点击页面。',
  suitable: ['无法稳定定位元素，只能按截图坐标点击。'],
  forbidden: ['不要优先使用坐标点击；能定位元素时用 target action。'],
  usage: ['传 x、y；按需传 button、clickCount 和 waitForNavigation。'],
  examples: [{ x: 200, y: 320 }],
  notes: ['坐标基于当前 viewport。'],
  schema: z.object({
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
    waitForNavigation: z
      .boolean()
      .optional()
      .describe(
        parameterDescription({
          description: '点击后是否等待可能的页面导航完成。',
          notes: ['默认 true。'],
        })
      ),
  }),
  permissions: ['network', 'input:control'],
  capabilities: BrowserControlCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  execute: async (
    { x, y, button, clickCount, waitForNavigation },
    ctx
  ): Promise<BrowserClickCoordinatesResult> => {
    ctx.abortSignal.throwIfAborted()
    requireActiveBrowserSite(ctx)

    // 坐标点击是兜底方案，runtime 可根据 waitForNavigation 决定是否等待加载。
    return ctx.browser.clickCoordinates({
      x,
      y,
      button,
      clickCount,
      waitForNavigation,
    })
  },
})

/** 等待页面中某个 selector 达到期望状态。 */
const browserWaitForSelector = defineBrowserTool<{
  selector: string
  state?: 'attached' | 'visible' | 'hidden' | 'detached'
  visible?: boolean
  timeoutMs?: number
}>({
  name: 'browser:wait_for_selector',
  role: 'control',
  summary: '等待页面元素出现。',
  suitable: ['点击、跳转、输入或异步加载后等待元素出现、可见、隐藏或移除。'],
  forbidden: ['不要用它等待任意文本；文本检查用页面查询或检查工具。'],
  usage: ['传 selector 和 state；visible=true 等价于 state=visible；同源 iframe 内元素可用 `iframe[...] >> .inner`。'],
  examples: [{ selector: ".results", state: 'visible' }, { selector: 'iframe[name="checkout"] >> .ready', state: 'visible' }],
  notes: ['等待期间不应并发执行其他页面操作。', '`>>` 只进入同源 iframe；跨域 iframe 和 OOPIF 不在当前页面脚本路径内。'],
  schema: z.object({
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
        notes: ['省略时等待 attached。'],
      })
    ),
    visible: z.boolean().optional().describe(
      parameterDescription({
        description: 'state=visible 的布尔简写。',
      })
    ),
    timeoutMs: z
      .number()
      .transform((value) => Math.min(60000, Math.max(1, Math.round(value))))
      .optional()
      .describe(
        parameterDescription({
          description: '最长等待毫秒数。',
          notes: ['默认 5000。', '上限 60000,超出自动钳制。'],
        })
      ),
  }),
  permissions: ['network'],
  capabilities: BrowserObserveCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  execute: async ({ selector, state, visible, timeoutMs }, ctx): Promise<BrowserWaitForSelectorResult> => {
    ctx.abortSignal.throwIfAborted()
    requireActiveBrowserSite(ctx)

    // 等待工具有时间副作用，不能与其他页面操作并发。
    return ctx.browser.waitForSelector({
      selector,
      state,
      visible,
      timeoutMs,
    })
  },
})

/** 等待页面加载状态或短暂停顿。 */
const browserWaitForPage = defineBrowserTool<{
  durationMs?: number
  loadState?: BrowserPageWaitOptions['loadState']
  urlPattern?: string
  functionExpression?: string
  text?: string
  timeoutMs?: number
}>({
  name: 'browser:wait_for_page',
  role: 'control',
  summary: '等待当前页面 URL、文本、表达式、加载状态或短暂停顿。',
  suitable: ['点击、输入、滚动后等待动画、轻量 SPA 更新、懒加载、URL 变化、页面正文出现文本、页面表达式成立、readyState 或网络空闲稳定。'],
  forbidden: ['不要用它等待具体元素；明确目标时用 action=wait_for_selector。'],
  usage: ['传 durationMs 短暂停顿，传 loadState 等待 domcontentloaded/load/networkidle，传 urlPattern 等待 URL 变化，传 text 等待正文文本，或传 functionExpression 轮询页面表达式；可组合使用。'],
  examples: [
    { loadState: 'domcontentloaded', durationMs: 250 },
    { urlPattern: '*/settings*' },
    { text: 'Loaded profile' },
    { functionExpression: 'document.querySelector(".ready") !== null' },
  ],
  notes: ['等待期间不应并发执行其他页面操作。'],
  schema: z
    .object({
      durationMs: z.number().transform((value) => Math.min(60000, Math.max(1, Math.round(value)))).optional().describe(
        parameterDescription({
          description: '额外等待的毫秒数。',
          notes: ['适合等待动画、轻量 SPA 更新或懒加载。', '上限 60000,超出自动钳制。'],
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
      urlPattern: z.string().min(1).max(2048).optional().describe(
        parameterDescription({
          description: '要等待出现在当前页面 URL 中的字符串，支持 * 通配。',
          usage: ['例如 /settings 或 */settings*。'],
        })
      ),
      functionExpression: z.string().min(1).max(5000).optional().describe(
        parameterDescription({
          description: '要重复执行直到返回 truthy 的页面 JavaScript 表达式。',
          notes: ['表达式在页面上下文执行。'],
        })
      ),
      text: z.string().min(1).max(5000).optional().describe(
        parameterDescription({
          description: '要等待出现在页面正文中的文本。',
        })
      ),
      timeoutMs: z.number().transform((value) => Math.min(60000, Math.max(1, Math.round(value)))).optional().describe(
        parameterDescription({
          description: '等待 loadState、urlPattern、text 或 functionExpression 的最长毫秒数。',
          notes: ['默认 5000。', '上限 60000,超出自动钳制。'],
        })
      ),
    })
    .superRefine((input, issueCtx) => {
      if (
        !isNumber(input.durationMs) &&
        !isPresent(input.loadState) &&
        !isPresent(input.urlPattern) &&
        !isPresent(input.functionExpression) &&
        !isPresent(input.text)
      ) {
        issueCtx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['durationMs'],
          message: '必须提供 durationMs、loadState、urlPattern、text 或 functionExpression。',
        })
      }
    }),
  permissions: ['network'],
  capabilities: BrowserObserveCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  execute: async (
    { durationMs, loadState, urlPattern, functionExpression, text, timeoutMs },
    ctx
  ): Promise<BrowserPageWaitResult> => {
    ctx.abortSignal.throwIfAborted()
    requireActiveBrowserSite(ctx)

    const waitOptions: BrowserPageWaitOptions = {}
    if (isNumber(durationMs)) waitOptions.durationMs = durationMs
    if (isPresent(loadState)) waitOptions.loadState = loadState
    if (isPresent(urlPattern)) waitOptions.urlPattern = urlPattern
    if (isPresent(functionExpression)) waitOptions.functionExpression = functionExpression
    if (isPresent(text)) waitOptions.text = text
    if (isNumber(timeoutMs)) waitOptions.timeoutMs = timeoutMs

    return ctx.browser.waitForPage(waitOptions)
  },
})

/** 设置当前页面 viewport 尺寸。 */
const browserSetViewport = defineBrowserTool<{
  width: number
  height: number
}>({
  name: 'browser:set_viewport',
  role: 'control',
  summary: '设置当前页面的 CSS viewport 分辨率。',
  suitable: ['检查响应式设计、复现移动端或桌面端布局，或截图前固定尺寸。'],
  forbidden: ['不要用它缩放页面内容；缩放用 browser:set_page_zoom。'],
  usage: ['传 width 和 height。'],
  examples: [{ width: 1440, height: 900 }],
  notes: ['浏览器工作区外框保持不变，页面会在内部按目标分辨率缩放；会影响后续截图和坐标操作。'],
  schema: z.object({
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
  }),
  permissions: ['network'],
  capabilities: BrowserControlCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  execute: async ({ width, height }, ctx): Promise<BrowserViewportResult> => {
    ctx.abortSignal.throwIfAborted()
    requireActiveBrowserSite(ctx)

    // viewport 改变会影响后续截图、坐标点击和响应式布局。
    return ctx.browser.setViewport({
      width,
      height,
    })
  },
})

/** 设置当前页面缩放比例。 */
const browserSetPageZoom = defineBrowserTool<{
  action: BrowserPageZoomOptions['action']
  zoomFactor?: number
  step?: number
}>({
  name: 'browser:set_page_zoom',
  role: 'control',
  summary: '调整当前页面缩放比例。',
  suitable: ['文字过小、坐标点击困难，或需要缩小查看页面宽度。'],
  forbidden: ['不要用它改变 viewport 尺寸；视口尺寸用 browser:set_viewport。'],
  usage: ['传 action；action=set 时传 zoomFactor。'],
  examples: [{ action: "reset" }],
  notes: ['缩放影响视觉呈现和坐标映射。'],
  schema: z
    .object({
      action: z
        .enum(['in', 'out', 'reset', 'set'])
        .describe(
          parameterDescription({
            description: '缩放动作。',
            values: [
              'in：放大。',
              'out：缩小。',
              'reset：回到 100%。',
              'set：设置指定比例。',
            ],
            usage: ['action=set 时必须传 zoomFactor。'],
          })
        ),
      zoomFactor: z
        .number()
        .min(0.25)
        .max(3)
        .optional()
        .describe(
          parameterDescription({
            description: '要设置的缩放比例。',
            usage: ['仅 action=set 时使用。'],
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
    .superRefine((input, issueCtx) => {
      if (input.action === 'set' && !isNumber(input.zoomFactor)) {
        issueCtx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['zoomFactor'],
          message: 'action=set 时必须提供 zoomFactor。',
        })
      }
    }),
  permissions: ['network'],
  capabilities: BrowserControlCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  execute: async ({ action, zoomFactor, step }, ctx): Promise<BrowserPageZoomResult> => {
    ctx.abortSignal.throwIfAborted()
    requireActiveBrowserSite(ctx)

    return ctx.browser.setPageZoom({
      action,
      zoomFactor: toOptional(numberOrNull(zoomFactor)),
      step: toOptional(numberOrNull(step)),
    })
  },
})

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
    'action=target 时传 targetAction 和 target；targetAction=fill/select 必须传 value。',
    'action=drag 时传 source 和 target；action=navigate 可只传 url，系统会按 goto 处理。',
    '页面是异步的：动作之后用 wait_for_selector/wait_for_text/wait 等到位再读结果，别靠重试。',
  ],
  examples: [
    // 点击定位到的元素
    {
      action: 'target',
      targetAction: 'click',
      target: { css: 'button[type=submit]' },
    },
    // 填写输入框：targetAction=fill 必须带字符串 value
    {
      action: 'target',
      targetAction: 'fill',
      target: { css: 'input[name=email]' },
      value: 'user@example.com',
    },
    // 原生 select 多选：value 传字符串数组
    {
      action: 'target',
      targetAction: 'select',
      target: { css: 'select[multiple]' },
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
      source: { css: '[data-testid=card]' },
      target: { css: '[data-testid=drop-zone]' },
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
  execute: async (input, ctx) => {
    const parsed = parseBrowserActInput(input)

    switch (parsed.action) {
      case 'target':
        return browserPerformTargetAction.execute(
          {
            action: parsed.targetAction,
            target: parsed.target,
            value: parsed.value,
            waitForNavigation: parsed.waitForNavigation,
          },
          ctx
        )
      case 'navigate':
        return browserNavigatePage.execute(
          {
            action: parsed.navigationAction,
            url: parsed.url,
          },
          ctx
        )
      case 'scroll':
        return browserScrollPage.execute(
          {
            direction: parsed.direction,
            amount: parsed.amount,
            x: parsed.x,
            y: parsed.y,
          },
          ctx
        )
      case 'type':
        return browserTypeText.execute(
          {
            text: parsed.text,
          },
          ctx
        )
      case 'press_key':
        return browserPressKey.execute(
          {
            key: parsed.key,
            modifiers: parsed.modifiers,
            repeat: parsed.repeat,
            waitForNavigation: parsed.waitForNavigation,
          },
          ctx
        )
      case 'move_mouse':
        return browserMoveMouse.execute(
          {
            x: parsed.x,
            y: parsed.y,
          },
          ctx
        )
      case 'click_coordinates':
        return browserClickCoordinates.execute(
          {
            x: parsed.x,
            y: parsed.y,
            button: parsed.button,
            clickCount: parsed.clickCount,
            waitForNavigation: parsed.waitForNavigation,
          },
          ctx
        )
      case 'drag':
        return ctx.browser.dragTargets({
          source: normalizeBrowserTargetHint(parsed.source),
          target: normalizeBrowserTargetHint(parsed.target),
          steps: parsed.steps,
          ...(!isPresent(parsed.waitForNavigation)
            ? {}
            : { waitForNavigation: parsed.waitForNavigation }),
        })
      case 'wait_for_selector':
        return browserWaitForSelector.execute(
          {
            selector: parsed.selector,
            state: parsed.state,
            visible: parsed.visible,
            timeoutMs: parsed.timeoutMs,
          },
          ctx
        )
      case 'wait_for_url':
        return browserWaitForPage.execute(
          {
            urlPattern: parsed.urlPattern,
            timeoutMs: parsed.timeoutMs,
          },
          ctx
        )
      case 'wait_for_function':
        return browserWaitForPage.execute(
          {
            functionExpression: parsed.expression,
            timeoutMs: parsed.timeoutMs,
          },
          ctx
        )
      case 'wait_for_text':
        return browserWaitForPage.execute(
          {
            text: parsed.text,
            timeoutMs: parsed.timeoutMs,
          },
          ctx
        )
      case 'wait':
        return browserWaitForPage.execute(
          {
            durationMs: parsed.durationMs,
            loadState: parsed.loadState,
            timeoutMs: parsed.timeoutMs,
          },
          ctx
        )
      case 'set_viewport':
        return browserSetViewport.execute(
          {
            width: parsed.width,
            height: parsed.height,
          },
          ctx
        )
      case 'set_page_zoom':
        return browserSetPageZoom.execute(
          {
            action: parsed.zoomAction,
            zoomFactor: parsed.zoomFactor,
            step: parsed.step,
          },
          ctx
        )
      case 'configure_network':
        ctx.abortSignal.throwIfAborted()
        requireActiveBrowserSite(ctx)
        return ctx.browser.configureNetwork({
          offline: parsed.offline,
          extraHTTPHeaders: parsed.extraHTTPHeaders,
          blockedURLPatterns: parsed.blockedURLPatterns,
          blockedResourceTypes: parsed.blockedResourceTypes,
          mockResponses: parsed.mockResponses,
        })
      case 'configure_emulation':
        ctx.abortSignal.throwIfAborted()
        requireActiveBrowserSite(ctx)
        return ctx.browser.configureEmulation({
          colorScheme: parsed.colorScheme,
          reducedMotion: parsed.reducedMotion,
          timezoneId: parsed.timezoneId,
          locale: parsed.locale,
          geolocation: parsed.geolocation,
          cpuThrottlingRate: parsed.cpuThrottlingRate,
          networkThrottling: parsed.networkThrottling,
        })
      default:
        parsed satisfies never
        throw new AppError('VALIDATION', 'Unsupported browser:act action.')
    }
  },
})

const browserInteractionTools = {
  'browser:act': browserAct,
}
export { browserInteractionTools }
