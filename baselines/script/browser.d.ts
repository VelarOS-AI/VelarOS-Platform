/**
 * 浏览器：打开网站、看页面、在页面里跑 JavaScript、真实的鼠标键盘输入、导航与等待、处理弹窗下载与权限、下载与导出。
 * 先 open 进站点，其余要页面的操作没进站点时抛 BROWSER_SITE_NOT_OPEN。读页面、改 DOM、读 localStorage 用 evaluate；
 * 要真实输入（事件 isTrusted、:hover、按键的默认行为、富文本编辑器）用 click、press 或文本 fill；日期类 fill 使用原生值与 input/change 事件（事件不标为 isTrusted）。
 * 元素写法：inspect、标注截图给的 ref（如 @e3:g2，原样传回；新的一次 inspect 或标注截图之后旧 ref 作废），或 CSS selector，或结果里的 target。
 * 坐标一律是视口 CSS 像素，和截图的 coordinateMap 同一套。站点工作区是这个网站的私有目录：截图、下载、PDF 都落在那里，路径一律相对它，出不去。
 * 诊断、网络规则、性能、录屏与用户脚本在 velaros:devtools；直接发 CDP 命令在 velaros:cdp。
 */
declare module 'velaros:browser' {
  /** 打开一个网站并进入它的站点（换网站就再 open 一次，各站点的工作区互不相通）。
   */
  export function open(input: BrowserOpenInput): Promise<BrowserOpened>

  /** 退出站点：之后要页面的操作都要先 open；站点工作区里的文件留着。
   */
  export function leave(): Promise<void>

  /** 看现在进没进站点、在哪一页、有哪些标签页、有没有挂着等处理的弹窗下载与权限；没进站点时也能调。
   */
  export function state(): Promise<BrowserState>

  /** 把受控页面显示出来给用户看，不执行任何脚本。
   */
  export function show(): Promise<BrowserPageWindowState>

  /** 把之后的操作切到外部浏览器的另一个标签页（不关闭任何窗口）。
   */
  export function switchTab(input: BrowserSwitchTabInput): Promise<BrowserSwitchPageTargetResult>

  /** 看页面：正文、标题结构、链接、可交互元素与表单字段（元素带 target，可以直接交给 click 这类操作）。
   */
  export function inspect(input: BrowserInspectInput): Promise<BrowserPageInspection>

  /** 截图：图交给你看，返回值是落盘位置、坐标换算与标注说明。能在页面里读的（表格、列表、文字）用 evaluate 读，别靠截图。
   */
  export function screenshot(input: BrowserScreenshotInput): Promise<BrowserScreenshot>

  /**
   * 在页面里跑一段 JavaScript，交回它的值：结果按 JSON 整份取回（DOM 元素换成它的描述，环引用写成 "[Circular]"，日期照 toJSON），
   * 超过 10000000 个字符抛 BROWSER_RESULT_TOO_LARGE；页面里抛错（语法错误也算）抛 BROWSER_SCRIPT_FAILED，message 带页面的报错与它在 script 里的行列。
   * 读页面、取表格列表正文、改 DOM、设下拉框、读 localStorage 都用它。
   */
  export function evaluate(input: BrowserEvaluateInput): Promise<any>

  /** 列出页面的框架树：顶层页面与各层 iframe（含跨源的），id 交给 evaluate、waitForFunction 的 frame。页面跳转之后旧 id 作废。
   */
  export function frames(): Promise<BrowserFrameInfo[]>

  /** 点一下元素或视口里的一个点；元素没找到时如实回 matched 为假与原因，只在唯一确定的元素上改用坐标补点。
   */
  export function click(input: BrowserClickInput): Promise<BrowserActed>

  /** 替换输入框、文本域或可编辑区域的内容。文本使用真实输入；date/time/datetime-local/month/week 按 HTML 标准格式设原生值并触发 input/change，事件不标为 isTrusted。返回 controlState 核对实际值。
   */
  export function fill(input: BrowserFillInput): Promise<BrowserActed>

