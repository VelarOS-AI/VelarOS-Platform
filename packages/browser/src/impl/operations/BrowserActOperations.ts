import { isNumber, isPresent, numberOrNull, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { BrowserToolContext } from '../../contract/requires'
import type { BrowserPageWaitOptions } from '../../types/browser'
import type { ParsedBrowserActInput } from '../../types/tools'
import { normalizeBrowserTargetHint } from '../../utils/schemas/target'
import { performTargetActionWithRecovery } from '../../utils/target-recovery'
import { requireActiveBrowserSite } from '../../utils/tool.js'

/**
 * `browser:act` 背后的执行类：把校验并收敛好的入参分派到 17 个动作分支。
 *
 * 每次工具调用建一份，实例带住这一次调用的工具上下文；`perform` 是唯一入口，
 * 入参已由 `parseBrowserActInput` 校验并归一，走到这里不会再有未知 action。
 * 动作本身失败（目标找不到、等待超时）由宿主端口按错误码抛出，这里不吞不译。
 */
export interface BrowserActOperationsApi {
  /** 执行一次页面动作，返回该动作的回执；未进站点时抛 VALIDATION。 */
  perform(input: ParsedBrowserActInput): Promise<unknown>
}

export class BrowserActOperations implements BrowserActOperationsApi {
  constructor(private readonly ctx: BrowserToolContext) {}

  public async perform(input: ParsedBrowserActInput): Promise<unknown> {
    switch (input.action) {
      case 'target':
        return this.performTargetAction(input)
      case 'navigate':
        return this.navigatePage(input)
      case 'scroll':
        return this.scrollPage(input)
      case 'type':
        return this.typeText(input)
      case 'press_key':
        return this.pressKey(input)
      case 'move_mouse':
        return this.moveMouse(input)
      case 'click_coordinates':
        return this.clickCoordinates(input)
      case 'drag':
        return this.dragTargets(input)
      case 'wait_for_selector':
        return this.waitForSelector(input)
      case 'wait_for_url':
        return this.waitForPage({ urlPattern: input.urlPattern, timeoutMs: input.timeoutMs })
      case 'wait_for_function':
        return this.waitForPage({ functionExpression: input.expression, timeoutMs: input.timeoutMs })
      case 'wait_for_text':
        return this.waitForPage({ text: input.text, timeoutMs: input.timeoutMs })
      case 'wait':
        return this.waitForPage({
          durationMs: input.durationMs,
          loadState: input.loadState,
          timeoutMs: input.timeoutMs,
        })
      case 'set_viewport':
        return this.setViewport(input)
      case 'set_page_zoom':
        return this.setPageZoom(input)
      case 'configure_network':
        return this.configureNetwork(input)
      case 'configure_emulation':
        return this.configureEmulation(input)
      default:
        input satisfies never
        throw new AppError('VALIDATION', 'browser:act 不认识这个 action。')
    }
  }

  /** 进入任一动作分支前的共用前置：响应中止信号、确认已经进站点。 */
  private begin(): void {
    this.ctx.abortSignal.throwIfAborted()
    requireActiveBrowserSite(this.ctx)
  }

  /** 对 inspect/query 得到的 target 执行点击、填充、聚焦或悬停。 */
  private async performTargetAction(input: Extract<ParsedBrowserActInput, { action: 'target' }>) {
    this.begin()

    return performTargetActionWithRecovery(
      {
        action: input.targetAction,
        target: normalizeBrowserTargetHint(input.target),
        value: input.value,
        waitForNavigation: input.waitForNavigation,
      },
      this.ctx
    )
  }

  /** 控制当前页面导航：后退、前进、刷新或 goto。 */
  private async navigatePage(input: Extract<ParsedBrowserActInput, { action: 'navigate' }>) {
    this.begin()

    // navigatePage 会在 runtime 内等待导航并同步页面状态。
    return this.ctx.browser.navigatePage({ action: input.navigationAction, url: input.url })
  }

  /** 滚动当前页面：方向滚动和像素偏移都交给 runtime 统一解释。 */
  private async scrollPage(input: Extract<ParsedBrowserActInput, { action: 'scroll' }>) {
    this.begin()

    return this.ctx.browser.scrollPage({
      direction: input.direction,
      amount: input.amount,
      x: input.x,
      y: input.y,
    })
  }

  /** 向当前焦点输入文本：只模拟真实输入，不直接改 DOM value。 */
  private async typeText(input: Extract<ParsedBrowserActInput, { action: 'type' }>) {
    this.begin()

    return this.ctx.browser.typeText({ text: input.text })
  }

  /** 发送键盘按键；waitForNavigation 由入参显式控制，避免普通按键误等导航。 */
  private async pressKey(input: Extract<ParsedBrowserActInput, { action: 'press_key' }>) {
    this.begin()

    return this.ctx.browser.pressKey({
      key: input.key,
      modifiers: input.modifiers,
      repeat: input.repeat,
      waitForNavigation: input.waitForNavigation,
    })
  }

  /** 移动虚拟鼠标；坐标基于当前 viewport，而不是整个页面文档坐标。 */
  private async moveMouse(input: Extract<ParsedBrowserActInput, { action: 'move_mouse' }>) {
    this.begin()

    return this.ctx.browser.moveMouse({ x: input.x, y: input.y })
  }

  /** 以 viewport 坐标点击页面：定位不到元素时的兜底方案。 */
  private async clickCoordinates(
    input: Extract<ParsedBrowserActInput, { action: 'click_coordinates' }>
  ) {
    this.begin()

    return this.ctx.browser.clickCoordinates({
      x: input.x,
      y: input.y,
      button: input.button,
      clickCount: input.clickCount,
      waitForNavigation: input.waitForNavigation,
    })
  }

  /** 把一个目标元素拖到另一个目标元素上。 */
  private async dragTargets(input: Extract<ParsedBrowserActInput, { action: 'drag' }>) {
    this.begin()

    return this.ctx.browser.dragTargets({
      source: normalizeBrowserTargetHint(input.source),
      target: normalizeBrowserTargetHint(input.target),
      steps: input.steps,
      waitForNavigation: toOptional(input.waitForNavigation),
    })
  }

  /** 等待页面里某个 selector 达到期望状态。 */
  private async waitForSelector(
    input: Extract<ParsedBrowserActInput, { action: 'wait_for_selector' }>
  ) {
    this.begin()

    return this.ctx.browser.waitForSelector({
      selector: input.selector,
      state: input.state,
      visible: input.visible,
      timeoutMs: input.timeoutMs,
    })
  }

  /** 等待 URL、页面表达式、正文文本、加载状态或短暂停顿：四个 wait 分支共用一个端口。 */
  private async waitForPage(input: {
    durationMs?: number
    loadState?: BrowserPageWaitOptions['loadState']
    urlPattern?: string
    functionExpression?: string
    text?: string
    timeoutMs?: number
  }) {
    this.begin()

    const waitOptions: BrowserPageWaitOptions = {}
    if (isNumber(input.durationMs)) waitOptions.durationMs = input.durationMs
    if (isPresent(input.loadState)) waitOptions.loadState = input.loadState
    if (isPresent(input.urlPattern)) waitOptions.urlPattern = input.urlPattern
    if (isPresent(input.functionExpression))
      waitOptions.functionExpression = input.functionExpression
    if (isPresent(input.text)) waitOptions.text = input.text
    if (isNumber(input.timeoutMs)) waitOptions.timeoutMs = input.timeoutMs

    return this.ctx.browser.waitForPage(waitOptions)
  }

  /** 设置页面 viewport 尺寸：会影响后续截图、坐标点击和响应式布局。 */
  private async setViewport(input: Extract<ParsedBrowserActInput, { action: 'set_viewport' }>) {
    this.begin()

    return this.ctx.browser.setViewport({ width: input.width, height: input.height })
  }

  /** 设置页面缩放比例。 */
  private async setPageZoom(input: Extract<ParsedBrowserActInput, { action: 'set_page_zoom' }>) {
    this.begin()

    return this.ctx.browser.setPageZoom({
      action: input.zoomAction,
      zoomFactor: toOptional(numberOrNull(input.zoomFactor)),
      step: toOptional(numberOrNull(input.step)),
    })
  }

  /** 配置网络：离线、额外请求头、拦截与 mock 响应。 */
  private async configureNetwork(
    input: Extract<ParsedBrowserActInput, { action: 'configure_network' }>
  ) {
    this.begin()

    return this.ctx.browser.configureNetwork({
      offline: input.offline,
      extraHTTPHeaders: input.extraHTTPHeaders,
      blockedURLPatterns: input.blockedURLPatterns,
      blockedResourceTypes: input.blockedResourceTypes,
      mockResponses: input.mockResponses,
    })
  }

  /** 配置环境模拟：配色方案、动效偏好、时区、语言、地理位置、CPU 与网络节流。 */
  private async configureEmulation(
    input: Extract<ParsedBrowserActInput, { action: 'configure_emulation' }>
  ) {
    this.begin()

    return this.ctx.browser.configureEmulation({
      colorScheme: input.colorScheme,
      reducedMotion: input.reducedMotion,
      timezoneId: input.timezoneId,
      locale: input.locale,
      geolocation: input.geolocation,
      cpuThrottlingRate: input.cpuThrottlingRate,
      networkThrottling: input.networkThrottling,
    })
  }
}
