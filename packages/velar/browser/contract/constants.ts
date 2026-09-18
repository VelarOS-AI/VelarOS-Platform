/**
 * 约定的常量表（对外合同的一部分）：错误码、写进 `velar:browser`、`velar:devtools` 与 `velar:cdp` 声明的上限、偏好的合法值闭集、跨层标记。
 * 上限写进声明给模型看，入参核对用的也是这一份，验收核对两边一致；不给上限时一律取到这里的上限（代码面不替模型折叠），
 * 这些上限只为守住内存与一次页面往返的体量。整份随 `./browser/contracts` 出包，宿主与渲染进程都读得到。
 *
 * 这个文件不 import 任何东西、不用 Node 专属类型。包内可调的数字（超时、缓冲、保留条数）不在这里，在 `utils/tuning.ts`。
 */

/**
 * 本单元对外承诺的错误语义：程序与宿主按码分支，不按文案。码本身是契约的一部分，不得改名；文字说明随时可能改。
 * 没有专属码的失败沿用 `@velaros-ai/core` 的通用 `AppError` 码（入参不对是 `VALIDATION`，等待超时是 `TIMEOUT`）。
 */
export const BrowserErrorCodes = Object.freeze({
  /** 还没进站点（没 open，或者已经 leave）：要页面的操作一律先要求 open，空间端口一次都不调。 */
  siteNotOpen: 'BROWSER_SITE_NOT_OPEN',
  /** evaluate、waitForFunction 的页面脚本抛了错（语法错误也算）：message 带页面给的错误名、说明与脚本里的行列。 */
  scriptFailed: 'BROWSER_SCRIPT_FAILED',
  /** evaluate 或一条 CDP 命令的结果超过只为守住内存的上限：在脚本里先筛、切片，或者分几次取。 */
  resultTooLarge: 'BROWSER_RESULT_TOO_LARGE',
  /** velar:cdp 的命令被协议拒绝（方法不存在、参数不对、目标没了）：message 是协议给的原话。 */
  protocolFailed: 'BROWSER_PROTOCOL_FAILED',
  /** 指定的 frame 不在当前页面的框架树里（页面跳转之后旧 id 作废）：重新 frames()。 */
  frameNotFound: 'BROWSER_FRAME_NOT_FOUND',
  /** 界面没装浏览器合成 Provider，拿不到受控页面。 */
  compositionNotInstalled: 'BROWSER_COMPOSITION_NOT_INSTALLED',
})

/** 看页面的上限：写进 `inspect` 的声明；`selectorChars` 也管元素目标里的 CSS selector。 */
export const BrowserInspectLimits = Object.freeze({
  /** 一次 inspect 最多交回多少字符正文。 */
  textChars: 100_000,
  /** 一次 inspect 最多交回多少字符 HTML。 */
  htmlChars: 100_000,
  /** 一次 inspect 最多交回多少个可交互元素。 */
  elements: 400,
  /** 一个 CSS selector 最长多少字符。 */
  selectorChars: 1_000,
  /** 一次最多排除多少个噪音子树 selector。 */
  ignoreSelectors: 50,
})

/** 输入与导航的上限：写进点击、填写、键鼠、拖拽与 goto 的声明。 */
export const BrowserActionLimits = Object.freeze({
  /** 一个网址最长多少字符。 */
  urlChars: 2_048,
  /** fill 一次写入、insertText 一次插入最多多少字符。 */
  textChars: 20_000,
  /** 一个键名最长多少字符。 */
  keyChars: 80,
  /** press 同一个键最多连按几次。 */
  keyRepeat: 50,
  /** 视口坐标的上限，也是滚轮一次滚动的绝对值上限，像素。 */
  coordinate: 10_000,
  /** 一次点击最多连击几下。 */
  clickCount: 5,
  /** mouseMove 与拖拽最多拆成几步移动。 */
  moveSteps: 60,
})

