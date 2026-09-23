/**
 * 浏览器能力（`velaros:browser`）的操作：`BrowserOperations` 与整个进程唯一的 `browserOperations`。接口 `BrowserOperationsApi` 在本文件的类上方。
 * 一份实现挂在哪个空间都一样，空间之间的差别全在调用上下文里的端口 `BrowserSpacePort`（已经绑好会话与站点）上。
 */

import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import {
  BrowserEvaluateLimits,
  BrowserInspectLimits,
  BrowserPendingEventLimits,
  BrowserWaitLimits,
} from '../contract/constants.js'
import type { BrowserOperationContext } from '../contract/requires.js'
import type {
  BrowserActed,
  BrowserClickInput,
  BrowserDialogInput,
  BrowserDownloadDecisionInput,
  BrowserDownloadInput,
  BrowserDragInput,
  BrowserDragResult,
  BrowserEvaluateInput,
  BrowserExportPagePdfResult,
  BrowserFetchResourceResult,
  BrowserFillInput,
  BrowserFrameInfo,
  BrowserGotoInput,
  BrowserHandleDialogResult,
  BrowserHandleDownloadResult,
  BrowserHandlePermissionResult,
  BrowserHoverInput,
  BrowserInsertTextInput,
  BrowserInsertTextResult,
  BrowserInspectInput,
  BrowserKeyInput,
  BrowserKeyResult,
  BrowserMouseButtonInput,
  BrowserMouseMoveInput,
  BrowserMouseResult,
  BrowserOpened,
  BrowserOpenInput,
  BrowserPageInspection,
  BrowserPageNavigationResult,
  BrowserPageState,
  BrowserPageWindowState,
  BrowserPendingEventSummary,
  BrowserPermissionInput,
  BrowserPressInput,
  BrowserPressKeyResult,
  BrowserSavePdfInput,
  BrowserScreenshot,
  BrowserScreenshotInput,
  BrowserState,
  BrowserSwitchPageTargetResult,
  BrowserSwitchTabInput,
  BrowserUploadFileResult,
  BrowserUploadInput,
  BrowserWaitForEventInput,
  BrowserWaitForFunctionInput,
  BrowserWaitForLoadInput,
  BrowserWheelInput,
} from '../types/browser.js'
import {
  clickInput,
  dialogInput,
  downloadDecisionInput,
  downloadInput,
  dragInput,
  evaluateInput,
  fillInput,
  gotoInput,
  hoverInput,
  insertTextInput,
  inspectInput,
  keyInput,
  mouseButtonInput,
  mouseMoveInput,
  openInput,
  permissionInput,
  pressInput,
  savePdfInput,
  screenshotInput,
  switchTabInput,
  uploadInput,
  waitForEventInput,
  waitForFunctionInput,
  waitForLoadInput,
  wheelInput,
} from '../utils/input.js'
import { buildModelScreenshotOptions, projectScreenshot } from '../utils/screenshot-options.js'
import { scriptOutcomeValue } from '../utils/script-outcome.js'
import { requireOpenSite } from '../utils/site.js'
import { toElementTarget } from '../utils/target.js'
import { performTargetActionWithRecovery } from '../utils/target-recovery.js'
import { pollPageCondition, waitForPendingEvent } from '../utils/waits.js'

/**
 * @AgentView
 * 浏览器：打开网站、看页面、在页面里跑 JavaScript、真实的鼠标键盘输入、导航与等待、处理弹窗下载与权限、下载与导出。
 * 先 open 进站点，其余要页面的操作没进站点时抛 BROWSER_SITE_NOT_OPEN。读页面、改 DOM、读 localStorage 用 evaluate；
 * 要真实输入（事件 isTrusted、:hover、按键的默认行为、富文本编辑器）用 click、fill、press，或者 mouseDown、keyDown 这些原子自己拼。
 * 元素写法：inspect、标注截图给的 ref（如 @e3:g2，原样传回；新的一次 inspect 或标注截图之后旧 ref 作废），或 CSS selector，或结果里的 target。
 * 坐标一律是视口 CSS 像素，和截图的 coordinateMap 同一套。站点工作区是这个网站的私有目录：截图、下载、PDF 都落在那里，路径一律相对它，出不去。
 * 诊断、网络规则、性能、录屏与用户脚本在 velaros:devtools；直接发 CDP 命令在 velaros:cdp。
 */
