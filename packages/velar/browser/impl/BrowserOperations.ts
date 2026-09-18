/**
 * 浏览器能力（`velar:browser`）的操作：`BrowserOperations` 与整个进程唯一的 `browserOperations`。接口 `BrowserOperationsApi` 在本文件的类上方。
 * 一份实现挂在哪个空间都一样，空间之间的差别全在调用上下文里的端口 `BrowserSpacePort`（已经绑好会话与站点）上。
 */

import { isFalse } from '@velaros-ai/core'

import {
  BrowserEvaluateLimits,
  BrowserExtractLimits,
  BrowserInspectLimits,
  BrowserPageDataLimits,
} from '../contract/constants.js'
import type { BrowserOperationContext } from '../contract/requires.js'
import type {
  BrowserActed,
  BrowserCheckInput,
  BrowserClickAtInput,
  BrowserClickCoordinatesResult,
  BrowserClickInput,
  BrowserContent,
  BrowserContentInput,
  BrowserDialogInput,
  BrowserDownloadDecisionInput,
  BrowserDownloadInput,
  BrowserDragInput,
  BrowserDragResult,
  BrowserElementQueryResult,
  BrowserEvaluateInput,
  BrowserEvaluateScriptResult,
  BrowserExportPagePdfResult,
  BrowserFetchResourceResult,
  BrowserFillInput,
  BrowserGotoInput,
  BrowserHandleDialogResult,
  BrowserHandleDownloadResult,
  BrowserHandlePermissionResult,
  BrowserInspectInput,
  BrowserList,
  BrowserListInput,
  BrowserListMediaSourcesResult,
  BrowserMediaInput,
  BrowserMoveMouseResult,
  BrowserOpened,
  BrowserOpenInput,
  BrowserPageInspection,
  BrowserPageNavigationResult,
  BrowserPageScrollResult,
  BrowserPageTargetsResult,
  BrowserPageWaitResult,
  BrowserPageWindowState,
  BrowserPaginated,
  BrowserPaginateInput,
  BrowserPendingEventsResult,
  BrowserPendingEventWaitResult,
  BrowserPermissionInput,
  BrowserPointInput,
  BrowserPressInput,
  BrowserPressKeyResult,
  BrowserQueryInput,
  BrowserSavePdfInput,
  BrowserScreenshot,
  BrowserScreenshotInput,
  BrowserScrollInput,
  BrowserSelectInput,
  BrowserState,
  BrowserSwitchPageTargetResult,
  BrowserSwitchTabInput,
  BrowserTable,
  BrowserTableInput,
  BrowserTargetInput,
  BrowserTypeInput,
  BrowserTypeTextResult,
  BrowserUploadFileResult,
  BrowserUploadInput,
  BrowserWaitForEventInput,
  BrowserWaitForFunctionInput,
  BrowserWaitForLoadInput,
  BrowserWaitForSelectorInput,
  BrowserWaitForSelectorResult,
  BrowserWaitForTextInput,
  BrowserWaitForUrlInput,
  BrowserWaitInput,
} from '../types/browser.js'
import {
  checkInput,
  clickAtInput,
  clickInput,
  contentInput,
  dialogInput,
  downloadDecisionInput,
  downloadInput,
  dragInput,
  evaluateInput,
  fillInput,
  gotoInput,
  inspectInput,
  listInput,
  mediaInput,
  openInput,
  paginateInput,
  permissionInput,
  pointInput,
  pressInput,
  queryInput,
  savePdfInput,
  screenshotInput,
  scrollInput,
  selectInput,
  switchTabInput,
  tableInput,
  targetInput,
  typeInput,
  uploadInput,
  waitForEventInput,
  waitForFunctionInput,
  waitForLoadInput,
  waitForSelectorInput,
  waitForTextInput,
  waitForUrlInput,
  waitInput,
} from '../utils/input.js'
import { waitForPendingEvent } from '../utils/pending-events.js'
import { buildModelScreenshotOptions, projectScreenshot } from '../utils/screenshot-options.js'
import { requireOpenSite } from '../utils/site.js'
import { toElementTarget } from '../utils/target.js'
import { performTargetActionWithRecovery } from '../utils/target-recovery.js'