  /** 把鼠标移到元素中心（悬停出菜单、提示）。
   */
  export function hover(input: BrowserHoverInput): Promise<BrowserActed>

  /** 在当前焦点处插入文字。
   */
  export function insertText(input: BrowserInsertTextInput): Promise<BrowserInsertTextResult>

  /** 按一个键或组合键（提交表单按 Enter）。
   */
  export function press(input: BrowserPressInput): Promise<BrowserPressKeyResult>

  /** 按下一个键不放，直到 keyUp。
   */
  export function keyDown(input: BrowserKeyInput): Promise<BrowserKeyResult>

  /** 抬起一个按着的键。
   */
  export function keyUp(input: BrowserKeyInput): Promise<BrowserKeyResult>

  /** 把鼠标移到视口里的一个点（按着鼠标键时就是拖）。
   */
  export function mouseMove(input: BrowserMouseMoveInput): Promise<BrowserMouseResult>

  /** 在鼠标现在的位置按下一个鼠标键。
   */
  export function mouseDown(input: BrowserMouseButtonInput): Promise<BrowserMouseResult>

  /** 在鼠标现在的位置松开一个鼠标键。
   */
  export function mouseUp(input: BrowserMouseButtonInput): Promise<BrowserMouseResult>

  /** 在鼠标现在的位置滚一下滚轮（地图、虚拟列表、只认滚轮的区域）；整页滚动在 evaluate 里 scrollBy 就行。
   */
  export function wheel(input: BrowserWheelInput): Promise<BrowserMouseResult>

  /** 把一个元素拖到另一个元素上。
   */
  export function drag(input: BrowserDragInput): Promise<BrowserDragResult>

  /** 给 file input 选一个站点工作区里的文件。
   */
  export function upload(input: BrowserUploadInput): Promise<BrowserUploadFileResult>

  /** 在当前站点里跳到一个网址（换网站用 open）。
   */
  export function goto(input: BrowserGotoInput): Promise<BrowserPageNavigationResult>

  /** 后退。
   */
  export function back(): Promise<BrowserPageNavigationResult>

  /** 前进。
   */
  export function forward(): Promise<BrowserPageNavigationResult>

  /** 刷新当前页。
   */
  export function reload(): Promise<BrowserPageNavigationResult>

  /** 等页面里一个条件成立，交回判定式的值（元素出现、文字出现、地址变了、数据加载完，都写成一个判定式）。
   * 判定式盯着你要的数据本身：点「加载更多」之后等行数比点之前多，翻页之后等第一条变了；别只等「页面有变化」——按钮先变成
   * 「加载中」也算变化，那时数据还没到，读出来的就是不全的。
   */
  export function waitForFunction(input: BrowserWaitForFunctionInput): Promise<any>

  /** 等页面加载到某个状态，交回那时的页面状态。
   */
  export function waitForLoad(input: BrowserWaitForLoadInput): Promise<BrowserPageState>

  /** 等一个挂起事件出现，交回这个事件（点了下载按钮之后等下载事件，再 handleDownload）。
   */
  export function waitForEvent(input: BrowserWaitForEventInput): Promise<BrowserPendingEventSummary>

  /** 处理 JS 弹窗（alert、confirm、prompt）。
   */
  export function handleDialog(input: BrowserDialogInput): Promise<BrowserHandleDialogResult>

  /** 保存或取消一次下载。
   */
  export function handleDownload(input: BrowserDownloadDecisionInput): Promise<BrowserHandleDownloadResult>

  /** 允许或拒绝一次权限请求。
   */
  export function handlePermission(input: BrowserPermissionInput): Promise<BrowserHandlePermissionResult>

  /** 带着当前页面的登录态下载一个资源到站点工作区。
   */
  export function download(input: BrowserDownloadInput): Promise<BrowserFetchResourceResult>

  /** 把当前页面导出成 PDF。
   */
  export function savePdf(input: BrowserSavePdfInput): Promise<BrowserExportPagePdfResult>