export interface BrowserOperationsApi {
  /** @AgentView 打开一个网站并进入它的站点（换网站就再 open 一次，各站点的工作区互不相通）。
   * @OperationEffect write
   */
  open(input: BrowserOpenInput, ctx: BrowserOperationContext): Promise<BrowserOpened>
  /** @AgentView 退出站点：之后要页面的操作都要先 open；站点工作区里的文件留着。
   * @OperationEffect write
   */
  leave(ctx: BrowserOperationContext): Promise<void>
  /** @AgentView 看现在进没进站点、在哪一页、有哪些标签页、有没有挂着等处理的弹窗下载与权限；没进站点时也能调。
   * @OperationEffect none
   */
  state(ctx: BrowserOperationContext): Promise<BrowserState>
  /** @AgentView 把受控页面显示出来给用户看，不执行任何脚本。
   * @OperationEffect write
   */
  show(ctx: BrowserOperationContext): Promise<BrowserPageWindowState>
  /** @AgentView 把之后的操作切到外部浏览器的另一个标签页（不关闭任何窗口）。
   * @OperationEffect write
   */
  switchTab(
    input: BrowserSwitchTabInput,
    ctx: BrowserOperationContext
  ): Promise<BrowserSwitchPageTargetResult>
  /** @AgentView 看页面：正文、标题结构、链接、可交互元素与表单字段（元素带 target，可以直接交给 click 这类操作）。
   * @OperationEffect none
   */
  inspect(input: BrowserInspectInput, ctx: BrowserOperationContext): Promise<BrowserPageInspection>
  /** @AgentView 截图：图交给你看，返回值是落盘位置、坐标换算与标注说明。能在页面里读的（表格、列表、文字）用 evaluate 读，别靠截图。
   * @OperationEffect write
   */
  screenshot(
    input: BrowserScreenshotInput,
    ctx: BrowserOperationContext
  ): Promise<BrowserScreenshot>
  /**
   * @AgentView
   * 在页面里跑一段 JavaScript，交回它的值：结果按 JSON 整份取回（DOM 元素换成它的描述，环引用写成 "[Circular]"，日期照 toJSON），
   * 超过 10000000 个字符抛 BROWSER_RESULT_TOO_LARGE；页面里抛错（语法错误也算）抛 BROWSER_SCRIPT_FAILED，message 带页面的报错与它在 script 里的行列。
   * 读页面、取表格列表正文、改 DOM、设下拉框、读 localStorage 都用它。
   * @OperationEffect write
   */
  evaluate(input: BrowserEvaluateInput, ctx: BrowserOperationContext): Promise<any>
  /** @AgentView 列出页面的框架树：顶层页面与各层 iframe（含跨源的），id 交给 evaluate、waitForFunction 的 frame。页面跳转之后旧 id 作废。
   * @OperationEffect none
   */
  frames(ctx: BrowserOperationContext): Promise<BrowserFrameInfo[]>
  /** @AgentView 点一下元素或视口里的一个点；元素没找到时如实回 matched 为假与原因，只在唯一确定的元素上改用坐标补点。
   * @OperationEffect write
   */
  click(input: BrowserClickInput, ctx: BrowserOperationContext): Promise<BrowserActed>
  /** @AgentView 往输入框、文本域或可编辑区域写入文字，替换原来的内容（真实输入）。
   * @OperationEffect write
   */
  fill(input: BrowserFillInput, ctx: BrowserOperationContext): Promise<BrowserActed>
  /** @AgentView 把鼠标移到元素中心（悬停出菜单、提示）。
   * @OperationEffect write
   */
  hover(input: BrowserHoverInput, ctx: BrowserOperationContext): Promise<BrowserActed>
  /** @AgentView 在当前焦点处插入文字。
   * @OperationEffect write
   */
  insertText(
    input: BrowserInsertTextInput,
    ctx: BrowserOperationContext
  ): Promise<BrowserInsertTextResult>
  /** @AgentView 按一个键或组合键（提交表单按 Enter）。
   * @OperationEffect write
   */
  press(input: BrowserPressInput, ctx: BrowserOperationContext): Promise<BrowserPressKeyResult>
  /** @AgentView 按下一个键不放，直到 keyUp。
   * @OperationEffect write
   */
  keyDown(input: BrowserKeyInput, ctx: BrowserOperationContext): Promise<BrowserKeyResult>
  /** @AgentView 抬起一个按着的键。
   * @OperationEffect write
   */
  keyUp(input: BrowserKeyInput, ctx: BrowserOperationContext): Promise<BrowserKeyResult>
  /** @AgentView 把鼠标移到视口里的一个点（按着鼠标键时就是拖）。
   * @OperationEffect write
   */
  mouseMove(input: BrowserMouseMoveInput, ctx: BrowserOperationContext): Promise<BrowserMouseResult>
  /** @AgentView 在鼠标现在的位置按下一个鼠标键。
   * @OperationEffect write
   */
  mouseDown(
    input: BrowserMouseButtonInput,
    ctx: BrowserOperationContext
  ): Promise<BrowserMouseResult>
  /** @AgentView 在鼠标现在的位置松开一个鼠标键。
   * @OperationEffect write
   */
  mouseUp(input: BrowserMouseButtonInput, ctx: BrowserOperationContext): Promise<BrowserMouseResult>
  /** @AgentView 在鼠标现在的位置滚一下滚轮（地图、虚拟列表、只认滚轮的区域）；整页滚动在 evaluate 里 scrollBy 就行。
   * @OperationEffect write
   */
  wheel(input: BrowserWheelInput, ctx: BrowserOperationContext): Promise<BrowserMouseResult>
  /** @AgentView 把一个元素拖到另一个元素上。
   * @OperationEffect write
   */
  drag(input: BrowserDragInput, ctx: BrowserOperationContext): Promise<BrowserDragResult>
  /** @AgentView 给 file input 选一个站点工作区里的文件。
   * @OperationEffect write
   */
  upload(input: BrowserUploadInput, ctx: BrowserOperationContext): Promise<BrowserUploadFileResult>
  /** @AgentView 在当前站点里跳到一个网址（换网站用 open）。
   * @OperationEffect write
   */
  goto(input: BrowserGotoInput, ctx: BrowserOperationContext): Promise<BrowserPageNavigationResult>
  /** @AgentView 后退。
   * @OperationEffect write
   */
  back(ctx: BrowserOperationContext): Promise<BrowserPageNavigationResult>
  /** @AgentView 前进。
   * @OperationEffect write
   */
  forward(ctx: BrowserOperationContext): Promise<BrowserPageNavigationResult>
  /** @AgentView 刷新当前页。
   * @OperationEffect write
   */
  reload(ctx: BrowserOperationContext): Promise<BrowserPageNavigationResult>
  /** @AgentView 等页面里一个条件成立，交回判定式的值（元素出现、文字出现、地址变了、数据加载完，都写成一个判定式）。
   * @OperationEffect write
   */
  waitForFunction(input: BrowserWaitForFunctionInput, ctx: BrowserOperationContext): Promise<any>
  /** @AgentView 等页面加载到某个状态，交回那时的页面状态。
   * @OperationEffect none
   */
  waitForLoad(
    input: BrowserWaitForLoadInput,
    ctx: BrowserOperationContext
  ): Promise<BrowserPageState>
  /** @AgentView 等一个挂起事件出现，交回这个事件（点了下载按钮之后等下载事件，再 handleDownload）。
   * @OperationEffect none
   */
  waitForEvent(
    input: BrowserWaitForEventInput,
    ctx: BrowserOperationContext
  ): Promise<BrowserPendingEventSummary>
  /** @AgentView 处理 JS 弹窗（alert、confirm、prompt）。
   * @OperationEffect write
   */
  handleDialog(
    input: BrowserDialogInput,
    ctx: BrowserOperationContext
  ): Promise<BrowserHandleDialogResult>
  /** @AgentView 保存或取消一次下载。
   * @OperationEffect write
   */
  handleDownload(
    input: BrowserDownloadDecisionInput,
    ctx: BrowserOperationContext
  ): Promise<BrowserHandleDownloadResult>
  /** @AgentView 允许或拒绝一次权限请求。
   * @OperationEffect write
   */
  handlePermission(
    input: BrowserPermissionInput,
    ctx: BrowserOperationContext
  ): Promise<BrowserHandlePermissionResult>
  /** @AgentView 带着当前页面的登录态下载一个资源到站点工作区。
   * @OperationEffect write
   */
  download(
    input: BrowserDownloadInput,
    ctx: BrowserOperationContext
  ): Promise<BrowserFetchResourceResult>
  /** @AgentView 把当前页面导出成 PDF。
   * @OperationEffect write
   */
  savePdf(
    input: BrowserSavePdfInput,
    ctx: BrowserOperationContext
  ): Promise<BrowserExportPagePdfResult>
}