/** 等待的上限与缺省：写进 `waitForFunction`、`waitForLoad` 与 velar:cdp `waitForEvent` 的声明。 */
export const BrowserWaitLimits = Object.freeze({
  /** 一次等待最多等多少毫秒。 */
  maxMs: 60_000,
  /** 不给 timeoutMs 时等多少毫秒。 */
  defaultMs: 30_000,
  /** waitForFunction 两次判定之间最短隔多少毫秒。 */
  minIntervalMs: 50,
  /** waitForFunction 两次判定之间最长隔多少毫秒。 */
  maxIntervalMs: 5_000,
  /** 不给 intervalMs 时隔多少毫秒判定一次。 */
  defaultIntervalMs: 100,
})

/** 页面脚本的上限：写进 `evaluate` 与 `waitForFunction` 的声明。 */
export const BrowserEvaluateLimits = Object.freeze({
  /** 一段脚本最长多少字符。 */
  scriptChars: 20_000,
  /** args 按 JSON 算最长多少字符。 */
  argsChars: 1_000_000,
  /** 一次求值最多等多少毫秒。 */
  timeoutMs: 30_000,
  /** 不给 timeoutMs 时等多少毫秒。 */
  defaultTimeoutMs: 5_000,
  /** 结果 JSON 最长多少字符（只为守住内存）；超了抛 BROWSER_RESULT_TOO_LARGE，不交半截。 */
  resultChars: 10_000_000,
})

/** 模型自己那条 CDP 会话的上限：写进 velar:cdp 的声明。 */
export const BrowserProtocolLimits = Object.freeze({
  /** 方法名最长多少字符。 */
  methodChars: 200,
  /** params 按 JSON 算最长多少字符。 */
  paramsChars: 10_000_000,
  /** 子会话 id 最长多少字符。 */
  sessionChars: 200,
  /** 一条命令的结果 JSON 最长多少字符（只为守住内存）；超了抛 BROWSER_RESULT_TOO_LARGE。 */
  resultChars: 10_000_000,
  /** 事件缓冲最多留多少条（只为守住内存）；挤掉的从最早的算起，条数记在 dropped。 */
  bufferedEvents: 5_000,
  /** 被 Fetch 拦下的请求多少毫秒没人放行，宿主替它放行。 */
  autoContinueMs: 30_000,
})

/** 抓取与导出的上限：写进 `download`、`savePdf` 的声明。 */
export const BrowserFetchLimits = Object.freeze({
  /** 单个文件最多下载多少字节（50 MB）。 */
  fileBytes: 52_428_800,
  /** 下载地址与站点工作区里的保存路径最长多少字符。 */
  pathChars: 4_096,
})

/** 诊断与网络的上限：写进 `diagnostics`、`request` 的声明。 */
export const BrowserDiagnosticsLimits = Object.freeze({
  /** 一次最多交回多少条诊断事件。 */
  entries: 300,
  /** HTTP status 过滤的取值上限。 */
  networkStatus: 999,
  /** resourceType 过滤最长多少字符。 */
  resourceTypeChars: 80,
  /** 一个 requestId 最长多少字符。 */
  requestIdChars: 200,
  /** 响应体一次最多读多少字符。 */
  responseBodyChars: 200_000,
})

/** 页面条件的上限：写进 `zoom`、`network` 的声明。 */
export const BrowserConditionLimits = Object.freeze({
  /** 缩放系数的下限。 */
  minZoomFactor: 0.25,
  /** 缩放系数的上限。 */
  maxZoomFactor: 3,
  /** 一次放大缩小的步长下限。 */
  minZoomStep: 0.05,
  /** 一次放大缩小的步长上限。 */
  maxZoomStep: 0.5,
  /** 一个请求头名最长多少字符。 */
  headerNameChars: 120,
  /** 一个请求头值最长多少字符。 */
  headerValueChars: 4_000,
  /** 最多拦几条 URL 规则。 */
  blockedUrlPatterns: 100,
  /** 最多拦几种资源类型。 */
  blockedResourceTypes: 32,
  /** 最多挂几条 mock 响应。 */
  mockResponses: 50,
  /** 一条 mock 响应的正文最多多少字符。 */
  mockBodyChars: 1_000_000,
  /** URL 规则最长多少字符。 */
  urlPatternChars: 2_048,
})