  /** 打开一个网站并进入它的站点：url 最多 2048 个字符，不带协议按 https:// 补全，localhost 也行。 */
  interface BrowserOpenInput {
    url: string
  }

  /** 进站的结果：站点工作区在哪（workspaceRoot），以及落地后的页面状态。 */
  interface BrowserOpened {
    site: BrowserSiteContext
    page: BrowserPageState
  }

  /**
   * 当前状态：没进站点时 active 为假、其余字段都没有；进了站点时带着站点与页面状态，tabs 是标签页（内嵌页面只有当前这一页，外部浏览器是全部），
   * pending 是挂着等处理的弹窗、下载与权限请求（没人处理的会在超时后按缺省结算：弹窗取消、下载取消、权限拒绝）。
   */
  interface BrowserState {
    active: boolean
    site?: BrowserSiteContext
    page?: BrowserPageState
    tabs?: BrowserPageTargetInfo[]
    pending?: BrowserPendingEventSummary[]
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

  /** 切到外部浏览器的另一个标签页：targetId 取自 state() 结果里的 tabs[].id。 */
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
   * 在页面里跑一段 JavaScript：script 是一个表达式（最多 20000 个字符），求出来是函数就用 args 调它，是 Promise 就等它；
   * 多条语句写成 `() => { …; return x }`。args 是交给函数的参数（JSON 值，合起来最多 1000000 个字符）：值用它传，别拼进源码。
   * frame 是 frames() 给的 id，不给就在顶层页面里跑。timeoutMs 缺省 5000、最多 30000。
   */
  interface BrowserEvaluateInput {
    script: string
    args?: unknown[]
    frame?: string
    timeoutMs?: number
  }

  /** 页面里的一个框架：id 交给 evaluate、waitForFunction 的 frame，parentId 是上一层（顶层页面是 null），crossOrigin 为真是和顶层页面不同源的 iframe。 */
  interface BrowserFrameInfo {
    id: string
    parentId: string | null
    url: string
    name: string
    crossOrigin: boolean
  }

  /**
   * 点一下：target 是元素（点它的中心：先滚进视口，确认没被挡住），或者给视口坐标 x、y（0 到 10000；取自截图时按 image.coordinateMap 换算），两样只给一样。
   * button 缺省 left，clickCount 是连击几下（最多 5，双击给 2）；按住的修饰键（keyDown）会带上。
   * waitForNavigation 为真时按完整的导航稳定窗口等（缺省只短暂等一下可能的跳转）。
   */
  interface BrowserClickInput {
    target?: BrowserTarget
    x?: number
    y?: number
    button?: BrowserMouseButton
    clickCount?: number
    waitForNavigation?: boolean
  }

  /**
   * click、fill、hover 的结果：action 是做的哪件事；matched 为假时 failureReason 说为什么（没找到、点不动、被挡住），blockedBy 是挡住它的元素；
   * effect 是动手前后页面的变化（地址、标题、正文），controlState 是动完之后控件的状态（fill 之后读它确认写进去的值）。
   * 按坐标点的 selector 与 text 是 null。selectorRecovery 在改用坐标补点时出现，actionEffect 在点中了却没有变化时出现。
   */
  interface BrowserActed extends BrowserTargetActionOutcome {
    action: 'click' | 'fill' | 'hover'
    selectorRecovery?: BrowserSelectorRecovery
    actionEffect?: BrowserActionEffectHint
  }

  /**
   * 往输入框、文本域或可编辑区域写入文字，替换原来的内容：value 最多 20000 个字符，空字符串就是清空。
   * 是真实输入：聚焦、全选，再像输入法一样插入，React、Vue 与富文本编辑器都认。勾选框、下拉框、日期这类不是文本的控件回 matched 为假：
   * 勾选用 click，下拉框与日期在 evaluate 里设值再派发 change。
   */
  interface BrowserFillInput {
    target: BrowserTarget
    value: string
  }