/**
 * 顺序是固定的：先查取消、再核对入参、再确认进了站点、最后经端口做事——入参错了或没进站点，端口上碰页面的方法一次都不调。
 * 整个进程共用一份，无状态。
 */
export class BrowserOperations implements BrowserOperationsApi {
  public async open(input: BrowserOpenInput, ctx: BrowserOperationContext): Promise<BrowserOpened> {
    ctx.abortSignal.throwIfAborted()
    const { url } = openInput(input)
    const site = await ctx.browser.enterSite(url)
    return { site, page: await ctx.browser.getPageState() }
  }

  public async leave(ctx: BrowserOperationContext): Promise<void> {
    ctx.abortSignal.throwIfAborted()
    // 离站时模型那条 CDP 会话一并断开：它设的仿真、拦截不该带到下一个站点去。
    if (ctx.browser.isActive()) await ctx.browser.resetProtocolSession()
    await ctx.browser.leaveSite()
  }

  public async state(ctx: BrowserOperationContext): Promise<BrowserState> {
    ctx.abortSignal.throwIfAborted()
    // 没进站点时不报错：程序常拿它探测「现在能不能用浏览器」。
    const site = ctx.browser.isActive() ? ctx.browser.getContext() : null
    if (!site) return { active: false }
    const [page, targets, pending] = await Promise.all([
      ctx.browser.getPageState(),
      ctx.browser.listPageTargets(),
      ctx.browser.listPendingEvents(),
    ])
    return { active: true, site, page, tabs: targets.targets, pending: pending.pending }
  }

