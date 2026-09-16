import type { z } from 'zod'

import { isNumber, isPresent, numberOrNull, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { type BrowserToolContext } from '../../contract/requires'
import type {
  BrowserClickCoordinatesOptions,
  BrowserClickCoordinatesResult,
  BrowserMoveMouseResult,
  BrowserPageNavigationOptions,
  BrowserPageNavigationResult,
  BrowserPageScrollOptions,
  BrowserPageScrollResult,
  BrowserPageWaitOptions,
  BrowserPageWaitResult,
  BrowserPageZoomOptions,
  BrowserPageZoomResult,
  BrowserPressKeyOptions,
  BrowserPressKeyResult,
  BrowserTargetActionOptions,
  BrowserTargetActionResult,
  BrowserTypeTextResult,
  BrowserViewportResult,
  BrowserWaitForSelectorResult,
} from '../../types/browser'
import { performTargetActionWithRecovery } from '../../utils/target-recovery'
import { defineBrowserTool, requireActiveBrowserSite } from '../../utils/tool.js'

import { browserActSchema, parseBrowserActInput } from './BrowserActSchema'
import { BrowserControlCapability } from './Capabilities'
import { type BrowserTargetHintInput, normalizeBrowserTargetHint } from './Target'

/**
 * browser:act 的 17 个动作分支。
 *
 * 这些分支只被本文件的 `browser:act` 调用，不是模型面工具：它们没有自己的说明、
 * 示例与 schema，入参已由 `parseBrowserActInput` 校验并归一。
 */

/** 对 inspect/query 得到的 target 执行点击、填充、聚焦或悬停。 */
async function browserPerformTargetAction(
  {
    action,
    target,
    value,
    waitForNavigation,
  }: {
    action: BrowserTargetActionOptions['action']
    target: BrowserTargetHintInput
    value?: BrowserTargetActionOptions['value']
    waitForNavigation?: boolean
  },
  ctx: BrowserToolContext
): Promise<BrowserTargetActionResult> {
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
}

/** 控制当前页面导航：后退、前进、刷新或 goto。 */
async function browserNavigatePage(
  { action, url }: { action: BrowserPageNavigationOptions['action']; url?: string },
  ctx: BrowserToolContext
): Promise<BrowserPageNavigationResult> {
  ctx.abortSignal.throwIfAborted()
  requireActiveBrowserSite(ctx)

  // navigatePage 会在 runtime 内等待导航并同步页面状态。
  return ctx.browser.navigatePage({
    action,
    url,
  })
}

/** 滚动当前页面。 */
async function browserScrollPage(
  {
    direction,
    amount,
    x,
    y,
  }: {
    direction?: BrowserPageScrollOptions['direction']
    amount?: number
    x?: number
    y?: number
  },
  ctx: BrowserToolContext
): Promise<BrowserPageScrollResult> {
  ctx.abortSignal.throwIfAborted()
  requireActiveBrowserSite(ctx)

  // 方向滚动和像素偏移都交给 runtime 统一解释。
  return ctx.browser.scrollPage({
    direction,
    amount,
    x,
    y,
  })
}

/** 向当前焦点输入文本。 */
async function browserTypeText(
  { text }: { text: string },
  ctx: BrowserToolContext
): Promise<BrowserTypeTextResult> {
  ctx.abortSignal.throwIfAborted()
  requireActiveBrowserSite(ctx)

  // 这里只模拟真实输入，不直接改 DOM value。
  return ctx.browser.typeText({
    text,
  })
}

/** 发送键盘按键。 */
async function browserPressKey(
  {
    key,
    modifiers,
    repeat,
    waitForNavigation,
  }: {
    key: string
    modifiers?: BrowserPressKeyOptions['modifiers']
    repeat?: number
    waitForNavigation?: boolean
  },
  ctx: BrowserToolContext
): Promise<BrowserPressKeyResult> {
  ctx.abortSignal.throwIfAborted()
  requireActiveBrowserSite(ctx)

  // waitForNavigation 由调用者显式控制，避免普通按键误等导航。
  return ctx.browser.pressKey({
    key,
    modifiers,
    repeat,
    waitForNavigation,
  })
}

/** 移动虚拟鼠标。 */
async function browserMoveMouse(
  { x, y }: { x: number; y: number },
  ctx: BrowserToolContext
): Promise<BrowserMoveMouseResult> {
  ctx.abortSignal.throwIfAborted()
  requireActiveBrowserSite(ctx)

  // 鼠标坐标基于当前 viewport，而不是整个页面文档坐标。
  return ctx.browser.moveMouse({
    x,
    y,
  })
}

/** 以 viewport 坐标点击页面。 */
async function browserClickCoordinates(
  {
    x,
    y,
    button,
    clickCount,
    waitForNavigation,
  }: {
    x: number
    y: number
    button?: BrowserClickCoordinatesOptions['button']
    clickCount?: number
    waitForNavigation?: boolean
  },
  ctx: BrowserToolContext
): Promise<BrowserClickCoordinatesResult> {
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
}

/** 等待页面中某个 selector 达到期望状态。 */
async function browserWaitForSelector(
  {
    selector,
    state,
    visible,
    timeoutMs,
  }: {
    selector: string
    state?: 'attached' | 'visible' | 'hidden' | 'detached'
    visible?: boolean
    timeoutMs?: number
  },
  ctx: BrowserToolContext
): Promise<BrowserWaitForSelectorResult> {
  ctx.abortSignal.throwIfAborted()
  requireActiveBrowserSite(ctx)

  // 等待工具有时间副作用，不能与其他页面操作并发。
  return ctx.browser.waitForSelector({
    selector,
    state,
    visible,
    timeoutMs,
  })
}

/** 等待页面加载状态或短暂停顿。 */
async function browserWaitForPage(
  {
    durationMs,
    loadState,
    urlPattern,
    functionExpression,
    text,
    timeoutMs,
  }: {
    durationMs?: number
    loadState?: BrowserPageWaitOptions['loadState']
    urlPattern?: string
    functionExpression?: string
    text?: string
    timeoutMs?: number
  },
  ctx: BrowserToolContext
): Promise<BrowserPageWaitResult> {
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
}

/** 设置当前页面 viewport 尺寸。 */
async function browserSetViewport(
  { width, height }: { width: number; height: number },
  ctx: BrowserToolContext
): Promise<BrowserViewportResult> {
  ctx.abortSignal.throwIfAborted()
  requireActiveBrowserSite(ctx)

  // viewport 改变会影响后续截图、坐标点击和响应式布局。
  return ctx.browser.setViewport({
    width,
    height,
  })
}

/** 设置当前页面缩放比例。 */
async function browserSetPageZoom(
  {
    action,
    zoomFactor,
    step,
  }: { action: BrowserPageZoomOptions['action']; zoomFactor?: number; step?: number },
  ctx: BrowserToolContext
): Promise<BrowserPageZoomResult> {
  ctx.abortSignal.throwIfAborted()
  requireActiveBrowserSite(ctx)

  return ctx.browser.setPageZoom({
    action,
    zoomFactor: toOptional(numberOrNull(zoomFactor)),
    step: toOptional(numberOrNull(step)),
  })
}


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
  execute: async (input, ctx) => {
    const parsed = parseBrowserActInput(input)

    switch (parsed.action) {
      case 'target':
        return browserPerformTargetAction(
          {
            action: parsed.targetAction,
            target: parsed.target,
            value: parsed.value,
            waitForNavigation: parsed.waitForNavigation,
          },
          ctx
        )
      case 'navigate':
        return browserNavigatePage(
          {
            action: parsed.navigationAction,
            url: parsed.url,
          },
          ctx
        )
      case 'scroll':
        return browserScrollPage(
          {
            direction: parsed.direction,
            amount: parsed.amount,
            x: parsed.x,
            y: parsed.y,
          },
          ctx
        )
      case 'type':
        return browserTypeText(
          {
            text: parsed.text,
          },
          ctx
        )
      case 'press_key':
        return browserPressKey(
          {
            key: parsed.key,
            modifiers: parsed.modifiers,
            repeat: parsed.repeat,
            waitForNavigation: parsed.waitForNavigation,
          },
          ctx
        )
      case 'move_mouse':
        return browserMoveMouse(
          {
            x: parsed.x,
            y: parsed.y,
          },
          ctx
        )
      case 'click_coordinates':
        return browserClickCoordinates(
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
          waitForNavigation: toOptional(parsed.waitForNavigation),
        })
      case 'wait_for_selector':
        return browserWaitForSelector(
          {
            selector: parsed.selector,
            state: parsed.state,
            visible: parsed.visible,
            timeoutMs: parsed.timeoutMs,
          },
          ctx
        )
      case 'wait_for_url':
        return browserWaitForPage(
          {
            urlPattern: parsed.urlPattern,
            timeoutMs: parsed.timeoutMs,
          },
          ctx
        )
      case 'wait_for_function':
        return browserWaitForPage(
          {
            functionExpression: parsed.expression,
            timeoutMs: parsed.timeoutMs,
          },
          ctx
        )
      case 'wait_for_text':
        return browserWaitForPage(
          {
            text: parsed.text,
            timeoutMs: parsed.timeoutMs,
          },
          ctx
        )
      case 'wait':
        return browserWaitForPage(
          {
            durationMs: parsed.durationMs,
            loadState: parsed.loadState,
            timeoutMs: parsed.timeoutMs,
          },
          ctx
        )
      case 'set_viewport':
        return browserSetViewport(
          {
            width: parsed.width,
            height: parsed.height,
          },
          ctx
        )
      case 'set_page_zoom':
        return browserSetPageZoom(
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
        throw new AppError('VALIDATION', 'browser:act 不认识这个 action。')
    }
  },
})

const browserInteractionTools = {
  'browser:act': browserAct,
}
export { browserInteractionTools }