  /** 悬停：把鼠标移到元素中心（出菜单、出提示）；移到一个坐标用 mouseMove。 */
  interface BrowserHoverInput {
    target: BrowserTarget
  }

  /** 在当前焦点处插入文字（像输入法上屏：发 beforeinput、input，不发按键事件）：text 最多 20000 个字符。要先点中输入框。 */
  interface BrowserInsertTextInput {
    text: string
  }

  /** 插入的结果：textLength 是插入了几个字符。 */
  interface BrowserInsertTextResult {
    url: string
    textLength: number
    capturedAt: number
  }

  /**
   * 按一个键（按下再抬起）：key 是 Enter、Tab、Escape、Backspace、ArrowDown、Home、F5 这类键名或一个字符（最多 80 个字符），组合键写 Control+a 或给 modifiers；
   * repeat 是连按几次（最多 50），waitForNavigation 为真时按完等可能的跳转。按住的修饰键（keyDown）也会带上。
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

  /**
   * 按下或抬起一个键：key 的写法同 press，一次一个键（最多 80 个字符）。Shift、Control、Alt、Meta 按下之后带到之后的每个按键与鼠标事件上，
   * 直到 keyUp：keyDown Shift 之后的 click 就是 Shift 点击。
   */
  interface BrowserKeyInput {
    key: string
  }

  /** 按键之后：held 是现在还按着的键（keyDown 了还没 keyUp 的）。 */
  interface BrowserKeyResult {
    url: string
    key: string
    held: string[]
  }

  /** 把鼠标移到视口里的一个点（CSS 像素，0 到 10000）：steps 是拆成几步移动（最多 60，缺省 1）；按着鼠标键时就是拖。 */
  interface BrowserMouseMoveInput {
    x: number
    y: number
    steps?: number
  }

  /** 鼠标动过之后：x、y 是它现在在视口里的位置，buttons 是还按着的鼠标键。 */
  interface BrowserMouseResult {
    url: string
    x: number
    y: number
    buttons: BrowserMouseButton[]
  }

  /** 在鼠标现在的位置按下或松开一个键：button 缺省 left，clickCount 是连击的第几下（双击的第二下给 2，最多 5）。 */
  interface BrowserMouseButtonInput {
    button?: BrowserMouseButton
    clickCount?: number
  }

  /** 在鼠标现在的位置滚一下滚轮：deltaX、deltaY 是像素（绝对值最多 10000，往下、往右为正），至少给一个。要先 mouseMove 到要滚的区域上。 */
  interface BrowserWheelInput {
    deltaX?: number
    deltaY?: number
  }

  /** 把一个元素拖到另一个元素上：steps 是拆成几步移动（最多 60）。拖出任意路径用 mouseDown、mouseMove、mouseUp。 */
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
   * 等页面里一个条件成立：script、args、frame 的写法同 evaluate；宿主每隔 intervalMs（50 到 5000，缺省 100）在当前页面上跑一次，
   * 结果为真就交回它，页面跳转途中的那一次算没到、新页面上接着判。timeoutMs 最多 60000、缺省 30000，等不到抛 TIMEOUT；
   * 页面里抛错直接抛 BROWSER_SCRIPT_FAILED（元素可能还没出现时写 `?.`）。
   */
  interface BrowserWaitForFunctionInput {
    script: string
    args?: unknown[]
    frame?: string
    timeoutMs?: number
    intervalMs?: number
  }

  /** 等页面加载到某个状态：state 缺省 load（也可以 domcontentloaded、networkidle），timeoutMs 最多 60000、缺省 30000，等不到抛 TIMEOUT。 */
  interface BrowserWaitForLoadInput {
    state?: BrowserPageWaitLoadState
    timeoutMs?: number
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

  /** 等一个挂起事件出现：kind 缺省 download，timeoutMs 缺省 5000、最多 60000，等不到抛 TIMEOUT。 */
  interface BrowserWaitForEventInput {
    kind?: BrowserPendingEventKind
    timeoutMs?: number
  }