  public async show(ctx: BrowserOperationContext): Promise<BrowserPageWindowState> {
    ctx.abortSignal.throwIfAborted()
    requireOpenSite(ctx)
    return ctx.browser.showPage()
  }

  public async switchTab(
    input: BrowserSwitchTabInput,
    ctx: BrowserOperationContext
  ): Promise<BrowserSwitchPageTargetResult> {
    ctx.abortSignal.throwIfAborted()
    const { targetId } = switchTabInput(input)
    requireOpenSite(ctx)
    return ctx.browser.switchPageTarget({ targetId })
  }

  public async inspect(
    input: BrowserInspectInput,
    ctx: BrowserOperationContext
  ): Promise<BrowserPageInspection> {
    ctx.abortSignal.throwIfAborted()
    const options = inspectInput(input)
    requireOpenSite(ctx)
    return ctx.browser.inspectPage({
      maxTextChars: options.maxTextChars ?? BrowserInspectLimits.textChars,
      includeHtml: options.includeHtml,
      maxHtmlChars: options.maxHtmlChars ?? BrowserInspectLimits.htmlChars,
      maxElements: options.maxElements ?? BrowserInspectLimits.elements,
      ignoreSelectors: options.ignoreSelectors,
    })
  }

  public async screenshot(
    input: BrowserScreenshotInput,
    ctx: BrowserOperationContext
  ): Promise<BrowserScreenshot> {
    ctx.abortSignal.throwIfAborted()
    const options = screenshotInput(input)
    requireOpenSite(ctx)
    const attach = ctx.attachImage
    const artifact = await ctx.browser.captureScreenshot(
      buildModelScreenshotOptions(options, !!attach)
    )
    // 图交给模型看，不进返回值：返回值是给程序的，程序看不了像素。
    if (attach && artifact.modelImage) {
      attach({
        mediaType: artifact.modelImage.mediaType,
        data: artifact.modelImage.data,
        label: `页面截图：${artifact.url}，图 ${artifact.modelImage.width}×${artifact.modelImage.height}，原图 ${artifact.relativePath}`,
      })
    }
    return projectScreenshot(artifact)
  }