import type { BrowserExtractionApi } from './BrowserExtraction.js'
import { browserExtraction } from './BrowserExtraction.js'

/**
 * @AgentView
 * 浏览器：打开网站、看页面、按元素或坐标动手、等页面到位、处理弹窗下载与权限、把表格列表正文取出来、下载与导出。
 * 先 open 进站点，其余要页面的操作没进站点时抛 BROWSER_SITE_NOT_OPEN。页面是异步的：动完用 waitFor 那几个等到位再读，别靠重试。
 * 元素写法：inspect、标注截图给的 ref（如 @e3:g2，原样传回；新的一次 inspect 或标注截图之后旧 ref 作废），或 CSS selector，或结果里的 target。
 * 站点工作区是这个网站的私有目录：截图、下载、PDF 都落在那里，路径一律相对它，出不去。
 * 控制台、网络、存储、性能、录屏、页面条件与用户脚本在 velar:devtools。
 */
export interface BrowserOperationsApi {
  /** @AgentView 打开一个网站并进入它的站点（换网站就再 open 一次，各站点的工作区互不相通）。 */
  open(input: BrowserOpenInput, ctx: BrowserOperationContext): Promise<BrowserOpened>
  /** @AgentView 退出站点：之后要页面的操作都要先 open；站点工作区里的文件留着。 */
  leave(ctx: BrowserOperationContext): Promise<void>
  /** @AgentView 看现在进没进站点、在哪一页（地址、标题、加载状态、最近一次导航错误）；没进站点时也能调。 */
  state(ctx: BrowserOperationContext): Promise<BrowserState>
  /** @AgentView 把受控页面显示出来给用户看，不执行任何脚本。 */
  show(ctx: BrowserOperationContext): Promise<BrowserPageWindowState>
  /** @AgentView 列出标签页：内嵌页面只有当前这一页，外部浏览器列出它的全部标签页。 */
  tabs(ctx: BrowserOperationContext): Promise<BrowserPageTargetsResult>
  /** @AgentView 把之后的操作切到外部浏览器的另一个标签页（不关闭任何窗口）。 */
  switchTab(input: BrowserSwitchTabInput, ctx: BrowserOperationContext): Promise<BrowserSwitchPageTargetResult>
  /** @AgentView 看页面：正文、标题结构、链接、可交互元素与表单字段（元素带 target，可以直接交给 click 这类操作）。 */
  inspect(input: BrowserInspectInput, ctx: BrowserOperationContext): Promise<BrowserPageInspection>
  /** @AgentView 按 CSS selector 找元素，读文字、属性、值与可见性；列表、表格、组件读法都走它。 */
  query(input: BrowserQueryInput, ctx: BrowserOperationContext): Promise<BrowserElementQueryResult>
  /** @AgentView 截图：图交给你看，返回值是落盘位置、坐标换算与标注说明。能结构化读的（表格、列表、文字）别靠截图。 */
  screenshot(input: BrowserScreenshotInput, ctx: BrowserOperationContext): Promise<BrowserScreenshot>
  /** @AgentView 在页面里跑一段 JavaScript，读专门操作覆盖不到的状态或调试页面。 */
  evaluate(input: BrowserEvaluateInput, ctx: BrowserOperationContext): Promise<BrowserEvaluateScriptResult>
  /** @AgentView 列出页面上的图片、视频、音频地址；fetchable 为真的可以直接交给 download。 */
  media(input: BrowserMediaInput, ctx: BrowserOperationContext): Promise<BrowserListMediaSourcesResult>
  /** @AgentView 点一个元素；没找到时如实回 matched 为假与原因，只在唯一确定的元素上改用坐标补点。 */
  click(input: BrowserClickInput, ctx: BrowserOperationContext): Promise<BrowserActed>
  /** @AgentView 往输入框或可编辑区域写入文字。 */
  fill(input: BrowserFillInput, ctx: BrowserOperationContext): Promise<BrowserActed>
  /** @AgentView 选原生 select 的选项（自定义下拉框先 click 打开，再重新 inspect 找选项）。 */
  select(input: BrowserSelectInput, ctx: BrowserOperationContext): Promise<BrowserActed>
  /** @AgentView 勾选或取消勾选复选框、单选项。 */
  check(input: BrowserCheckInput, ctx: BrowserOperationContext): Promise<BrowserActed>
  /** @AgentView 把鼠标移到元素中心（悬停出菜单、提示）。 */
  hover(input: BrowserTargetInput, ctx: BrowserOperationContext): Promise<BrowserActed>
  /** @AgentView 聚焦一个元素（之后 type、press 落在它上面）。 */
  focus(input: BrowserTargetInput, ctx: BrowserOperationContext): Promise<BrowserActed>
  /** @AgentView 清空输入框或可编辑区域。 */
  clear(input: BrowserTargetInput, ctx: BrowserOperationContext): Promise<BrowserActed>
  /** @AgentView 选中输入框或可编辑区域里的全部文字。 */
  selectText(input: BrowserTargetInput, ctx: BrowserOperationContext): Promise<BrowserActed>
  /** @AgentView 把元素滚到视口中间。 */
  scrollIntoView(input: BrowserTargetInput, ctx: BrowserOperationContext): Promise<BrowserActed>
  /** @AgentView 在当前站点里跳到一个网址（换网站用 open）。 */
  goto(input: BrowserGotoInput, ctx: BrowserOperationContext): Promise<BrowserPageNavigationResult>
  /** @AgentView 后退。 */
  back(ctx: BrowserOperationContext): Promise<BrowserPageNavigationResult>
  /** @AgentView 前进。 */
  forward(ctx: BrowserOperationContext): Promise<BrowserPageNavigationResult>
  /** @AgentView 刷新当前页。 */
  reload(ctx: BrowserOperationContext): Promise<BrowserPageNavigationResult>
  /** @AgentView 滚动页面（触发懒加载、看下面的内容）。 */
  scroll(input: BrowserScrollInput, ctx: BrowserOperationContext): Promise<BrowserPageScrollResult>
  /** @AgentView 在当前焦点处输入文字。 */
  type(input: BrowserTypeInput, ctx: BrowserOperationContext): Promise<BrowserTypeTextResult>
  /** @AgentView 按一个键或组合键（提交表单按 Enter）。 */
  press(input: BrowserPressInput, ctx: BrowserOperationContext): Promise<BrowserPressKeyResult>
  /** @AgentView 把鼠标移到视口里的一个点。 */
  mouseMove(input: BrowserPointInput, ctx: BrowserOperationContext): Promise<BrowserMoveMouseResult>
  /** @AgentView 按视口坐标点一下：定位不到元素时的兜底，坐标取自截图（按 image.coordinateMap 换算）。 */
  clickAt(input: BrowserClickAtInput, ctx: BrowserOperationContext): Promise<BrowserClickCoordinatesResult>
  /** @AgentView 把一个元素拖到另一个元素上。 */
  drag(input: BrowserDragInput, ctx: BrowserOperationContext): Promise<BrowserDragResult>
  /** @AgentView 给 file input 选一个站点工作区里的文件。 */
  upload(input: BrowserUploadInput, ctx: BrowserOperationContext): Promise<BrowserUploadFileResult>
  /** @AgentView 等一个 selector 出现、可见、隐藏或消失。 */
  waitForSelector(input: BrowserWaitForSelectorInput, ctx: BrowserOperationContext): Promise<BrowserWaitForSelectorResult>
  /** @AgentView 等页面正文里出现一段文字。 */
  waitForText(input: BrowserWaitForTextInput, ctx: BrowserOperationContext): Promise<BrowserPageWaitResult>
  /** @AgentView 等地址变成某个样子（跳转、登录回调）。 */
  waitForUrl(input: BrowserWaitForUrlInput, ctx: BrowserOperationContext): Promise<BrowserPageWaitResult>
  /** @AgentView 等页面里一个表达式变成真。 */
  waitForFunction(input: BrowserWaitForFunctionInput, ctx: BrowserOperationContext): Promise<BrowserPageWaitResult>
  /** @AgentView 等页面加载到某个状态（networkidle 是网络空闲）。 */
  waitForLoad(input: BrowserWaitForLoadInput, ctx: BrowserOperationContext): Promise<BrowserPageWaitResult>
  /** @AgentView 原地停一会儿。 */
  wait(input: BrowserWaitInput, ctx: BrowserOperationContext): Promise<BrowserPageWaitResult>
  /** @AgentView 列出挂着等处理的弹窗、下载与权限请求；没人处理的会在超时后按缺省结算（弹窗取消、下载取消、权限拒绝）。 */
  events(ctx: BrowserOperationContext): Promise<BrowserPendingEventsResult>
  /** @AgentView 等一个挂起事件出现（点了下载按钮之后等下载事件，再 handleDownload）。 */
  waitForEvent(input: BrowserWaitForEventInput, ctx: BrowserOperationContext): Promise<BrowserPendingEventWaitResult>
  /** @AgentView 处理 JS 弹窗（alert、confirm、prompt）。 */
  handleDialog(input: BrowserDialogInput, ctx: BrowserOperationContext): Promise<BrowserHandleDialogResult>
  /** @AgentView 保存或取消一次下载。 */
  handleDownload(input: BrowserDownloadDecisionInput, ctx: BrowserOperationContext): Promise<BrowserHandleDownloadResult>
  /** @AgentView 允许或拒绝一次权限请求。 */
  handlePermission(input: BrowserPermissionInput, ctx: BrowserOperationContext): Promise<BrowserHandlePermissionResult>
  /** @AgentView 把页面上的一张表取成表头加各行。 */
  table(input: BrowserTableInput, ctx: BrowserOperationContext): Promise<BrowserTable>
  /** @AgentView 把重复出现的条目（搜索结果、卡片）取成列表：标题、链接、摘要。 */
  list(input: BrowserListInput, ctx: BrowserOperationContext): Promise<BrowserList>
  /** @AgentView 翻页收集列表（会真的点下一页）。 */
  paginate(input: BrowserPaginateInput, ctx: BrowserOperationContext): Promise<BrowserPaginated>
  /** @AgentView 取页面正文（缺省 Markdown）。 */
  content(input: BrowserContentInput, ctx: BrowserOperationContext): Promise<BrowserContent>
  /** @AgentView 带着当前页面的登录态下载一个资源到站点工作区。 */
  download(input: BrowserDownloadInput, ctx: BrowserOperationContext): Promise<BrowserFetchResourceResult>
  /** @AgentView 把当前页面导出成 PDF。 */
  savePdf(input: BrowserSavePdfInput, ctx: BrowserOperationContext): Promise<BrowserExportPagePdfResult>
}