/** 截图与录屏的公开上限与缺省：写进 `screenshot`、`startRecording` 的声明，入参核对用的也是这一份。 */
export const BrowserCaptureLimits = Object.freeze({
  /** 截图保存路径最长多少字符。 */
  pathChars: 180,
  /** 截图前设视口时，宽度的下限，像素。 */
  minViewportWidth: 320,
  /** 截图前设视口时，宽度的上限，像素。 */
  maxViewportWidth: 3_840,
  /** 截图前设视口时，高度的下限，像素。 */
  minViewportHeight: 240,
  /** 截图前设视口时，高度的上限，像素。 */
  maxViewportHeight: 2_160,
  /** 截图前等网络空闲最少等多少毫秒。 */
  minNetworkIdleMs: 100,
  /** 截图前等网络空闲最多等多少毫秒。 */
  maxNetworkIdleMs: 5_000,
  /** 判 DOM 稳定至少要连续多少帧没变化。 */
  minDomStableFrames: 3,
  /** 判 DOM 稳定最多看多少帧。 */
  maxDomStableFrames: 16,
  /** 判 DOM 稳定的取样间隔最短多少毫秒。 */
  minDomStableSampleMs: 16,
  /** 判 DOM 稳定的取样间隔最长多少毫秒。 */
  maxDomStableSampleMs: 250,
  /** 等 DOM 稳定最少等多少毫秒。 */
  minDomStableWaitMs: 250,
  /** 等 DOM 稳定最多等多少毫秒。 */
  maxDomStableWaitMs: 8_000,
  /** 整页截图单边最多多少像素。 */
  fullPageMaxSide: 32_000,
  /** 一张图最多标注多少个元素。 */
  annotatedElements: 120,
  /** 区域截图的坐标与边长上限，像素。 */
  regionMaxSide: 20_000,
  /** 录屏帧宽度的下限，像素。 */
  minScreencastWidth: 240,
  /** 录屏帧宽度的上限，像素。 */
  maxScreencastWidth: 1_600,
  /** 不给 maxWidth 时录屏帧多宽，像素。 */
  defaultScreencastWidth: 800,
  /** 录屏抽帧间隔（每 N 帧取 1）最多隔几帧。 */
  maxScreencastFrameStep: 10,
  /** 不给 everyNthFrame 时每几帧取一帧。 */
  defaultScreencastFrameStep: 2,
  /** 录屏产物名最长多少字符。 */
  screencastNameChars: 60,
})

/** 性能分析的公开上限与缺省：写进 `startTrace`、`insight`、`heapSnapshot` 的声明。 */
export const BrowserPerformanceLimits = Object.freeze({
  /** trace 录制窗口最短多少毫秒。 */
  minTraceMs: 1_000,
  /** trace 录制窗口最长多少毫秒。 */
  maxTraceMs: 60_000,
  /** 不给 autoStopMs 时录多少毫秒自动停。 */
  defaultTraceMs: 5_000,
  /** insight 集合 id 与 insight 名各自最长多少字符。 */
  insightIdChars: 120,
  /** 堆快照保存路径最长多少字符。 */
  snapshotPathChars: 300,
})

/** 等挂起事件的公开上限与缺省：写进 `waitForEvent` 的声明。 */
export const BrowserPendingEventLimits = Object.freeze({
  /** 等一个挂起事件最多等多少毫秒。 */
  maxWaitMs: 60_000,
  /** 不给 timeoutMs 时等多少毫秒。 */
  defaultWaitMs: 5_000,
})