  public async evaluate(input: BrowserEvaluateInput, ctx: BrowserOperationContext): Promise<any> {
    ctx.abortSignal.throwIfAborted()
    const options = evaluateInput(input)
    requireOpenSite(ctx)
    const outcome = await ctx.browser.evaluateScript({
      script: options.script,
      args: options.args,
      frame: options.frame,
      timeoutMs: options.timeoutMs ?? BrowserEvaluateLimits.defaultTimeoutMs,
      maxResultChars: BrowserEvaluateLimits.resultChars,
    })
    return scriptOutcomeValue(outcome)
  }

  public async frames(ctx: BrowserOperationContext): Promise<BrowserFrameInfo[]> {
    ctx.abortSignal.throwIfAborted()
    requireOpenSite(ctx)
    return ctx.browser.listFrames()
  }

  public async click(
    input: BrowserClickInput,
    ctx: BrowserOperationContext
  ): Promise<BrowserActed> {
    ctx.abortSignal.throwIfAborted()
    const request = clickInput(input)
    requireOpenSite(ctx)
    if (request.kind === 'target')
      return performTargetActionWithRecovery(
        {
          action: 'click',
          target: toElementTarget(request.target),
          waitForNavigation: request.waitForNavigation,
          button: request.button,
          clickCount: request.clickCount,
        },
        ctx
      )
    const clicked = await ctx.browser.clickCoordinates({
      x: request.x,
      y: request.y,
      button: request.button,
      clickCount: request.clickCount,
      waitForNavigation: request.waitForNavigation,
    })
    return {
      action: 'click',
      url: clicked.url,
      matched: true,
      selector: null,
      text: null,
      clickPoint: { x: clicked.x, y: clicked.y },
      clickMethod: 'coordinate',
      capturedAt: clicked.capturedAt,
    }
  }

  public async fill(input: BrowserFillInput, ctx: BrowserOperationContext): Promise<BrowserActed> {
    ctx.abortSignal.throwIfAborted()
    const { target, value } = fillInput(input)
    requireOpenSite(ctx)
    // 真实输入：页面里聚焦并全选，宿主再像输入法一样插入（空字符串就按退格删掉选中的），最后读一次控件状态。
    // 直接改 value 的写法 React 认不到（它盯着 value 的写入，判定「没变」），富文本编辑器也会把改动还原。
    const element = toElementTarget(target)
    const selected = await ctx.browser.performTargetAction({
      action: 'select_all',
      target: element,
    })
    if (!selected.matched) return { ...selected, action: 'fill' }
    if (isEmpty(value)) await ctx.browser.pressKey({ key: 'Backspace' })
    else await ctx.browser.insertText({ text: value })
    // 读状态的那一步不算动作效果：它前后页面本来就不变，带着它只会让模型以为没写进去。
    const { effect: _unchanged, ...filled } = await ctx.browser.performTargetAction({
      action: 'focus',
      target: element,
    })
    return { ...filled, action: 'fill' }
  }

  public async hover(
    input: BrowserHoverInput,
    ctx: BrowserOperationContext
  ): Promise<BrowserActed> {
    ctx.abortSignal.throwIfAborted()
    const { target } = hoverInput(input)
    requireOpenSite(ctx)
    return performTargetActionWithRecovery(
      { action: 'hover', target: toElementTarget(target) },
      ctx
    )
  }

  public async insertText(
    input: BrowserInsertTextInput,
    ctx: BrowserOperationContext
  ): Promise<BrowserInsertTextResult> {
    ctx.abortSignal.throwIfAborted()
    const { text } = insertTextInput(input)
    requireOpenSite(ctx)
    return ctx.browser.insertText({ text })
  }

