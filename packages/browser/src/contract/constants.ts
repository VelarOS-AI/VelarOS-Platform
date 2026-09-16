/**
 * 浏览器包**约定的常量表**：身份、目录约定、写进工具说明与 schema 的上限。整份随 `./core/contracts` 出包，
 * 宿主与渲染进程都读得到；改这里等于改对外契约。
 *
 * 这个文件**不 import 任何东西**、不用 Node 专属类型：它和可移植数据文件 `types/browser.ts` 一起构成
 * 渲染进程能加载的那一半。包内可调的数字（超时、缓冲、保留条数）不在这里，在 `utils/tuning.ts`。
 */

/**
 * 浏览器 mod 的身份。
 *
 * 单独成常量而不是留在工具文件里，是因为消费者分处两端：装配侧要它来注册随包 mod，
 * 而产品壳的**空间门控声明**（renderer 也会读的那份 descriptor）只需要这一个字符串。
 * 后者若从工具文件取，就会把浏览器工具集与整条 Node 侧运行时依赖拖进渲染层 bundle。
 */
export const BrowserModId = 'velaros.browser' as const

/** 浏览器空间的身份；空间配方与 mod 清单都按它对齐。 */
export const BrowserSpaceId = 'browser' as const

/**
 * 站点工作区里各类产物的目录名 —— **对外约定**：宿主的文件面板与 `browser:files` 按它找产物，
 * 改了等于改用户在磁盘上看到的目录结构。
 */
export const BrowserWorkspaceArtifactDirectoryMap = Object.freeze({
  /** 页面快照（HTML / 正文）。 */
  page: 'pages',
  /** recipe 骨架与它的修订。 */
  recipe: 'recipes',
  /** 结构化提取的结果（表格、列表、正文）。 */
  extract: 'extracts',
  /** 模型自己写的笔记。 */
  note: 'notes',
  /** recipe 的每次执行记录。 */
  run: 'runs',
  /** 下载与抓取到的文件。 */
  download: 'downloads',
})

/** 产物格式到文件扩展名的约定：落盘的文件名按它拼，宿主按扩展名认类型。 */
export const BrowserWorkspaceArtifactFormatExtensionMap = Object.freeze({
  /** 结构化数据。 */
  json: 'json',
  /** 纯文本。 */
  text: 'txt',
  /** Markdown 正文。 */
  markdown: 'md',
  /** 原始 HTML。 */
  html: 'html',
})

/** 工作区文件读写的公开上限：写进 `browser:files` 的说明与 schema，模型看到的就是这些数。 */
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

/** 站点用户脚本的公开上限：写进 `browser:user_scripts` 的说明与 schema。 */
export const BrowserUserScriptLimits = Object.freeze({
  /** 一个用户脚本的代码最多多少字节。 */
  codeBytes: 1_000_000,
  /** 一个用户脚本最多几条 match / excludeMatch 规则。 */
  matchRules: 64,
})

/** 抓取远程资源的公开上限：写进 `browser:fetch_resource` 的说明。 */
export const BrowserFetchLimits = Object.freeze({
  /** 单个文件最多下载多少字节（50 MB）。 */
  fileBytes: 52_428_800,
})

/** `browser:extract` 的公开缺省值：写进工具说明，模型不传时按这些数执行。 */
export const BrowserExtractDefaults = Object.freeze({
  /** 页面有多张表格时默认取第几张（从 0 开始）。 */
  tableIndex: 0,
  /** 表格默认最多提取多少行。 */
  tableRows: 200,
  /** 列表默认最多提取多少条。 */
  listItems: 50,
  /** 翻页默认最多翻几页。 */
  paginatePages: 5,
  /** 翻页时每页默认最多提取多少条。 */
  paginateItemsPerPage: 50,
  /** 正文默认最多返回多少字符。 */
  contentChars: 50_000,
})

/**
 * 页面观察的公开上限与缺省：`inspect_page`、`query_elements`、`observe_actions`、
 * `get_page_diagnostics` 与两个网络详情工具的说明和 schema 都引这里，改一处模型看到的跟着变。
 */