/** 用户脚本的公开上限：写进 `createUserScript`、`updateUserScript` 的声明。 */
export const BrowserUserScriptLimits = Object.freeze({
  /** 一个用户脚本的代码最多多少字节。 */
  codeBytes: 1_000_000,
  /** 一个用户脚本最多几条 match / excludeMatch 规则。 */
  matchRules: 64,
  /** 一条匹配规则最长多少字符。 */
  matchRuleChars: 500,
  /** 脚本名最长多少字符。 */
  nameChars: 120,
  /** 脚本说明最长多少字符。 */
  descriptionChars: 500,
  /** 版本号最长多少字符。 */
  versionChars: 64,
})

/** 站点工作区文件访问的公开上限：宿主经 `createBrowserSiteWorkspaceFileAccess` 读写站点文件时守的数。 */
export const BrowserFileLimits = Object.freeze({
  /** 读一个文件不给 endLine、maxChars 时最多返回多少字符。 */
  readChars: 200_000,
  /** 一个工作区相对路径最长多少字符。 */
  pathChars: 4_096,
  /** 列目录一次最多返回多少条。 */
  listItems: 1_000,
  /** 递归列目录最多往下走几层。 */
  listDepth: 16,
})

/** 浏览器偏好的合法值闭集与出厂缺省：搜索引擎与自动化后端。加一个引擎只改这里。 */
export const BrowserSearchEngineIds = Object.freeze(['google', 'bing'] as const)

/** 自动化后端的合法值闭集：内嵌 webview 还是外部浏览器。 */
export const BrowserAutomationModes = Object.freeze(['webview', 'external'] as const)

/** 出厂缺省搜索引擎。 */
export const DefaultBrowserSearchEngine = 'google' as const

/** 出厂缺省自动化后端。 */
export const DefaultBrowserAutomationMode = 'webview' as const

/**
 * 「内嵌浏览器视图没接上」这一失败态的跨层标记（挂在 `AppError.context.reason` 上）。
 *
 * 运行时只陈述事实并打上这个标记；宿主捕获后翻译成可执行指引。文案可以随便改，标记不能——它是接缝。
 */
export const BrowserViewNotAttachedReason = 'browser-view-not-attached' as const

/**
 * 浏览器自动化的统一虚拟指针外观：页面注入脚本与宿主预览窗口共用这一份，免得两处各画一份。
 */
export const BrowserFallbackVirtualPointer = Object.freeze({
  /** 指针图标的宽（CSS 像素）。 */
  width: 24,
  /** 指针图标的高（CSS 像素）。 */
  height: 24,
  viewBox: '0 0 24 24',
  // @arch-guard:suspend code-style/require-chinese-comments 理由：下一行是第三方图标的著作权归属，署名与许可证名必须逐字保留，翻译会使归属失效。
  // 取自 Pictogrammers Material Design Icons `cursor-default`（Apache-2.0）。
  // 采用经典系统箭头的短柄轮廓，避免宽大的导航箭头或带钩的光标造型。
  path: 'M13.64,21.97C13.14,22.21 12.54,22 12.31,21.5L10.13,16.76L7.62,18.78C7.45,18.92 7.24,19 7,19A1,1 0 0,1 6,18V3A1,1 0 0,1 7,2C7.24,2 7.47,2.09 7.64,2.23L7.65,2.22L19.14,11.86C19.57,12.22 19.62,12.85 19.27,13.27C19.12,13.45 18.91,13.57 18.7,13.61L15.54,14.23L17.74,18.96C18,19.46 17.76,20.05 17.26,20.28L13.64,21.97Z',
  fill: '#050505',
  stroke: '#ffffff',
  /** 描边宽度（CSS 像素）：浅色页面上也看得见轮廓。 */
  strokeWidth: 1.8,
  /** 热点相对图标左上角的横向偏移（CSS 像素）：箭头尖就落在这里。 */
  hotspotX: 7,
  /** 热点相对图标左上角的纵向偏移（CSS 像素）。 */
  hotspotY: 2,
  filter: 'drop-shadow(0 1px 1px rgba(0, 0, 0, 0.48))',
})
