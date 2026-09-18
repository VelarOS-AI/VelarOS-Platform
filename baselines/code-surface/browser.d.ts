declare module 'velar:browser' {
  /**
   * 浏览器：打开网站、看页面、按元素或坐标动手、等页面到位、处理弹窗下载与权限、把表格列表正文取出来、下载与导出。
   * 先 open 进站点，其余要页面的操作没进站点时抛 BROWSER_SITE_NOT_OPEN。页面是异步的：动完用 waitFor 那几个等到位再读，别靠重试。
   * 元素写法：inspect、标注截图给的 ref（如 @e3:g2，原样传回；新的一次 inspect 或标注截图之后旧 ref 作废），或 CSS selector，或结果里的 target。
   * 站点工作区是这个网站的私有目录：截图、下载、PDF 都落在那里，路径一律相对它，出不去。
   * 控制台、网络、存储、性能、录屏、页面条件与用户脚本在 velar:devtools。
   */

  /** 打开一个网站并进入它的站点：url 最多 2048 个字符，不带协议按 https:// 补全，localhost 也行。 */
  interface BrowserOpenInput {
    url: string
  }

  /** 进站的结果：站点工作区在哪（workspaceRoot），以及落地后的页面状态。 */
  interface BrowserOpened {
    site: BrowserSiteContext
    page: BrowserPageState
  }

  /** 当前状态：没进站点时 active 为假、其余字段都没有；进了站点时带着站点与页面状态。 */
  interface BrowserState {
    active: boolean
    site?: BrowserSiteContext
    page?: BrowserPageState
  }

  /** 受控页面的窗口状态：visible 是用户看不看得见，driverKind 是内嵌页面（webview）还是外部浏览器（external），以及地址、标题、能不能前进后退。 */
  interface BrowserPageWindowState {
    active: boolean
    visible: boolean
    driverKind: 'webview' | 'external'
    url: string | null
    title: string | null
    canGoBack: boolean
    canGoForward: boolean
    /** 模型显式设置的 CSS viewport；null 表示跟随浏览器工作区可用尺寸。 */
    viewport: BrowserViewportOptions | null
  }

  /** 标签页列表：activeTargetId 是当前在操作的那一页。 */
  interface BrowserPageTargetsResult {
    driverKind: 'webview' | 'external'
    activeTargetId: string | null
    targets: BrowserPageTargetInfo[]
    capturedAt: number
  }

  /** 切到外部浏览器的另一个标签页：targetId 取自 tabs() 结果里的 targets[].id。 */
  interface BrowserSwitchTabInput {
    targetId: string
  }

  /** 切换之后：target 是现在在操作的那一页，targets 是全部标签页。 */
  interface BrowserSwitchPageTargetResult {
    driverKind: 'webview' | 'external'
    activeTargetId: string | null
    target: BrowserPageTargetInfo
    targets: BrowserPageTargetInfo[]
    url: string
    title: string | null
    capturedAt: number
  }

  /**
   * 看页面：maxTextChars 是正文最多交回多少字符（最多 100000），includeHtml 为真再带上 HTML（maxHtmlChars 最多 100000），
   * maxElements 是可交互元素最多几个（最多 400），ignoreSelectors 是先排除掉的噪音子树（导航、cookie 提示条、广告，最多 50 个 selector）。
   * 不给就取到上限。
   */
  interface BrowserInspectInput {
    maxTextChars?: number
    includeHtml?: boolean
    maxHtmlChars?: number
    maxElements?: number
    ignoreSelectors?: string[]
  }

  /**
   * 看页面的结果：text 是正文（textTruncated 为真表示被截断），html 只在 includeHtml 时有；headings、links、actions（可以点的）、formFields（表单字段）各带 target。
   * login 是登录墙的启发式检测，loginGate 只在这次停下来问过用户时出现（用户登录完之后这里已经是重读过的页面）。
   */
  interface BrowserPageInspection {
    url: string
    title: string
    metaDescription: string | null
    text: string
    textTruncated: boolean
    html?: string
    htmlTruncated?: boolean
    headings: BrowserPageHeading[]
    links: BrowserPageLink[]
    actions: BrowserPageAction[]
    formFields: BrowserPageFormField[]
    snapshot?: BrowserPageSnapshot
    /** 登录墙的启发式检测：与截图同一份判据，随看页面的脚本顺带算出，不另跑一次脚本。 */
    login?: BrowserLoginDetection
    /** 本次检查是否触发过登录墙门控；缺席 = 没触发（不是「没检测」）。 */
    loginGate?: BrowserLoginGateRecord
    capturedAt: number
  }

  /**
   * 按 CSS selector 找元素：selector 最多 1000 个字符，一层同源 iframe 里的元素写成 `iframe[name="x"] >> .inner`；
   * attributes 是额外要读的属性名（最多 20 个，每个最多 80 个字符），includeHtml 为真再带上每个元素的 HTML；
   * limit 最多几个元素（最多 100），maxTextChars、maxHtmlChars 是每个元素的文本与 HTML 最多多少字符（最多 20000、50000）。不给就取到上限。
   */
  interface BrowserQueryInput {
    selector: string
    attributes?: string[]
    includeHtml?: boolean
    limit?: number
    maxTextChars?: number
    maxHtmlChars?: number
  }

  /** query 的结果：count 是一共匹配几个，elements 是交回的那几个；selectorError 是 selector 写错时的说明。 */
  interface BrowserElementQueryResult {
    url: string
    selector: string
    selectorError: string | null
    count: number
    limit: number
    elements: BrowserQueriedElement[]
    capturedAt: number
  }

  /**
   * 截图：图交给你看，原图落进站点工作区（path 是工作区里的相对路径，最多 180 个字符，不给就按时间命名）。
   * 缺省截当前视口；fullPage 为真截整页（单边最多 32000 像素），region 只截一块（与 fullPage 同时给时以 region 为准）。
   * annotate 为真先给可交互元素画上编号（最多 120 个），legend 里给每个编号的 target，能直接交给 click 这类操作。
   * width、height 是截图前把视口设成多大（宽 320 到 3840，高 240 到 2160）。截图前缺省会等一小会儿网络空闲与页面不再变（动画、骨架屏）：
   * waitForNetworkIdle 给数字是网络空闲多少毫秒（100 到 5000），两个都可以传 false 不等；compareWithPrevious 缺省为真，diff 里说与上一张比变没变。
   */
  interface BrowserScreenshotInput {
    path?: string
    fullPage?: boolean
    region?: BrowserScreenshotRegion
    annotate?: boolean
    width?: number
    height?: number
    waitForNetworkIdle?: boolean | number
    waitForDomStable?: boolean
    compareWithPrevious?: boolean
  }

  /**
   * 截图的结果：原图落在 path（relativePath 是站点工作区里的相对路径），width、height、bytes 是原图的尺寸与大小；
   * capture 说截的是页面哪一块，image 是交给你看的那张图，legend 是 annotate 时每个编号元素的说明与 target，
   * diff 是与上一张的比较，login 是登录墙的启发式检测，loginGate 只在这次停下来问过用户时出现。
   */
  interface BrowserScreenshot {
    path: string
    relativePath: string
    width: number
    height: number
    bytes: number
    capture?: BrowserScreenshotCaptureRegion
    image?: BrowserScreenshotImage
    legend?: BrowserScreenshotElementLegendItem[]
    diff?: BrowserScreenshotDiff
    login?: BrowserLoginDetection
    loginGate?: BrowserLoginGateRecord
  }

  /**
   * 在页面里跑一段 JavaScript：script 最多 20000 个字符。mode 缺省 expression（一个表达式，交回它的值），
   * function-body 是函数体（多条语句，用 return 交回）。timeoutMs 最多 30000；结果按 JSON 取回，超过 200000 个字符时只回截断标记。
   */
  interface BrowserEvaluateInput {
    script: string
    mode?: BrowserEvaluateScriptMode
    timeoutMs?: number
  }

  /** 脚本的结果：ok 为假时 error 是页面里抛的错；result 是交回的值（按 JSON 取回），resultTruncated 为真时 result 取不全、resultText 是截断的 JSON 文本。 */
  interface BrowserEvaluateScriptResult {
    url: string
    ok: boolean
    mode: BrowserEvaluateScriptMode
    result: unknown
    /** 结果的缩进 JSON 文本，只在 resultTruncated 为真时给出（没截断时 result 就是完整内容，不再重复一份）。 */
    resultText?: string | null | undefined
    resultTruncated: boolean
    error: ({
      name: string
      message: string
      stack: string | null
    }) | null | undefined
    durationMs: number
    capturedAt: number
  }

  /** 列页面上的图片、视频、音频地址：limit 最多几条（最多 200，不给就取到上限），data: 与 blob: 地址缺省不列。 */
  interface BrowserMediaInput {
    limit?: number
    includeDataUrls?: boolean
    includeBlobUrls?: boolean
  }

  /** 页面上的媒体地址：truncated 为真表示超过上限没列全。 */
  interface BrowserListMediaSourcesResult {
    url: string
    items: BrowserMediaSourceItem[]
    truncated: boolean
    capturedAt: number
  }

  /** 点一个元素：waitForNavigation 为真时按完整的导航稳定窗口等（缺省只短暂等一下可能的跳转）。 */
  interface BrowserClickInput {
    target: BrowserTarget
    waitForNavigation?: boolean
  }

  /**
   * 按元素动手的结果：matched 为假时 failureReason 说为什么（没找到、点不动、被挡住、没有这个选项），blockedBy 是挡住它的元素；
   * effect 是动手前后页面的变化（地址、标题、正文），selectedValues、availableOptions 是 select 的结果与可选项，controlState 是动完之后控件的状态。
   * selectorRecovery 在改用坐标补点时出现，actionEffect 在点中了却没有变化时出现。
   */
  interface BrowserActed extends BrowserTargetActionResult {
    selectorRecovery?: BrowserSelectorRecovery
    actionEffect?: BrowserActionEffectHint
  }

  /** 往输入框或可编辑区域写入文字（先清空再写）：value 最多 20000 个字符。 */
  interface BrowserFillInput {
    target: BrowserTarget
    value: string
  }

  /** 选原生 select 的选项：value 按选项的值或可见文字匹配，多选给数组（最多 50 个，每个最多 1000 个字符）。 */
  interface BrowserSelectInput {
    target: BrowserTarget
    value: string | string[]
  }

  /** 勾选或取消勾选复选框、单选项：checked 缺省 true。 */
  interface BrowserCheckInput {
    target: BrowserTarget
    checked?: boolean
  }

  /** 只要一个元素的操作（悬停、聚焦、清空、选中文字、滚到视口里）。 */
  interface BrowserTargetInput {
    target: BrowserTarget
  }

  /** 跳到一个网址：url 最多 2048 个字符。 */
  interface BrowserGotoInput {
    url: string
  }

  /** 导航的结果：navigated 是真的跳了没有，url、title 是落地的页面，canGoBack、canGoForward 是还能不能后退、前进。 */
  interface BrowserPageNavigationResult {
    action: BrowserPageNavigationAction
    navigated: boolean
    url: string
    title: string | null
    canGoBack: boolean
    canGoForward: boolean
    capturedAt: number
  }

  /**
   * 滚动页面：direction 是 up、down、left、right、top、bottom（缺省 down），amount 是一次滚多少像素（最多 5000）；
   * 也可以直接给 x、y 偏移（绝对值最多 10000）。
   */
  interface BrowserScrollInput {
    direction?: BrowserPageScrollDirection
    amount?: number
    x?: number
    y?: number
  }

  /** 滚动之后的位置：scrollX、scrollY 是当前滚动位置，maxScrollX、maxScrollY 是能滚到的最远处（scrollY 等于 maxScrollY 就是到底了）。 */
  interface BrowserPageScrollResult {
    url: string
    scrollX: number
    scrollY: number
    maxScrollX: number
    maxScrollY: number
    viewportWidth: number
    viewportHeight: number
    capturedAt: number
  }

  /** 在当前焦点处输入文字（真的按键，不直接改 value）：text 最多 20000 个字符。要先点中输入框。 */
  interface BrowserTypeInput {
    text: string
  }

  /** 输入的结果：textLength 是输了几个字符。 */
  interface BrowserTypeTextResult {
    url: string
    textLength: number
    capturedAt: number
  }

  /**
   * 按一个键：key 是 Enter、Escape、Tab、ArrowDown 这类键名或一个字符（最多 80 个字符），组合键写 Control+a 或给 modifiers；
   * repeat 是连按几次（最多 50），waitForNavigation 为真时按完等可能的跳转。
   */
  interface BrowserPressInput {
    key: string
    modifiers?: BrowserKeyModifier[]
    repeat?: number
    waitForNavigation?: boolean
  }

  /** 按键的结果：key 是按的键，repeat 是按了几次。 */
  interface BrowserPressKeyResult {
    url: string
    key: string
    repeat: number
    capturedAt: number
  }

  /** 视口里的一个点（CSS 像素，0 到 10000）。 */
  interface BrowserPointInput {
    x: number
    y: number
  }

  /** 移动鼠标的结果：鼠标现在停在视口里的 x、y。 */
  interface BrowserMoveMouseResult {
    url: string
    x: number
    y: number
    capturedAt: number
  }

  /** 按视口坐标点一下（定位不到元素时的兜底）：button 缺省 left，clickCount 是连击几下（最多 5）。 */
  interface BrowserClickAtInput {
    x: number
    y: number
    button?: BrowserMouseButton
    clickCount?: number
    waitForNavigation?: boolean
  }

  /** 坐标点击的结果：点在视口里的 x、y，用的哪个键、点了几下。 */
  interface BrowserClickCoordinatesResult {
    url: string
    x: number
    y: number
    button: BrowserMouseButton
    clickCount: number
    capturedAt: number
  }

  /** 把一个元素拖到另一个元素上：steps 是拆成几步移动（最多 60）。 */
  interface BrowserDragInput {
    source: BrowserTarget
    target: BrowserTarget
    steps?: number
    waitForNavigation?: boolean
  }

  /** 拖拽的结果：matched 为假时 failureReason 说为什么；startX、startY 到 endX、endY 是拖动的路径。 */
  interface BrowserDragResult {
    url: string
    matched: boolean
    source: BrowserDragEndpointResult
    target: BrowserDragEndpointResult
    startX: number | null
    startY: number | null
    endX: number | null
    endY: number | null
    steps: number
    failureReason: BrowserDragFailureReason | null
    capturedAt: number
  }

  /** 给 file input 选文件：filePath 是站点工作区里的相对路径（出了工作区一律拒绝），最多 4096 个字符。 */
  interface BrowserUploadInput {
    target: BrowserTarget
    filePath: string
  }

  /** 上传的结果：matched 为假表示没找到那个 file input，files 是塞进去的文件。 */
  interface BrowserUploadFileResult {
    matched: boolean
    selector: string | null
    files: string[]
    capturedAt: number
  }

  /** 等一个 selector 到某个状态：state 缺省 visible，timeoutMs 最多 60000。 */
  interface BrowserWaitForSelectorInput {
    selector: string
    state?: BrowserWaitForSelectorState
    timeoutMs?: number
  }

  /** 等 selector 的结果：matched 为假表示等到超时也没到，count 是匹配几个，target 是第一个匹配的元素。 */
  interface BrowserWaitForSelectorResult {
    url: string
    selector: string
    state: BrowserWaitForSelectorState
    matched: boolean
    visible: boolean
    count: number
    elapsedMs: number
    target: BrowserElementTargetHint | null
    capturedAt: number
  }

  /** 等页面正文里出现一段文字：text 最多 5000 个字符，timeoutMs 最多 60000。 */
  interface BrowserWaitForTextInput {
    text: string
    timeoutMs?: number
  }

  /** 等页面的结果：matched 为真表示等到了，timedOut 为真表示等到超时；functionResult 是 waitForFunction 的表达式最后的值，elapsedMs 是实际等了多久。 */
  interface BrowserPageWaitResult {
    url: string
    loadState: 'loading' | 'interactive' | 'complete'
    requestedLoadState: BrowserPageWaitLoadState | null
    urlPattern: string | null
    functionExpression: string | null
    functionResult: unknown
    text: string | null
    matched: boolean
    durationMs: number
    timeoutMs: number
    elapsedMs: number
    timedOut: boolean
    capturedAt: number
  }

  /** 等地址变成某个样子：url 是完整地址或带 * 的通配（最多 2048 个字符），timeoutMs 最多 60000。 */
  interface BrowserWaitForUrlInput {
    url: string
    timeoutMs?: number
  }

  /** 等页面里一个表达式变成真：expression 最多 5000 个字符，timeoutMs 最多 60000。 */
  interface BrowserWaitForFunctionInput {
    expression: string
    timeoutMs?: number
  }

  /** 等页面加载到某个状态：state 缺省 load，timeoutMs 最多 60000。 */
  interface BrowserWaitForLoadInput {
    state?: BrowserPageWaitLoadState
    timeoutMs?: number
  }

  /** 原地停一会儿：ms 最多 60000。能等具体条件时用 waitFor 那几个。 */
  interface BrowserWaitInput {
    ms: number
  }

  /** 此刻挂着的全部事件。 */
  interface BrowserPendingEventsResult {
    pending: BrowserPendingEventSummary[]
    capturedAt: number
  }

  /** 等一个挂起事件出现：kind 缺省 download，timeoutMs 缺省 5000、最多 60000。 */
  interface BrowserWaitForEventInput {
    kind?: BrowserPendingEventKind
    timeoutMs?: number
  }

  /** 等挂起事件的结果：matched 为真时 event 是等到的那个；timedOut 为真是等到超时也没来。pending 是此刻还挂着的全部事件。 */
  interface BrowserPendingEventWaitResult {
    matched: boolean
    timedOut: boolean
    kind: BrowserPendingEventKind
    event: BrowserPendingEventSummary | null
    pending: BrowserPendingEventSummary[]
    timeoutMs: number
    elapsedMs: number
  }

  /** 处理 JS 弹窗：accept 为真是确认、为假是取消；prompt 弹窗用 promptText 填值。eventId 不给就处理最早的那个弹窗。 */
  interface BrowserDialogInput {
    eventId?: string
    accept: boolean
    promptText?: string
  }

  /** 弹窗处理的结果：handled 为真表示处理掉了。 */
  interface BrowserHandleDialogResult {
    handled: boolean
    eventId: string
    accept: boolean
    promptText: string
  }

  /** 处理一次下载：给 savePath（站点工作区里的相对路径）就保存到那里，cancel 为真就取消。eventId 不给就处理最早的那个下载。 */
  interface BrowserDownloadDecisionInput {
    eventId?: string
    savePath?: string
    cancel?: boolean
  }

  /** 下载处理的结果：savePath 是存到的位置，state 是下载的最终状态。 */
  interface BrowserHandleDownloadResult {
    handled: boolean
    eventId: string
    action: 'accept' | 'cancel'
    savePath: string | null
    state: string | null
  }

  /** 处理权限请求（定位、通知、剪贴板这类）：grant 为真是允许。eventId 不给就处理最早的那个请求。 */
  interface BrowserPermissionInput {
    eventId?: string
    grant: boolean
  }

  /** 权限请求处理的结果。 */
  interface BrowserHandlePermissionResult {
    handled: boolean
    eventId: string
    granted: boolean
  }

  /** 取一张表：selector 限定在哪张表或哪个容器里找，tableIndex 是第几张（从 0 起，最多 50，缺省 0），maxRows 最多几行（最多 2000，不给就取到上限）。 */
  interface BrowserTableInput {
    selector?: string
    tableIndex?: number
    maxRows?: number
  }

  /** 取到的表：ok 为假时 error 说为什么（比如页面上没有表格）；tables 是页面上一共几张表，headers 是表头，rows 是各行的文字。 */
  interface BrowserTable {
    ok: boolean
    error: string | null
    tables: number
    selector: string | null
    headers: string[]
    rows: string[][]
    url?: string
  }

  /** 按重复出现的容器取一组条目（搜索结果、商品卡片）：selector 是每一条的容器，maxItems 最多几条（最多 500，不给就取到上限）。 */
  interface BrowserListInput {
    selector?: string
    maxItems?: number
  }

  /** 取到的一组条目。 */
  interface BrowserList {
    ok: boolean
    selector: string | null
    items: BrowserListItem[]
    url?: string
  }

  /**
   * 翻页收集列表：每页照 list 取一遍再点下一页，翻不动、内容没变或这页是空的就停。maxPages 缺省 5、最多 20，
   * maxItemsPerPage 每页最多几条（最多 500），nextPageSelector 是下一页按钮（缺省只认 rel=next 与写明「下一页」「next」的按钮）。先确认当前在第一页。
   */
  interface BrowserPaginateInput {
    selector?: string
    maxPages?: number
    maxItemsPerPage?: number
    nextPageSelector?: string
  }

  /** 翻页收集的结果：pagesVisited 是翻了几页，items 是各页条目按顺序接起来。 */
  interface BrowserPaginated {
    pagesVisited: number
    items: BrowserListItem[]
  }

  /** 取正文：format 缺省 markdown（也可以 plain、html），selector 限定范围，ignoreSelectors 先排除的子树，maxChars 最多 200000（不给就取到上限）。 */
  interface BrowserContentInput {
    format?: BrowserPageContentFormat
    selector?: string
    ignoreSelectors?: string[]
    maxChars?: number
  }

  /** 取到的正文：ok 为假表示 selector 没找到东西；truncated 为真表示超过 maxChars 被截断。 */
  interface BrowserContent {
    ok: boolean
    format: BrowserPageContentFormat
    selector: string | null
    content: string
    truncated: boolean
    url: string
  }

  /**
   * 带着当前页面的 cookie 下载一个 http(s) 资源到站点工作区：url 与 savePath 各最多 4096 个字符，单个文件最多 52428800 字节；
   * referer 不给就用当前页面的地址。blob:、data: 与 DRM 保护的流下不了。
   */
  interface BrowserDownloadInput {
    url: string
    savePath: string
    referer?: string
  }

  /** 下载到站点工作区的文件：path 是绝对路径，relativePath 是工作区里的相对路径，mimeType、bytes、status 是类型、大小与 HTTP 状态。 */
  interface BrowserFetchResourceResult {
    url: string
    path: string
    relativePath: string
    mimeType: string | null
    bytes: number
    status: number
    capturedAt: number
  }

  /** 把当前页面导出成 PDF 落进站点工作区：path 是相对路径，不给就按时间命名。 */
  interface BrowserSavePdfInput {
    path?: string
  }

  /** 导出的 PDF：path 是绝对路径，relativePath 是工作区里的相对路径。 */
  interface BrowserExportPagePdfResult {
    url: string
    path: string
    relativePath: string
    bytes: number
    capturedAt: number
  }

  /** 站点：url 是进站时的地址，workspaceRoot 是这个站点的工作区（截图、下载、PDF 都落在这里），legacyWorkspaceRoots 是只读的旧工作区（读不到时依次往回找）。 */
  interface BrowserSiteContext {
    url: string
    /** 站点工作区根：写入的唯一落点（粒度由宿主定）。 */
    workspaceRoot: string
    /**
     * 只读的历史工作区根（换粒度前留下的资产），按新到旧排列：写只写 workspaceRoot，读不到才依次回退。
     * 不做一次性搬迁——回退读是幂等的，用户每碰一次旧资产就自然继续可用，新写入自动落到新位置。
     */
    legacyWorkspaceRoots?: readonly string[]
  }

  /**
   * 页面状态：url、title，loadState 是最近一次加载成没成（loaded、error、unknown），viewport 是用 setViewport 设过的视口（没设是 null），lastNavigationError 是最近一次导航失败的详情。
   */
  interface BrowserPageState {
    /** 当前 URL。 */
    url: string
    /** 当前 document.title。 */
    title: string
    /** 最近一次加载是否成功。 */
    loadState: 'loaded' | 'error' | 'unknown'
    /** 模型显式设置的 CSS viewport。 */
    viewport: BrowserViewportOptions | null
    /** 最近一次导航失败详情；成功或未知时为 null。 */
    lastNavigationError: {
      url: string
      errorCode: number
      errorDescription: string
      failedAt: number
    } | null | undefined
  }

  /** 视口尺寸：width、height 是 CSS 像素，mobile 为真时按手机视口处理。 */
  interface BrowserViewportOptions {
    width: number
    height: number
    /** 是否启用 Chromium 的移动设备 viewport 语义；缺省保持桌面兼容行为。 */
    mobile?: boolean
  }

  /** 一个标签页：id 交给 switchTab，active 为真表示当前在操作它。 */
  interface BrowserPageTargetInfo {
    id: string
    type: 'page'
    url: string
    title: string
    active: boolean
  }

  /** 页面上的一个标题：level 是级别（1 最高）。 */
  interface BrowserPageHeading {
    level: number
    text: string
  }

  /** 页面上的一个链接：text、href 与它的 target。 */
  interface BrowserPageLink {
    text: string
    href: string
    target: BrowserElementTargetHint | null
  }

  /** 页面上一个可以点的东西：text 是文字，role 是种类，target 交给 click。 */
  interface BrowserPageAction {
    text: string
    role: BrowserPageActionRole
    target: BrowserElementTargetHint | null
  }

  /** 页面上的一个表单字段：label 是标签，type 是输入类型，required 是必不必填，target 交给 fill、select、check。 */
  interface BrowserPageFormField {
    label: string
    type: string
    name: string | null
    placeholder: string | null
    required: boolean
    target: BrowserElementTargetHint | null
  }

  /** 页面的紧凑文本快照：lines 每行一个元素（带 ref），refCount 是一共几个 ref，truncated 为真表示被截断。 */
  interface BrowserPageSnapshot {
    mode: 'compact'
    source: BrowserPageSnapshotSource
    lines: string[]
    refCount: number
    truncated: boolean
  }

  /** 登录墙的启发式检测：requiresLogin 为真表示这页像登录、验证或支付页，confidence 是把握（0 到 1），reason 与 signals 说依据。遇到登录墙别自己填账号密码，交给用户。 */
  interface BrowserLoginDetection {
    requiresLogin: boolean
    confidence: number
    reason: string
    signals: string[]
    passwordInputs: number
    usernameInputs: number
    loginButtons: number
    loginLinks: number
    forms: number
  }

  /** 这一页停下来问过用户：approved 为真表示用户说已经登录好、可以继续，reason 是结论说明。同一站点在一次会话里只问一次。 */
  interface BrowserLoginGateRecord {
    /** 是否真的阻塞并向用户征询过；本记录存在即为 true（缺席表示从未触发门控）。 */
    prompted: boolean
    /** 用户是否表示已完成登录并继续。 */
    approved: boolean
    /** 触发门控的站点源。 */
    origin: string | null
    confidence: number
    signals: string[]
    /** 门控结论说明：批准时取检测理由，拒绝时取用户/宿主给的原因。 */
    reason: string
    resolvedAt: number
  }

  /** query 找到的一个元素：tagName、text、attributes、href、value、checked、visible，以及交给 click 这类操作的 target。 */
  interface BrowserQueriedElement {
    index: number
    tagName: string
    text: string
    textTruncated: boolean
    html?: string
    htmlTruncated?: boolean
    attributes: Record<string, string>
    href: string | null
    value: string | null
    checked: boolean | null
    visible: boolean
    target: BrowserElementTargetHint | null
  }

  /** 只截页面上的一块：给 selector（截那个元素），或者给完整的 x、y、width、height（页面 CSS 像素，含滚动，最多 20000）。 */
  type BrowserScreenshotRegion =
    | { selector: string }
    | { x: number; y: number; width: number; height: number }

  /** 截的是页面哪一块：mode 是 viewport、full-page、region；x、y、width、height 是那块在页面上的位置（CSS 像素，含滚动），clipped 为真表示超出上限被裁过。 */
  interface BrowserScreenshotCaptureRegion extends BrowserScreenshotRect {
    mode: 'viewport' | 'full-page' | 'region'
    coordinateSpace: 'page-css-px'
    documentWidth: number
    documentHeight: number
    viewport: BrowserScreenshotRect
    clipped: boolean
  }

  /** 交给你看的那张图：宽高（像素）、相对原图缩了多少（scale）、页面 CSS 坐标与图上坐标怎么换算（coordinateMap）。 */
  interface BrowserScreenshotImage {
    width: number
    height: number
    scale: number
    coordinateMap?: BrowserScreenshotModelCoordinateMap
  }

  /** 标注截图里的一个编号元素：index 是图上的编号，label、description 说它是什么，target 交给 click 这类操作。 */
  interface BrowserScreenshotElementLegendItem {
    index: number
    label: string
    role: string | null
    text: string | null
    selector: string | null
    description: string
    target: BrowserElementTargetHint
  }

  /** 与上一张截图的比较：changed 是变没变，reason 是 first-capture（第一张）、changed、unchanged，changedRatio 是变了多大比例的像素。 */
  interface BrowserScreenshotDiff {
    changed: boolean
    reason: 'first-capture' | 'changed' | 'unchanged'
    fingerprint: string
    previousFingerprint: string | null
    changedPixels?: number
    totalPixels?: number
    changedRatio?: number
  }

  /** 脚本写法：expression 是一个表达式，function-body 是函数体（用 return 交回）。 */
  type BrowserEvaluateScriptMode = 'expression' | 'function-body'

  /** 页面上的一个媒体地址：fetchable 为真的可以直接交给 download（blob:、data: 不行），tagName、attribute 说它从哪个元素的哪个属性来。 */
  interface BrowserMediaSourceItem {
    kind: BrowserMediaSourceKind
    url: string
    fetchable: boolean
    tagName: string | null
    attribute: string | null
    alt: string | null
    width: number | null
    height: number | null
  }

  /** 要操作的元素：字符串以 @ 开头当 ref，其余当 CSS selector；也可以给一份定位线索。 */
  type BrowserTarget = string | BrowserTargetHint

  /**
   * 按元素动手的结果：matched 为假时 failureReason 说为什么（not-found 没找到、not-interactable 点不动、covered 被挡住、option-not-found 没有这个选项），blockedBy 是挡住它的元素。
   * effect 是动手前后页面的变化，selectedValues、availableOptions 是 select 的结果与可选项，controlState 是动完之后控件的值或勾选状态。
   */
  interface BrowserTargetActionResult {
    action: BrowserTargetActionKind
    url: string
    matched: boolean
    selector: string | null
    text: string | null
    clickPoint?: { x: number; y: number } | null | undefined
    clickMethod?: ('dom' | 'coordinate') | null | undefined
    effect?: BrowserTargetActionEffect | null | undefined
    failureReason?: ('not-found' | 'not-interactable' | 'covered' | 'option-not-found') | null | undefined
    blockedBy?: string | null | undefined
    selectedValues?: string[] | null | undefined
    availableOptions?: Array<{ value: string; text: string; selected: boolean }> | null | undefined
    controlState?: ({
      kind: 'text' | 'checkable' | 'select' | 'contenteditable'
      value?: string | null | undefined
      valueLength?: number | null | undefined
      checked?: boolean | null | undefined
      selectedValues?: string[] | null | undefined
    }) | null | undefined
    capturedAt: number
  }

  /** 点击没命中而改用坐标补点的记录：x、y 是补点的视口坐标，screenshotPath 是找坐标用的那张标注截图。 */
  interface BrowserSelectorRecovery {
    source: 'selector-coordinate-recovery'
    screenshotPath: string
    x: number
    y: number
  }

  /** 点中了、页面却看不出变化时的提示：recommendedNextActions 是建议下一步做的（重新 inspect 或截图看看）。 */
  interface BrowserActionEffectHint {
    source: 'target-action-effect'
    reason: 'no-observable-change'
    recommendedNextActions: Array<'inspect' | 'screenshot'>
  }

  /** 导航动作：back、forward、reload、goto。 */
  type BrowserPageNavigationAction = 'back' | 'forward' | 'reload' | 'goto'

  /** 滚动方向：up、down、left、right、top（到顶）、bottom（到底）。 */
  type BrowserPageScrollDirection = 'up' | 'down' | 'left' | 'right' | 'top' | 'bottom'

  /** 组合键的修饰键：shift、control、alt、meta。 */
  type BrowserKeyModifier = 'shift' | 'control' | 'alt' | 'meta'

  /** 鼠标按键：left、middle、right。 */
  type BrowserMouseButton = 'left' | 'middle' | 'right'

  /** 拖拽的一端：matched 为假表示没找到这个元素，point 是按下或松开的位置。 */
  interface BrowserDragEndpointResult {
    matched: boolean
    selector: string | null
    text: string | null
    point: { x: number; y: number } | null
  }

  /** 拖拽没成的原因：source-not-found、target-not-found、not-interactable。 */
  type BrowserDragFailureReason = 'source-not-found' | 'target-not-found' | 'not-interactable'

  /** 等 selector 到什么状态：attached（出现在文档里）、visible（看得见）、hidden（看不见）、detached（从文档里没了）。 */
  type BrowserWaitForSelectorState = 'attached' | 'visible' | 'hidden' | 'detached'

  /**
   * 定位一个元素的线索（inspect、query、截图给的）：ref 是这次观察的引用（如 @e3:g2，新的一次 inspect 或标注截图之后作废），另有 css、role、text、name、attributes 与 frame。原样交给 click 这类操作就行。
   */
  interface BrowserElementTargetHint {
    /** 来自一次页面 snapshot/inspection 的 generation 引用，如 @e3:g2；只对原 observation 有效。 */
    ref?: string | null | undefined
    css: string | null
    role: string | null
    text: string | null
    name: string | null
    frame?: BrowserElementFrameHint | null | undefined
    attributes: Record<string, string>
  }

  /** 页面加载状态：domcontentloaded、load、networkidle（网络空闲）。 */
  type BrowserPageWaitLoadState = 'domcontentloaded' | 'load' | 'networkidle'

  /** 一个挂着等处理的事件：id 交给 handleDialog、handleDownload、handlePermission，details 里是弹窗文字、文件名、要的权限这些细节。 */
  interface BrowserPendingEventSummary {
    id: string
    kind: BrowserPendingEventKind
    createdAt: number
    details: Record<string, unknown>
  }

  /** 挂起事件的种类：dialog（JS 弹窗）、download（下载）、permission（权限请求）。 */
  type BrowserPendingEventKind = 'dialog' | 'download' | 'permission'

  /** 列表里的一条：title 是标题（没有就取正文开头），href 是链接，description 是摘要。 */
  interface BrowserListItem {
    title: string
    href: string | null
    description: string | null
  }

  /** 正文的格式：plain 纯文本、markdown、html。 */
  type BrowserPageContentFormat = 'plain' | 'markdown' | 'html'

  /** 可以点的东西是什么：button、submit、link、combobox（下拉框）、option、menuitem。 */
  type BrowserPageActionRole =
    | 'button'
    | 'submit'
    | 'link'
    | 'combobox'
    | 'option'
    | 'menuitem'

  /** 紧凑快照从哪来：dom-inspection 或 cdp-accessibility（无障碍树）。 */
  type BrowserPageSnapshotSource = 'dom-inspection' | 'cdp-accessibility'

  /** 一个矩形（页面 CSS 像素）。 */
  interface BrowserScreenshotRect {
    x: number
    y: number
    width: number
    height: number
  }

  /** 页面坐标与图上坐标怎么换算：图上的点乘 imageToPageScaleX、imageToPageScaleY 就是页面 CSS 像素；viewportRectInImage 是视口在图上的位置。clickAt 用的是视口坐标。 */
  interface BrowserScreenshotModelCoordinateMap {
    coordinateSpace: 'page-css-px'
    pageToImageScaleX: number
    pageToImageScaleY: number
    imageToPageScaleX: number
    imageToPageScaleY: number
    viewportRectInImage: BrowserScreenshotRect
    visibleViewport: BrowserScreenshotRect
  }

  /** 媒体种类：image、video、audio、other。 */
  type BrowserMediaSourceKind = 'image' | 'video' | 'audio' | 'other'

  /**
   * 定位一个元素的线索，至少给一样：ref 是 inspect、标注截图给的引用（如 @e3:g2，原样传回；新的一次 inspect 或标注截图之后旧 ref 作废），
   * css 是 CSS selector（最多 1000 个字符），text、name、role、attributes（id、data-testid 这类）按可见文字、可访问名称、角色与属性找；
   * frame 限定在哪个同源 iframe 里找（只进一层）。inspect、query 结果里的 target 可以原样传进来。
   */
  interface BrowserTargetHint {
    ref?: string | null | undefined
    css?: string | null | undefined
    role?: string | null | undefined
    text?: string | null | undefined
    name?: string | null | undefined
    frame?: {
      css?: string | null | undefined
      name?: string | null | undefined
      title?: string | null | undefined
      url?: string | null | undefined
    } | null | undefined
    attributes?: Record<string, string>
  }

  /** 按元素动手的动作：click、fill、select、clear、select_all、scroll_into_view、focus、hover、check、uncheck。 */
  type BrowserTargetActionKind =
    | 'click'
    | 'fill'
    | 'select'
    | 'clear'
    | 'select_all'
    | 'scroll_into_view'
    | 'focus'
    | 'hover'
    | 'check'
    | 'uncheck'

  /** 动手前后页面的变化：observed 为真表示量到了，urlChanged、titleChanged、textChanged 说哪里变了。都没变时多半没点中想要的东西，重新 inspect 看看。 */
  interface BrowserTargetActionEffect {
    observed: boolean
    urlChanged: boolean
    titleChanged: boolean
    textChanged: boolean
    textDiff?: BrowserTargetActionTextDiff | null | undefined
    before: BrowserTargetActionEffectSnapshot
    after: BrowserTargetActionEffectSnapshot
  }

  /** 元素所在的同源 iframe：css、name、title、url 用来找到那个 iframe。 */
  interface BrowserElementFrameHint {
    css: string | null
    name: string | null
    title: string | null
    url: string | null
  }

  /** 动手前后正文的差别：多了几行、少了几行、没变几行。 */
  interface BrowserTargetActionTextDiff {
    changed: boolean
    additions: number
    removals: number
    unchanged: number
    truncated: boolean
  }

  /** 动手前或动手后页面的一份指纹：地址、标题、正文的哈希与长度。 */
  interface BrowserTargetActionEffectSnapshot {
    url: string
    title: string
    textHash: string
    textLength: number
  }

  /** 打开一个网站并进入它的站点（换网站就再 open 一次，各站点的工作区互不相通）。 */
  export function open(input: BrowserOpenInput): Promise<BrowserOpened>

  /** 退出站点：之后要页面的操作都要先 open；站点工作区里的文件留着。 */
  export function leave(): Promise<void>

  /** 看现在进没进站点、在哪一页（地址、标题、加载状态、最近一次导航错误）；没进站点时也能调。 */
  export function state(): Promise<BrowserState>

  /** 把受控页面显示出来给用户看，不执行任何脚本。 */
  export function show(): Promise<BrowserPageWindowState>

  /** 列出标签页：内嵌页面只有当前这一页，外部浏览器列出它的全部标签页。 */
  export function tabs(): Promise<BrowserPageTargetsResult>

  /** 把之后的操作切到外部浏览器的另一个标签页（不关闭任何窗口）。 */
  export function switchTab(input: BrowserSwitchTabInput): Promise<BrowserSwitchPageTargetResult>

  /** 看页面：正文、标题结构、链接、可交互元素与表单字段（元素带 target，可以直接交给 click 这类操作）。 */
  export function inspect(input: BrowserInspectInput): Promise<BrowserPageInspection>

  /** 按 CSS selector 找元素，读文字、属性、值与可见性；列表、表格、组件读法都走它。 */
  export function query(input: BrowserQueryInput): Promise<BrowserElementQueryResult>

  /** 截图：图交给你看，返回值是落盘位置、坐标换算与标注说明。能结构化读的（表格、列表、文字）别靠截图。 */
  export function screenshot(input: BrowserScreenshotInput): Promise<BrowserScreenshot>

  /** 在页面里跑一段 JavaScript，读专门操作覆盖不到的状态或调试页面。 */
  export function evaluate(input: BrowserEvaluateInput): Promise<BrowserEvaluateScriptResult>

  /** 列出页面上的图片、视频、音频地址；fetchable 为真的可以直接交给 download。 */
  export function media(input: BrowserMediaInput): Promise<BrowserListMediaSourcesResult>

  /** 点一个元素；没找到时如实回 matched 为假与原因，只在唯一确定的元素上改用坐标补点。 */
  export function click(input: BrowserClickInput): Promise<BrowserActed>

  /** 往输入框或可编辑区域写入文字。 */
  export function fill(input: BrowserFillInput): Promise<BrowserActed>

  /** 选原生 select 的选项（自定义下拉框先 click 打开，再重新 inspect 找选项）。 */
  export function select(input: BrowserSelectInput): Promise<BrowserActed>

  /** 勾选或取消勾选复选框、单选项。 */
  export function check(input: BrowserCheckInput): Promise<BrowserActed>

  /** 把鼠标移到元素中心（悬停出菜单、提示）。 */
  export function hover(input: BrowserTargetInput): Promise<BrowserActed>

  /** 聚焦一个元素（之后 type、press 落在它上面）。 */
  export function focus(input: BrowserTargetInput): Promise<BrowserActed>

  /** 清空输入框或可编辑区域。 */
  export function clear(input: BrowserTargetInput): Promise<BrowserActed>

  /** 选中输入框或可编辑区域里的全部文字。 */
  export function selectText(input: BrowserTargetInput): Promise<BrowserActed>

  /** 把元素滚到视口中间。 */
  export function scrollIntoView(input: BrowserTargetInput): Promise<BrowserActed>

  /** 在当前站点里跳到一个网址（换网站用 open）。 */
  export function goto(input: BrowserGotoInput): Promise<BrowserPageNavigationResult>

  /** 后退。 */
  export function back(): Promise<BrowserPageNavigationResult>

  /** 前进。 */
  export function forward(): Promise<BrowserPageNavigationResult>

  /** 刷新当前页。 */
  export function reload(): Promise<BrowserPageNavigationResult>

  /** 滚动页面（触发懒加载、看下面的内容）。 */
  export function scroll(input: BrowserScrollInput): Promise<BrowserPageScrollResult>

  /** 在当前焦点处输入文字。 */
  export function type(input: BrowserTypeInput): Promise<BrowserTypeTextResult>

  /** 按一个键或组合键（提交表单按 Enter）。 */
  export function press(input: BrowserPressInput): Promise<BrowserPressKeyResult>

  /** 把鼠标移到视口里的一个点。 */
  export function mouseMove(input: BrowserPointInput): Promise<BrowserMoveMouseResult>

  /** 按视口坐标点一下：定位不到元素时的兜底，坐标取自截图（按 image.coordinateMap 换算）。 */
  export function clickAt(input: BrowserClickAtInput): Promise<BrowserClickCoordinatesResult>

  /** 把一个元素拖到另一个元素上。 */
  export function drag(input: BrowserDragInput): Promise<BrowserDragResult>

  /** 给 file input 选一个站点工作区里的文件。 */
  export function upload(input: BrowserUploadInput): Promise<BrowserUploadFileResult>

  /** 等一个 selector 出现、可见、隐藏或消失。 */
  export function waitForSelector(input: BrowserWaitForSelectorInput): Promise<BrowserWaitForSelectorResult>

  /** 等页面正文里出现一段文字。 */
  export function waitForText(input: BrowserWaitForTextInput): Promise<BrowserPageWaitResult>

  /** 等地址变成某个样子（跳转、登录回调）。 */
  export function waitForUrl(input: BrowserWaitForUrlInput): Promise<BrowserPageWaitResult>

  /** 等页面里一个表达式变成真。 */
  export function waitForFunction(input: BrowserWaitForFunctionInput): Promise<BrowserPageWaitResult>

  /** 等页面加载到某个状态（networkidle 是网络空闲）。 */
  export function waitForLoad(input: BrowserWaitForLoadInput): Promise<BrowserPageWaitResult>

  /** 原地停一会儿。 */
  export function wait(input: BrowserWaitInput): Promise<BrowserPageWaitResult>

  /** 列出挂着等处理的弹窗、下载与权限请求；没人处理的会在超时后按缺省结算（弹窗取消、下载取消、权限拒绝）。 */
  export function events(): Promise<BrowserPendingEventsResult>

  /** 等一个挂起事件出现（点了下载按钮之后等下载事件，再 handleDownload）。 */
  export function waitForEvent(input: BrowserWaitForEventInput): Promise<BrowserPendingEventWaitResult>

  /** 处理 JS 弹窗（alert、confirm、prompt）。 */
  export function handleDialog(input: BrowserDialogInput): Promise<BrowserHandleDialogResult>

  /** 保存或取消一次下载。 */
  export function handleDownload(input: BrowserDownloadDecisionInput): Promise<BrowserHandleDownloadResult>

  /** 允许或拒绝一次权限请求。 */
  export function handlePermission(input: BrowserPermissionInput): Promise<BrowserHandlePermissionResult>

  /** 把页面上的一张表取成表头加各行。 */
  export function table(input: BrowserTableInput): Promise<BrowserTable>

  /** 把重复出现的条目（搜索结果、卡片）取成列表：标题、链接、摘要。 */
  export function list(input: BrowserListInput): Promise<BrowserList>

  /** 翻页收集列表（会真的点下一页）。 */
  export function paginate(input: BrowserPaginateInput): Promise<BrowserPaginated>

  /** 取页面正文（缺省 Markdown）。 */
  export function content(input: BrowserContentInput): Promise<BrowserContent>

  /** 带着当前页面的登录态下载一个资源到站点工作区。 */
  export function download(input: BrowserDownloadInput): Promise<BrowserFetchResourceResult>

  /** 把当前页面导出成 PDF。 */
  export function savePdf(input: BrowserSavePdfInput): Promise<BrowserExportPagePdfResult>
}