  public async press(
    input: BrowserPressInput,
    ctx: BrowserOperationContext
  ): Promise<BrowserPressKeyResult> {
    ctx.abortSignal.throwIfAborted()
    const options = pressInput(input)
    requireOpenSite(ctx)
    return ctx.browser.pressKey(options)
  }

  public async keyDown(
    input: BrowserKeyInput,
    ctx: BrowserOperationContext
  ): Promise<BrowserKeyResult> {
    ctx.abortSignal.throwIfAborted()
    const { key } = keyInput(input, 'keyDown')
    requireOpenSite(ctx)
    return ctx.browser.keyDown({ key })
  }

  public async keyUp(
    input: BrowserKeyInput,
    ctx: BrowserOperationContext
  ): Promise<BrowserKeyResult> {
    ctx.abortSignal.throwIfAborted()
    const { key } = keyInput(input, 'keyUp')
    requireOpenSite(ctx)
    return ctx.browser.keyUp({ key })
  }

  public async mouseMove(
    input: BrowserMouseMoveInput,
    ctx: BrowserOperationContext
  ): Promise<BrowserMouseResult> {
    ctx.abortSignal.throwIfAborted()
    const move = mouseMoveInput(input)
    requireOpenSite(ctx)
    return ctx.browser.moveMouse(move)
  }

  public async mouseDown(
    input: BrowserMouseButtonInput,
    ctx: BrowserOperationContext
  ): Promise<BrowserMouseResult> {
    ctx.abortSignal.throwIfAborted()
    const press = mouseButtonInput(input, 'mouseDown')
    requireOpenSite(ctx)
    return ctx.browser.mouseDown(press)
  }

  public async mouseUp(
    input: BrowserMouseButtonInput,
    ctx: BrowserOperationContext
  ): Promise<BrowserMouseResult> {
    ctx.abortSignal.throwIfAborted()
    const release = mouseButtonInput(input, 'mouseUp')
    requireOpenSite(ctx)
    return ctx.browser.mouseUp(release)
  }

  public async wheel(
    input: BrowserWheelInput,
    ctx: BrowserOperationContext
  ): Promise<BrowserMouseResult> {
    ctx.abortSignal.throwIfAborted()
    const delta = wheelInput(input)
    requireOpenSite(ctx)
    return ctx.browser.mouseWheel(delta)
  }

  public async drag(
    input: BrowserDragInput,
    ctx: BrowserOperationContext
  ): Promise<BrowserDragResult> {
    ctx.abortSignal.throwIfAborted()
    const options = dragInput(input)
    requireOpenSite(ctx)
    return ctx.browser.dragTargets({
      source: toElementTarget(options.source),
      target: toElementTarget(options.target),
      steps: options.steps,
      waitForNavigation: options.waitForNavigation,
    })
  }

  public async upload(
    input: BrowserUploadInput,
    ctx: BrowserOperationContext
  ): Promise<BrowserUploadFileResult> {
    ctx.abortSignal.throwIfAborted()
    const options = uploadInput(input)
    requireOpenSite(ctx)
    return ctx.browser.uploadFile({
      target: toElementTarget(options.target),
      filePath: options.filePath,
    })
  }

  public async goto(
    input: BrowserGotoInput,
    ctx: BrowserOperationContext
  ): Promise<BrowserPageNavigationResult> {
    ctx.abortSignal.throwIfAborted()
    const { url } = gotoInput(input)
    requireOpenSite(ctx)
    return ctx.browser.navigatePage({ action: 'goto', url })
  }

  public async back(ctx: BrowserOperationContext): Promise<BrowserPageNavigationResult> {
    ctx.abortSignal.throwIfAborted()
    requireOpenSite(ctx)
    return ctx.browser.navigatePage({ action: 'back' })
  }

  public async forward(ctx: BrowserOperationContext): Promise<BrowserPageNavigationResult> {
    ctx.abortSignal.throwIfAborted()
    requireOpenSite(ctx)
    return ctx.browser.navigatePage({ action: 'forward' })
  }

  public async reload(ctx: BrowserOperationContext): Promise<BrowserPageNavigationResult> {
    ctx.abortSignal.throwIfAborted()
    requireOpenSite(ctx)
    return ctx.browser.navigatePage({ action: 'reload' })
  }