/**
 * 顺序是固定的：先查取消、再核对入参、再确认进了站点、最后经端口做事——入参错了或没进站点，端口上碰页面的方法一次都不调。
 * 整个进程共用一份，无状态。
 */
export class BrowserOperations implements BrowserOperationsApi {
  constructor(private readonly extraction: BrowserExtractionApi) {}

  public async open(input: BrowserOpenInput, ctx: BrowserOperationContext): Promise<BrowserOpened> {
    ctx.abortSignal.throwIfAborted()
    const { url } = openInput(input)
    const site = await ctx.browser.enterSite(url)
    return { site, page: await ctx.browser.getPageState() }
  }

  public async leave(ctx: BrowserOperationContext): Promise<void> {
    ctx.abortSignal.throwIfAborted()
    await ctx.browser.leaveSite()
  }

  public async state(ctx: BrowserOperationContext): Promise<BrowserState> {
    ctx.abortSignal.throwIfAborted()
    // 没进站点时不报错：程序常拿它探测「现在能不能用浏览器」。
    const site = ctx.browser.isActive() ? ctx.browser.getContext() : null
    if (!site) return { active: false }
    return { active: true, site, page: await ctx.browser.getPageState() }
  }

  public async show(ctx: BrowserOperationContext): Promise<BrowserPageWindowState> {
    ctx.abortSignal.throwIfAborted()
    requireOpenSite(ctx)
    return ctx.browser.showPage()
  }