export const BrowserInspectLimits = Object.freeze({
  /** 一次检查最多返回多少字符正文。 */
  textChars: 100_000,
  /** 不给 maxTextChars 时返回多少字符正文。 */
  defaultTextChars: 20_000,
  /** 一次检查最多返回多少字符 HTML。 */
  htmlChars: 100_000,
  /** 不给 maxHtmlChars 时返回多少字符 HTML。 */
  defaultHtmlChars: 30_000,
  /** 一次检查最多返回多少个可交互元素。 */
  elements: 400,
  /** 不给 maxElements 时返回多少个可交互元素。 */
  defaultElements: 80,
  /** 一个 CSS selector 最长多少字符。 */
  selectorChars: 1_000,
  /** 一次查询最多返回多少个匹配元素。 */
  queryElements: 100,
  /** 不给 limit 时返回多少个匹配元素。 */
  defaultQueryElements: 20,
  /** 查询时每个元素最多返回多少文本字符。 */
  queryTextChars: 20_000,
  /** 查询时每个元素最多返回多少 HTML 字符。 */
  queryHtmlChars: 50_000,
  /** 一次查询最多额外读几个属性。 */
  queryAttributes: 20,
  /** 一个属性名最长多少字符。 */
  attributeNameChars: 80,
  /** 一次最多给多少个动作候选。 */
  observeCandidates: 80,
  /** 不给 limit 时给多少个动作候选。 */
  defaultObserveCandidates: 20,
  /** 找候选时那句意图最长多少字符。 */
  instructionChars: 500,
  /** 一次最多排除多少个噪音子树 selector。 */
  ignoreSelectors: 50,
  /** 一次最多返回多少条诊断事件。 */
  diagnosticEntries: 300,
  /** 不给 limit 时返回多少条诊断事件。 */
  defaultDiagnosticEntries: 50,
  /** HTTP status 过滤的取值上限。 */
  networkStatus: 999,
  /** resourceType 过滤最长多少字符。 */
  resourceTypeChars: 80,
  /** 一个 requestId 最长多少字符。 */
  requestIdChars: 200,
  /** 响应体一次最多读多少字符。 */
  responseBodyChars: 200_000,
  /** 不给 maxChars / maxBodyChars 时读多少字符响应体。 */
  defaultResponseBodyChars: 20_000,
})

/** 截图与录屏的公开上限与缺省：写进 `capture_screenshot`、`screencast` 的说明与 schema。 */
export const BrowserCaptureLimits = Object.freeze({
  /** 截图保存路径最长多少字符。 */
  pathChars: 180,
  /** 截图视口宽度的下限，像素。 */
  minViewportWidth: 320,
  /** 截图视口宽度的上限，像素。 */
  maxViewportWidth: 3_840,
  /** 截图视口高度的下限，像素。 */
  minViewportHeight: 240,
  /** 截图视口高度的上限，像素。 */
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

/** 性能分析的公开上限与缺省：写进 `browser:performance` 的说明与 schema。 */
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

/** 挂起事件等待的公开上限与缺省：写进 `browser:wait_for_pending_event` 的说明与 schema。 */
export const BrowserPendingEventLimits = Object.freeze({
  /** 等一个挂起事件最多等多少毫秒。 */
  maxWaitMs: 60_000,
  /** 不给 timeoutMs 时等多少毫秒。 */
  defaultWaitMs: 5_000,
})

/** 页面存储与资源清单的公开上限与缺省。 */
export const BrowserPageDataLimits = Object.freeze({
  /** 每类存储一次最多返回多少项。 */
  storageItems: 300,
  /** 不给 limit 时每类返回多少项。 */
  defaultStorageItems: 50,
  /** 每个存储值最多返回多少字符。 */
  storageValueChars: 50_000,
  /** 列页面媒体一次最多返回多少条。 */
  mediaSources: 200,
  /** 不给 limit 时列多少条页面媒体。 */
  defaultMediaSources: 80,
  /** 列页面资源一次最多返回多少条。 */
  pageResources: 500,
  /** 不给 limit 时列多少条页面资源。 */
  defaultPageResources: 120,
})

/** 浏览器包的失败原因码：外面按码判断，不按文案判断。 */
export const BrowserErrorCodes = Object.freeze({
  /** 界面没装浏览器合成 Provider，拿不到受控页面。 */
  compositionNotInstalled: 'BROWSER_COMPOSITION_NOT_INSTALLED',
})