  public async waitForFunction(
    input: BrowserWaitForFunctionInput,
    ctx: BrowserOperationContext
  ): Promise<any> {
    ctx.abortSignal.throwIfAborted()
    const options = waitForFunctionInput(input)
    requireOpenSite(ctx)
    return pollPageCondition({
      evaluate: (timeoutMs) =>
        ctx.browser.evaluateScript({
          script: options.script,
          args: options.args,
          frame: options.frame,
          timeoutMs,
          maxResultChars: BrowserEvaluateLimits.resultChars,
        }),
      timeoutMs: options.timeoutMs ?? BrowserWaitLimits.defaultMs,
      intervalMs: options.intervalMs ?? BrowserWaitLimits.defaultIntervalMs,
      abortSignal: ctx.abortSignal,
    })
  }

  public async waitForLoad(
    input: BrowserWaitForLoadInput,
    ctx: BrowserOperationContext
  ): Promise<BrowserPageState> {
    ctx.abortSignal.throwIfAborted()
    const options = waitForLoadInput(input)
    requireOpenSite(ctx)
    const state = options.state ?? 'load'
    const waited = await ctx.browser.waitForPage({
      loadState: state,
      timeoutMs: options.timeoutMs ?? BrowserWaitLimits.defaultMs,
    })
    if (!waited.matched) {
      throw new AppError(
        'TIMEOUT',
        `等了 ${waited.elapsedMs} 毫秒，页面还没到 ${state}：现在是 ${waited.loadState}，地址 ${waited.url}。`
      )
    }
    return ctx.browser.getPageState()
  }

  public async waitForEvent(
    input: BrowserWaitForEventInput,
    ctx: BrowserOperationContext
  ): Promise<BrowserPendingEventSummary> {
    ctx.abortSignal.throwIfAborted()
    const options = waitForEventInput(input)
    requireOpenSite(ctx)
    return waitForPendingEvent({
      kind: options.kind ?? 'download',
      timeoutMs: options.timeoutMs ?? BrowserPendingEventLimits.defaultWaitMs,
      abortSignal: ctx.abortSignal,
      listPendingEvents: () => ctx.browser.listPendingEvents(),
    })
  }

  public async handleDialog(
    input: BrowserDialogInput,
    ctx: BrowserOperationContext
  ): Promise<BrowserHandleDialogResult> {
    ctx.abortSignal.throwIfAborted()
    const options = dialogInput(input)
    requireOpenSite(ctx)
    return ctx.browser.handleDialog(options)
  }

  public async handleDownload(
    input: BrowserDownloadDecisionInput,
    ctx: BrowserOperationContext
  ): Promise<BrowserHandleDownloadResult> {
    ctx.abortSignal.throwIfAborted()
    const options = downloadDecisionInput(input)
    requireOpenSite(ctx)
    return ctx.browser.handleDownload({
      eventId: options.eventId,
      action: options.cancel ? 'cancel' : 'accept',
      savePath: options.savePath,
    })
  }

  public async handlePermission(
    input: BrowserPermissionInput,
    ctx: BrowserOperationContext
  ): Promise<BrowserHandlePermissionResult> {
    ctx.abortSignal.throwIfAborted()
    const options = permissionInput(input)
    requireOpenSite(ctx)
    return ctx.browser.handlePermission(options)
  }

  public async download(
    input: BrowserDownloadInput,
    ctx: BrowserOperationContext
  ): Promise<BrowserFetchResourceResult> {
    ctx.abortSignal.throwIfAborted()
    const options = downloadInput(input)
    requireOpenSite(ctx)
    return ctx.browser.fetchResource(options)
  }

  public async savePdf(
    input: BrowserSavePdfInput,
    ctx: BrowserOperationContext
  ): Promise<BrowserExportPagePdfResult> {
    ctx.abortSignal.throwIfAborted()
    const { path } = savePdfInput(input)
    requireOpenSite(ctx)
    return ctx.browser.exportPagePdf({ savePath: path })
  }
}

/** 整个进程只有一份的浏览器操作；空间把它挂在代码面的 `browser` 命名空间上。 */
export const browserOperations: BrowserOperationsApi = new BrowserOperations()