  public async tabs(ctx: BrowserOperationContext): Promise<BrowserPageTargetsResult> {
    ctx.abortSignal.throwIfAborted()
    requireOpenSite(ctx)
    return ctx.browser.listPageTargets()
  }

  public async switchTab(input: BrowserSwitchTabInput, ctx: BrowserOperationContext): Promise<BrowserSwitchPageTargetResult> {
    ctx.abortSignal.throwIfAborted()
    const { targetId } = switchTabInput(input)
    requireOpenSite(ctx)
    return ctx.browser.switchPageTarget({ targetId })
  }

  public async inspect(input: BrowserInspectInput, ctx: BrowserOperationContext): Promise<BrowserPageInspection> {
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

  public async query(input: BrowserQueryInput, ctx: BrowserOperationContext): Promise<BrowserElementQueryResult> {
    ctx.abortSignal.throwIfAborted()
    const options = queryInput(input)
    requireOpenSite(ctx)
    return ctx.browser.queryElements({
      selector: options.selector,
      attributes: options.attributes,
      includeHtml: options.includeHtml,
      limit: options.limit ?? BrowserInspectLimits.queryElements,
      maxTextChars: options.maxTextChars ?? BrowserInspectLimits.queryTextChars,
      maxHtmlChars: options.maxHtmlChars ?? BrowserInspectLimits.queryHtmlChars,
    })
  }

  public async screenshot(input: BrowserScreenshotInput, ctx: BrowserOperationContext): Promise<BrowserScreenshot> {
    ctx.abortSignal.throwIfAborted()
    const options = screenshotInput(input)
    requireOpenSite(ctx)
    const attach = ctx.attachImage
    const artifact = await ctx.browser.captureScreenshot(buildModelScreenshotOptions(options, !!attach))
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

  public async evaluate(input: BrowserEvaluateInput, ctx: BrowserOperationContext): Promise<BrowserEvaluateScriptResult> {
    ctx.abortSignal.throwIfAborted()
    const options = evaluateInput(input)
    requireOpenSite(ctx)
    return ctx.browser.evaluateScript({
      script: options.script,
      mode: options.mode,
      timeoutMs: options.timeoutMs,
      maxResultChars: BrowserEvaluateLimits.resultChars,
    })
  }

  public async media(input: BrowserMediaInput, ctx: BrowserOperationContext): Promise<BrowserListMediaSourcesResult> {
    ctx.abortSignal.throwIfAborted()
    const options = mediaInput(input)
    requireOpenSite(ctx)
    return ctx.browser.listMediaSources({
      limit: options.limit ?? BrowserPageDataLimits.mediaSources,
      includeDataUrls: options.includeDataUrls,
      includeBlobUrls: options.includeBlobUrls,
    })
  }

  public async click(input: BrowserClickInput, ctx: BrowserOperationContext): Promise<BrowserActed> {
    ctx.abortSignal.throwIfAborted()
    const options = clickInput(input)
    requireOpenSite(ctx)
    return performTargetActionWithRecovery({ action: 'click', target: toElementTarget(options.target), waitForNavigation: options.waitForNavigation }, ctx)
  }

  public async fill(input: BrowserFillInput, ctx: BrowserOperationContext): Promise<BrowserActed> {
    ctx.abortSignal.throwIfAborted()
    const options = fillInput(input)
    requireOpenSite(ctx)
    return performTargetActionWithRecovery({ action: 'fill', target: toElementTarget(options.target), value: options.value }, ctx)
  }

  public async select(input: BrowserSelectInput, ctx: BrowserOperationContext): Promise<BrowserActed> {
    ctx.abortSignal.throwIfAborted()
    const options = selectInput(input)
    requireOpenSite(ctx)
    return performTargetActionWithRecovery({ action: 'select', target: toElementTarget(options.target), value: options.value }, ctx)
  }

  public async check(input: BrowserCheckInput, ctx: BrowserOperationContext): Promise<BrowserActed> {
    ctx.abortSignal.throwIfAborted()
    const options = checkInput(input)
    requireOpenSite(ctx)
    return performTargetActionWithRecovery({ action: isFalse(options.checked) ? 'uncheck' : 'check', target: toElementTarget(options.target) }, ctx)
  }

  public async hover(input: BrowserTargetInput, ctx: BrowserOperationContext): Promise<BrowserActed> {
    ctx.abortSignal.throwIfAborted()
    const { target } = targetInput(input, 'hover')
    requireOpenSite(ctx)
    return performTargetActionWithRecovery({ action: 'hover', target: toElementTarget(target) }, ctx)
  }

  public async focus(input: BrowserTargetInput, ctx: BrowserOperationContext): Promise<BrowserActed> {
    ctx.abortSignal.throwIfAborted()
    const { target } = targetInput(input, 'focus')
    requireOpenSite(ctx)
    return performTargetActionWithRecovery({ action: 'focus', target: toElementTarget(target) }, ctx)
  }

  public async clear(input: BrowserTargetInput, ctx: BrowserOperationContext): Promise<BrowserActed> {
    ctx.abortSignal.throwIfAborted()
    const { target } = targetInput(input, 'clear')
    requireOpenSite(ctx)
    return performTargetActionWithRecovery({ action: 'clear', target: toElementTarget(target) }, ctx)
  }

  public async selectText(input: BrowserTargetInput, ctx: BrowserOperationContext): Promise<BrowserActed> {
    ctx.abortSignal.throwIfAborted()
    const { target } = targetInput(input, 'selectText')
    requireOpenSite(ctx)
    return performTargetActionWithRecovery({ action: 'select_all', target: toElementTarget(target) }, ctx)
  }

  public async scrollIntoView(input: BrowserTargetInput, ctx: BrowserOperationContext): Promise<BrowserActed> {
    ctx.abortSignal.throwIfAborted()
    const { target } = targetInput(input, 'scrollIntoView')
    requireOpenSite(ctx)
    return performTargetActionWithRecovery({ action: 'scroll_into_view', target: toElementTarget(target) }, ctx)
  }

  public async goto(input: BrowserGotoInput, ctx: BrowserOperationContext): Promise<BrowserPageNavigationResult> {
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

  public async scroll(input: BrowserScrollInput, ctx: BrowserOperationContext): Promise<BrowserPageScrollResult> {
    ctx.abortSignal.throwIfAborted()
    const options = scrollInput(input)
    requireOpenSite(ctx)
    return ctx.browser.scrollPage(options)
  }

  public async type(input: BrowserTypeInput, ctx: BrowserOperationContext): Promise<BrowserTypeTextResult> {
    ctx.abortSignal.throwIfAborted()
    const { text } = typeInput(input)
    requireOpenSite(ctx)
    return ctx.browser.typeText({ text })
  }

  public async press(input: BrowserPressInput, ctx: BrowserOperationContext): Promise<BrowserPressKeyResult> {
    ctx.abortSignal.throwIfAborted()
    const options = pressInput(input)
    requireOpenSite(ctx)
    return ctx.browser.pressKey(options)
  }

  public async mouseMove(input: BrowserPointInput, ctx: BrowserOperationContext): Promise<BrowserMoveMouseResult> {
    ctx.abortSignal.throwIfAborted()
    const point = pointInput(input)
    requireOpenSite(ctx)
    return ctx.browser.moveMouse(point)
  }

  public async clickAt(input: BrowserClickAtInput, ctx: BrowserOperationContext): Promise<BrowserClickCoordinatesResult> {
    ctx.abortSignal.throwIfAborted()
    const options = clickAtInput(input)
    requireOpenSite(ctx)
    return ctx.browser.clickCoordinates(options)
  }

  public async drag(input: BrowserDragInput, ctx: BrowserOperationContext): Promise<BrowserDragResult> {
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

  public async upload(input: BrowserUploadInput, ctx: BrowserOperationContext): Promise<BrowserUploadFileResult> {
    ctx.abortSignal.throwIfAborted()
    const options = uploadInput(input)
    requireOpenSite(ctx)
    return ctx.browser.uploadFile({ target: toElementTarget(options.target), filePath: options.filePath })
  }

  public async waitForSelector(input: BrowserWaitForSelectorInput, ctx: BrowserOperationContext): Promise<BrowserWaitForSelectorResult> {
    ctx.abortSignal.throwIfAborted()
    const options = waitForSelectorInput(input)
    requireOpenSite(ctx)
    return ctx.browser.waitForSelector({ selector: options.selector, state: options.state ?? 'visible', timeoutMs: options.timeoutMs })
  }

  public async waitForText(input: BrowserWaitForTextInput, ctx: BrowserOperationContext): Promise<BrowserPageWaitResult> {
    ctx.abortSignal.throwIfAborted()
    const options = waitForTextInput(input)
    requireOpenSite(ctx)
    return ctx.browser.waitForPage({ text: options.text, timeoutMs: options.timeoutMs })
  }

  public async waitForUrl(input: BrowserWaitForUrlInput, ctx: BrowserOperationContext): Promise<BrowserPageWaitResult> {
    ctx.abortSignal.throwIfAborted()
    const options = waitForUrlInput(input)
    requireOpenSite(ctx)
    return ctx.browser.waitForPage({ urlPattern: options.url, timeoutMs: options.timeoutMs })
  }

  public async waitForFunction(input: BrowserWaitForFunctionInput, ctx: BrowserOperationContext): Promise<BrowserPageWaitResult> {
    ctx.abortSignal.throwIfAborted()
    const options = waitForFunctionInput(input)
    requireOpenSite(ctx)
    return ctx.browser.waitForPage({ functionExpression: options.expression, timeoutMs: options.timeoutMs })
  }

  public async waitForLoad(input: BrowserWaitForLoadInput, ctx: BrowserOperationContext): Promise<BrowserPageWaitResult> {
    ctx.abortSignal.throwIfAborted()
    const options = waitForLoadInput(input)
    requireOpenSite(ctx)
    return ctx.browser.waitForPage({ loadState: options.state ?? 'load', timeoutMs: options.timeoutMs })
  }

  public async wait(input: BrowserWaitInput, ctx: BrowserOperationContext): Promise<BrowserPageWaitResult> {
    ctx.abortSignal.throwIfAborted()
    const { ms } = waitInput(input)
    requireOpenSite(ctx)
    return ctx.browser.waitForPage({ durationMs: ms })
  }

  public async events(ctx: BrowserOperationContext): Promise<BrowserPendingEventsResult> {
    ctx.abortSignal.throwIfAborted()
    requireOpenSite(ctx)
    return ctx.browser.listPendingEvents()
  }

  public async waitForEvent(input: BrowserWaitForEventInput, ctx: BrowserOperationContext): Promise<BrowserPendingEventWaitResult> {
    ctx.abortSignal.throwIfAborted()
    const options = waitForEventInput(input)
    requireOpenSite(ctx)
    return waitForPendingEvent({
      kind: options.kind,
      timeoutMs: options.timeoutMs,
      abortSignal: ctx.abortSignal,
      listPendingEvents: () => ctx.browser.listPendingEvents(),
    })
  }

  public async handleDialog(input: BrowserDialogInput, ctx: BrowserOperationContext): Promise<BrowserHandleDialogResult> {
    ctx.abortSignal.throwIfAborted()
    const options = dialogInput(input)
    requireOpenSite(ctx)
    return ctx.browser.handleDialog(options)
  }

  public async handleDownload(input: BrowserDownloadDecisionInput, ctx: BrowserOperationContext): Promise<BrowserHandleDownloadResult> {
    ctx.abortSignal.throwIfAborted()
    const options = downloadDecisionInput(input)
    requireOpenSite(ctx)
    return ctx.browser.handleDownload({
      eventId: options.eventId,
      action: options.cancel ? 'cancel' : 'accept',
      savePath: options.savePath,
    })
  }

  public async handlePermission(input: BrowserPermissionInput, ctx: BrowserOperationContext): Promise<BrowserHandlePermissionResult> {
    ctx.abortSignal.throwIfAborted()
    const options = permissionInput(input)
    requireOpenSite(ctx)
    return ctx.browser.handlePermission(options)
  }

  public async table(input: BrowserTableInput, ctx: BrowserOperationContext): Promise<BrowserTable> {
    ctx.abortSignal.throwIfAborted()
    const options = tableInput(input)
    requireOpenSite(ctx)
    return this.extraction.table(ctx, {
      selector: options.selector,
      tableIndex: options.tableIndex ?? BrowserExtractLimits.defaultTableIndex,
      maxRows: options.maxRows ?? BrowserExtractLimits.tableRows,
    })
  }

  public async list(input: BrowserListInput, ctx: BrowserOperationContext): Promise<BrowserList> {
    ctx.abortSignal.throwIfAborted()
    const options = listInput(input)
    requireOpenSite(ctx)
    return this.extraction.list(ctx, { selector: options.selector, maxItems: options.maxItems ?? BrowserExtractLimits.listItems })
  }

  public async paginate(input: BrowserPaginateInput, ctx: BrowserOperationContext): Promise<BrowserPaginated> {
    ctx.abortSignal.throwIfAborted()
    const options = paginateInput(input)
    requireOpenSite(ctx)
    return this.extraction.paginate(ctx, {
      selector: options.selector,
      maxPages: options.maxPages ?? BrowserExtractLimits.defaultPaginatePages,
      maxItemsPerPage: options.maxItemsPerPage ?? BrowserExtractLimits.paginateItemsPerPage,
      nextPageSelector: options.nextPageSelector,
    })
  }

  public async content(input: BrowserContentInput, ctx: BrowserOperationContext): Promise<BrowserContent> {
    ctx.abortSignal.throwIfAborted()
    const options = contentInput(input)
    requireOpenSite(ctx)
    return this.extraction.content(ctx, {
      format: options.format ?? 'markdown',
      selector: options.selector,
      ignoreSelectors: options.ignoreSelectors,
      maxChars: options.maxChars ?? BrowserExtractLimits.contentChars,
    })
  }

  public async download(input: BrowserDownloadInput, ctx: BrowserOperationContext): Promise<BrowserFetchResourceResult> {
    ctx.abortSignal.throwIfAborted()
    const options = downloadInput(input)
    requireOpenSite(ctx)
    return ctx.browser.fetchResource(options)
  }

  public async savePdf(input: BrowserSavePdfInput, ctx: BrowserOperationContext): Promise<BrowserExportPagePdfResult> {
    ctx.abortSignal.throwIfAborted()
    const { path } = savePdfInput(input)
    requireOpenSite(ctx)
    return ctx.browser.exportPagePdf({ savePath: path })
  }
}

/** 整个进程只有一份的浏览器操作；空间把它挂在代码面的 `browser` 命名空间上。 */
export const browserOperations: BrowserOperationsApi = new BrowserOperations(browserExtraction)