  /** 一个挂着等处理的事件：id 交给 handleDialog、handleDownload、handlePermission，details 里是弹窗文字、文件名、要的权限这些细节。 */
  interface BrowserPendingEventSummary {
    id: string
    kind: BrowserPendingEventKind
    createdAt: number
    details: Record<string, unknown>
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

  /** 一个标签页：id 交给 switchTab，active 为真表示当前在操作它。 */
  interface BrowserPageTargetInfo {
    id: string
    type: 'page'
    url: string
    title: string
    active: boolean
  }

  /** 视口尺寸：width、height 是 CSS 像素，mobile 为真时按手机视口处理。 */
  interface BrowserViewportOptions {
    width: number
    height: number
    /** 是否启用 Chromium 的移动设备 viewport 语义；缺省保持桌面兼容行为。 */
    mobile?: boolean
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

  /** 只截页面上的一块：给 selector（截那个元素），或者给完整的 x、y、width、height（页面 CSS 像素，含滚动，最多 20000）。 */
  type BrowserScreenshotRegion =
    { selector: string } | { x: number; y: number; width: number; height: number }

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

  /** 要操作的元素：字符串以 @ 开头当 ref，其余当 CSS selector；也可以给一份定位线索。 */
  type BrowserTarget = string | BrowserTargetHint

  /** 鼠标按键：left、middle、right。 */
  type BrowserMouseButton = 'left' | 'middle' | 'right'

  /**
   * 按元素动手的结果：matched 为假时 failureReason 说为什么（not-found 没找到、not-interactable 点不动或不是文本控件、covered 被挡住），blockedBy 是挡住它的元素。
   * effect 是动手前后页面的变化，controlState 是动完之后控件的值或勾选状态。
   */
  interface BrowserTargetActionOutcome {
    url: string
    matched: boolean
    selector: string | null
    text: string | null
    clickPoint?: { x: number; y: number } | null | undefined
    clickMethod?: ('dom' | 'coordinate') | null | undefined
    effect?: BrowserTargetActionEffect | null | undefined
    failureReason?: ('not-found' | 'not-interactable' | 'covered') | null | undefined
    blockedBy?: string | null | undefined
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

  /** 组合键的修饰键：shift、control、alt、meta。 */
  type BrowserKeyModifier = 'shift' | 'control' | 'alt' | 'meta'

  /** 拖拽的一端：matched 为假表示没找到这个元素，point 是按下或松开的位置。 */
  interface BrowserDragEndpointResult {
    matched: boolean
    selector: string | null
    text: string | null
    point: { x: number; y: number } | null
  }

  /** 拖拽没成的原因：source-not-found、target-not-found、not-interactable。 */
  type BrowserDragFailureReason = 'source-not-found' | 'target-not-found' | 'not-interactable'

  /** 导航动作：back、forward、reload、goto。 */
  type BrowserPageNavigationAction = 'back' | 'forward' | 'reload' | 'goto'

  /** 页面加载状态：domcontentloaded、load、networkidle（网络空闲）。 */
  type BrowserPageWaitLoadState = 'domcontentloaded' | 'load' | 'networkidle'

  /** 挂起事件的种类：dialog（JS 弹窗）、download（下载）、permission（权限请求）。 */
  type BrowserPendingEventKind = 'dialog' | 'download' | 'permission'

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

  /** 可以点的东西是什么：button、submit、link、combobox（下拉框）、option、menuitem。 */
  type BrowserPageActionRole =
    'button' | 'submit' | 'link' | 'combobox' | 'option' | 'menuitem'

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

  /**
   * 定位一个元素的线索，至少给一样：ref 是 inspect、标注截图给的引用（如 @e3:g2，原样传回；新的一次 inspect 或标注截图之后旧 ref 作废），
   * css 是 CSS selector（最多 1000 个字符），text、name、role、attributes（id、data-testid 这类）按可见文字、可访问名称、角色与属性找；
   * frame 限定在哪个同源 iframe 里找（只进一层）。inspect 结果、截图 legend 里的 target 可以原样传进来。
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
}
