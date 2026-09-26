declare module 'velaros:devtools' {
  /**
   * 开发者工具：读控制台、网络与未处理异常（从页面打开起一直在录），读一次请求的详情与响应体；调缩放、设常驻的网络规则（断网、请求头、拦截、假响应）；
   * 录性能 trace 看 LCP、INP、CLS 与瓶颈，采堆快照查内存泄漏；录屏合成 GIF；管理进到匹配网站时自动注入的用户脚本。
   * 都作用在 velaros:browser 当前打开的站点上，没进站点时抛 BROWSER_SITE_NOT_OPEN。trace、堆快照、录屏的产物落在站点工作区。
   * 页面存储用 velaros:browser 的 evaluate 读；cookie（含 HttpOnly）、视口、时区、地理位置、深浅色这类仿真直接用 velaros:cdp 发命令。
   */

  /** 读诊断：先按种类过滤再取最近的几条，网络条目带 requestId。
   */
  export function diagnostics(input: DevtoolsDiagnosticsInput): Promise<BrowserPageDiagnosticsReadResult>

  /** 读一次网络请求的请求头、postData、响应头、耗时与体积，可带响应体；较早的请求可能已经读不到。
   */
  export function request(input: DevtoolsRequestInput): Promise<BrowserNetworkRequestDetailsResult>

  /** 调页面缩放。
   */
  export function zoom(input: DevtoolsZoomInput): Promise<BrowserPageZoomResult>

  /** 设常驻的网络规则：断网、加请求头、拦请求、给请求回假响应（宿主一直替你应答，程序跑完也生效，再调一次就换掉）。
   */
  export function network(input: DevtoolsNetworkInput): Promise<BrowserNetworkControlResult>

  /** 开始录性能 trace；到点自动停时直接交回分析摘要。
   */
  export function startTrace(input: DevtoolsTraceInput): Promise<BrowserPerformanceTraceStartResult>

  /** 停止录 trace，交回 Core Web Vitals 与可深入分析的 insight 清单；原始 trace 落在站点工作区。
   */
  export function stopTrace(): Promise<BrowserPerformanceTraceStopResult>

  /** 对最近一次 trace 的一条 insight 出详细分析。
   */
  export function insight(input: DevtoolsInsightInput): Promise<BrowserPerformanceInsightResult>

  /** 采一份 V8 堆快照落盘（按「基线、操作、回退」各采一份对比着查泄漏）。
   */
  export function heapSnapshot(input: DevtoolsHeapSnapshotInput): Promise<BrowserHeapSnapshotResult>

  /** 开始录屏：之后的页面操作都录下来，stopRecording 合成 GIF。
   */
  export function startRecording(input: DevtoolsRecordingInput): Promise<BrowserScreencastStartResult>

  /** 停止录屏并合成 GIF 落进站点工作区（帧数到上限会自动截断，frameLimitReached 为真）。
   */
  export function stopRecording(input: DevtoolsStopRecordingInput): Promise<BrowserScreencastStopResult>

  /** 列出全部用户脚本、总开关，以及哪些脚本匹配当前页面。
   */
  export function userScripts(): Promise<BrowserUserScriptMutationResult>

  /** 读一个用户脚本，带源码。
   */
  export function readUserScript(input: DevtoolsUserScriptIdInput): Promise<BrowserUserScriptMutationResult>

  /** 新建一个用户脚本（一律先停用）。
   */
  export function createUserScript(input: DevtoolsCreateUserScriptInput): Promise<BrowserUserScriptMutationResult>

  /** 改一个用户脚本。
   */
  export function updateUserScript(input: DevtoolsUpdateUserScriptInput): Promise<BrowserUserScriptMutationResult>

  /** 启用或停用一个用户脚本。
   */
  export function enableUserScript(input: DevtoolsEnableUserScriptInput): Promise<BrowserUserScriptMutationResult>

  /** 打开或关闭用户脚本的总开关。
   */
  export function enableUserScripts(input: DevtoolsEnableUserScriptsInput): Promise<BrowserUserScriptMutationResult>

  /** 调整一个用户脚本的注入顺序。
   */
  export function moveUserScript(input: DevtoolsMoveUserScriptInput): Promise<BrowserUserScriptMutationResult>

  /** 删掉一个用户脚本（不撤销当前页面已经执行的副作用）。
   */
  export function deleteUserScript(input: DevtoolsUserScriptIdInput): Promise<BrowserUserScriptMutationResult>

  /**
   * 读诊断：kind 缺省 all；limit 是过滤之后最多几条（最多 300，不给就取到上限），clear 为真读完把这一类清掉。
   * console 可按 level 或 errorsOnly 过滤；network 可按 status（100 到 999）、resourceType（最多 80 个字符）或 failedOnly 过滤，
   * 回执里的 requestId 交给 request 读详情。
   */
  interface DevtoolsDiagnosticsInput {
    kind?: BrowserPageDiagnosticsReadKind
    limit?: number
    clear?: boolean
    level?: BrowserPageDiagnosticLevel
    errorsOnly?: boolean
    status?: number
    resourceType?: string
    failedOnly?: boolean
  }

  /** 读诊断的结果：kind 是 all 时是整份诊断，其余三类各是自己的形状。 */
  type BrowserPageDiagnosticsReadResult =
    | BrowserPageDiagnostics
    | BrowserConsoleEventsResult
    | BrowserNetworkEventsResult
    | BrowserPageErrorsResult

  /** 读一次网络请求的详情：requestId 取自 diagnostics 的网络条目（最多 200 个字符）；includeResponseBody 为真时带上响应体（maxBodyChars 最多 200000，不给就取到上限）。 */
  interface DevtoolsRequestInput {
    requestId: string
    includeResponseBody?: boolean
    maxBodyChars?: number
  }

  /** 一次请求的详情：request、response、failure 与总耗时；responseBody 只在 includeResponseBody 时有。 */
  interface BrowserNetworkRequestDetailsResult {
    url: string
    requestId: string
    request: BrowserNetworkRequestSnapshot
    response: BrowserNetworkResponseSnapshot | null
    failure: BrowserNetworkFailureSnapshot | null
    durationMs: number | null
    responseBody?: BrowserNetworkRequestResponseBodySnapshot
    capturedAt: number
  }

  /** 调页面缩放：action 是 in、out、reset、set；set 要给 zoomFactor（0.25 到 3），in、out 的步长 step 是 0.05 到 0.5。 */
  interface DevtoolsZoomInput {
    action: BrowserPageZoomAction
    zoomFactor?: number
    step?: number
  }

  /** 缩放之后的倍数：zoomFactor 是现在的，previousZoomFactor 是之前的。 */
  interface BrowserPageZoomResult {
    url: string
    zoomFactor: number
    previousZoomFactor: number
    capturedAt: number
  }

  /**
   * 设网络条件，至少给一样：offline 断网；extraHTTPHeaders 加请求头（名最多 120、值最多 4000 个字符）；
   * blockedURLPatterns 拦这些地址（最多 100 条，每条最多 2048 个字符），blockedResourceTypes 拦这些资源类型（最多 32 种）；
   * mockResponses 给匹配的请求直接回一个假响应（最多 50 条，正文最多 1000000 个字符）。
   */
  interface DevtoolsNetworkInput {
    offline?: boolean
    extraHTTPHeaders?: Record<string, string>
    blockedURLPatterns?: string[]
    blockedResourceTypes?: string[]
    mockResponses?: BrowserNetworkMockResponse[]
  }

  /** 网络条件设好之后的全部状态：离线没有、加了哪些请求头、拦了哪些地址与资源类型、挂着哪些假响应。 */
  interface BrowserNetworkControlResult {
    url: string
    offline: boolean
    extraHTTPHeaders: Record<string, string>
    blockedURLPatterns: string[]
    blockedResourceTypes: string[]
    mockResponses: BrowserNetworkMockResponse[]
    capturedAt: number
  }

  /**
   * 开始录性能 trace：reload 缺省 true（先重载，录完整加载）；autoStopMs 是录多久自动停并交回分析（缺省 5000，1000 到 60000），
   * 给 null 就一直录到 stopTrace（录交互时这么用）。
   */
  interface DevtoolsTraceInput {
    reload?: boolean
    autoStopMs?: number | null | undefined
  }

  /** 开始录 trace 的结果：status 是 recording 时还在录（note 说怎么停），是 completed 时已经到点自动停、带着和 stopTrace 一样的分析。 */
  type BrowserPerformanceTraceStartResult =
    | {
        status: 'recording'
        url: string
        startedAt: number
        /** 给模型的操作提示：怎么停、能做什么。 */
        note: string
      }
    | ({ status: 'completed' } & BrowserPerformanceTraceStopResult)

  /**
   * trace 的分析：keyMetrics 是各段的 Core Web Vitals（如 NAVIGATION_0: LCP 258 ms, CLS 0.00），summary 是整体摘要与可深入的 insight 清单，
   * insightSetIds 交给 insight 的 insightSetId；原始 trace 落在 rawTracePath（.json.gz，能拖进 DevTools 的 Performance 面板）。
   */
  interface BrowserPerformanceTraceStopResult {
    url: string
    /** 每个 insight set 的 Core Web Vitals 紧凑摘要（如 `NAVIGATION_0: LCP 258 ms, CLS 0.00`），从完整 summary 里抽出来。 */
    keyMetrics: string
    /** DevTools trace 引擎生成的整体摘要（含 CWV 指标与可用 insight 清单）。 */
    summary: string
    /** 交给 insight 的 insightSetId 列表。 */
    insightSetIds: string[]
    /** 原始 trace 落盘绝对路径（.json.gz，可直接拖进 DevTools Performance 面板）。 */
    rawTracePath: string
    rawTraceRelativePath: string
    durationMs: number
    capturedAt: number
  }

  /** 对最近一次 trace 里的一条 insight 出详细分析：insightSetId 与 insightName 都取自 trace 摘要（各最多 120 个字符）。 */
  interface DevtoolsInsightInput {
    insightSetId: string
    insightName: string
  }

  /** 一条 insight 的详细分析：output 是 DevTools 给的分析文字。 */
  interface BrowserPerformanceInsightResult {
    insightSetId: string
    insightName: string
    output: string
    capturedAt: number
  }

  /** 采一份 V8 堆快照落进站点工作区：path 是相对路径（最多 300 个字符），不给就按时间命名。快照很大，别读进来，交给 memlab 这类工具分析。 */
  interface DevtoolsHeapSnapshotInput {
    path?: string
  }

  /** 堆快照的产物：落在 path，bytes 是大小。 */
  interface BrowserHeapSnapshotResult {
    url: string
    path: string
    relativePath: string
    bytes: number
    capturedAt: number
  }

  /** 开始录屏：maxWidth 是帧宽（240 到 1600，缺省 800），everyNthFrame 是每几帧取一帧（1 到 10，缺省 2）。页面不变不出新帧。 */
  interface DevtoolsRecordingInput {
    maxWidth?: number
    everyNthFrame?: number
  }

  /** 开始录屏的结果：note 说怎么停。 */
  interface BrowserScreencastStartResult {
    url: string
    status: 'recording'
    startedAt: number
    note: string
  }

  /** 停止录屏并合成 GIF：name 是产物名（最多 60 个字符），不给就按时间命名。 */
  interface DevtoolsStopRecordingInput {
    name?: string
  }

  /** 录屏的产物：GIF 落在 path（relativePath 是工作区里的相对路径），frameCount 是几帧，frameLimitReached 为真表示到帧数上限被截断。 */
  interface BrowserScreencastStopResult {
    url: string
    /** GIF 落盘绝对路径。 */
    path: string
    relativePath: string
    frameCount: number
    durationMs: number
    bytes: number
    /** 达到帧数上限被自动截断。 */
    frameLimitReached: boolean
    capturedAt: number
  }

  /**
   * 用户脚本操作的结果：overview 是操作之后的一览，script 是这次操作的那个脚本，code 是 readUserScript 读到的源码，run 是 runUserScript 的结果，refreshRequired 为真表示要刷新页面才能去掉已经执行过的效果。
   */
  interface BrowserUserScriptMutationResult {
    overview: BrowserUserScriptOverview
    script?: BrowserUserScriptRecord | null | undefined
    code?: string | null | undefined
    run?: BrowserUserScriptLastRun | null | undefined
    /** 禁用脚本不会撤销已执行的页面副作用；需要刷新页面才能得到干净文档。 */
    refreshRequired?: boolean | null | undefined
  }

  /** 指定一个用户脚本。 */
  interface DevtoolsUserScriptIdInput {
    id: string
  }

  /**
   * 新建一个用户脚本（进到匹配的网站时自动注入的 JavaScript）：name 最多 120 个字符，code 最多 1000000 字节；
   * match、excludeMatch 是网址规则（如 https://example.com/*，各最多 64 条、每条最多 500 个字符，只认 http 与 https），
   * runAt 缺省 document-idle，world 缺省 isolated（只有要碰页面自己的 JavaScript 对象时才用 main）。
   * 新建的脚本一律停用：先把 name、match、world、runAt 讲给用户，用户明确同意后再 enableUserScript。
   */
  interface DevtoolsCreateUserScriptInput {
    name: string
    code: string
    description?: string
    version?: string
    match: string[]
    excludeMatch?: string[]
    runAt?: BrowserUserScriptRunAt
    world?: BrowserUserScriptWorld
  }

  /** 改一个用户脚本，至少改一样；改了代码或执行范围之后脚本自动停用，要用户重新确认后再启用。上限同 createUserScript。 */
  interface DevtoolsUpdateUserScriptInput {
    id: string
    name?: string
    code?: string
    description?: string
    version?: string
    match?: string[]
    excludeMatch?: string[]
    runAt?: BrowserUserScriptRunAt
    world?: BrowserUserScriptWorld
  }

  /** 启用或停用一个用户脚本；未经用户明确同意不要启用。停用不会撤销当前页面已经执行的副作用，要刷新页面。 */
  interface DevtoolsEnableUserScriptInput {
    id: string
    enabled: boolean
  }

  /** 用户脚本的总开关：为假时所有脚本都不注入。 */
  interface DevtoolsEnableUserScriptsInput {
    enabled: boolean
  }

  /** 调整注入顺序：把一个脚本往前（up）或往后（down）挪一位，越靠前越先执行。 */
  interface DevtoolsMoveUserScriptInput {
    id: string
    direction: 'up' | 'down'
  }

  /** 读哪一类诊断：all 全部、console 控制台、network 网络请求、page_error 未处理的异常。 */
  type BrowserPageDiagnosticsReadKind = 'all' | 'console' | 'network' | 'page_error'

  /** 诊断的级别：debug、info、warning、error。 */
  type BrowserPageDiagnosticLevel = 'debug' | 'info' | 'warning' | 'error'

  /** 整份诊断：entries 是最近的条目（先按种类过滤再取窗口），summary 是计数，networkCaptureNotice 在网络采集这次才开始时出现。 */
  interface BrowserPageDiagnostics {
    url: string
    title: string | null
    entries: BrowserPageDiagnosticEntry[]
    summary: BrowserPageDiagnosticsSummary
    /**
     * 网络采集的如实说明：内嵌页面的采集是读诊断时才建立的，这次才开始时要告诉模型
     * 「之前的请求没有记录」，采集没能建立时要说清原因。没有要说的就不给这个字段。
     */
    networkCaptureNotice?: BrowserNetworkCaptureNotice
    capturedAt: number
  }

  /** console 诊断：entries 是过滤后的条目，consoleTotal 是缓冲里 console 条目一共几条。 */
  interface BrowserConsoleEventsResult {
    url: string
    title: string | null
    entries: BrowserPageDiagnosticEntry[]
    summary: BrowserPageDiagnosticsSummary
    filters: BrowserConsoleEventFilters
    diagnosticTotal: number
    consoleTotal: number
  }

  /** 网络诊断：entries 带 requestId（交给 request 读详情）；networkCaptureNotice 在网络采集这次才开始时说明之前的请求看不到。 */
  interface BrowserNetworkEventsResult {
    url: string
    title: string | null
    entries: BrowserPageDiagnosticEntry[]
    summary: BrowserPageDiagnosticsSummary
    filters: BrowserNetworkEventFilters
    diagnosticTotal: number
    networkTotal: number
    networkCaptureNotice: string | null
  }

  /** 未处理异常的诊断。 */
  interface BrowserPageErrorsResult {
    url: string
    title: string | null
    entries: BrowserPageDiagnosticEntry[]
    summary: BrowserPageDiagnosticsSummary
    diagnosticTotal: number
    pageErrorTotal: number
  }

  /** 请求：method、url、headers、postData、resourceType 与发出的时间。 */
  interface BrowserNetworkRequestSnapshot {
    method: string
    url: string
    headers: Record<string, string>
    postData?: string
    resourceType: string
    timestamp: number | null
    wallTime: number | null
  }

  /** 响应：status、statusText、headers、mimeType、协议，是不是来自缓存或 Service Worker，体积与对端地址，timing 是各阶段耗时。 */
  interface BrowserNetworkResponseSnapshot {
    status: number
    statusText: string
    headers: Record<string, string>
    mimeType: string | null
    protocol: string | null
    fromDiskCache: boolean
    fromServiceWorker: boolean
    encodedDataLength: number | null
    remoteIPAddress: string | null
    remotePort: number | null
    timing: Record<string, unknown> | null
  }

  /** 请求失败：errorText 是原因，canceled 为真表示被取消。 */
  interface BrowserNetworkFailureSnapshot {
    errorText: string
    canceled: boolean
  }

  /** 响应体：body 是内容（base64Encoded 为真时是 base64），bodyLength 是原长，bodyTruncated 为真表示只交回了一部分。 */
  interface BrowserNetworkRequestResponseBodySnapshot {
    body: string
    base64Encoded: boolean
    bodyLength: number
    returnedChars: number
    bodyTruncated: boolean
  }

  /** 缩放动作：in 放大、out 缩小、reset 还原、set 设成指定倍数。 */
  type BrowserPageZoomAction = 'in' | 'out' | 'reset' | 'set'

  /** 一条假响应：urlPattern 匹配的请求直接回这里的 status（缺省 200）、contentType、body 与 headers，不再发到服务器。 */
  interface BrowserNetworkMockResponse {
    urlPattern: string
    status?: number
    contentType?: string
    body?: string
    headers?: Record<string, string>
  }

  /** 用户脚本一览：globalEnabled 是总开关，scripts 是全部脚本，matchedScriptIds 是匹配当前页面的那几个。 */
  interface BrowserUserScriptOverview {
    browserContext: BrowserSiteContext
    globalEnabled: boolean
    scripts: BrowserUserScriptRecord[]
    /** 匹配当前页面的脚本 id（按宿主的匹配规则针对 browserContext.url 算出）。 */
    matchedScriptIds: string[]
  }

  /** 一个用户脚本：id、name、match 与 excludeMatch 是网址规则，runAt、world 是注入时机与环境，enabled 是启没启用，position 是注入顺序（越小越先），lastRun 是最近一次运行。 */
  interface BrowserUserScriptRecord {
    id: string
    name: string
    description?: string | null | undefined
    version: string
    /** 宿主维护的执行修订号，用于 document + revision 幂等注入。 */
    revision: number
    /** 注入顺序，数字越小越先执行。 */
    position: number
    match: string[]
    excludeMatch?: string[] | null | undefined
    runAt: BrowserUserScriptRunAt
    world: BrowserUserScriptWorld
    enabled: boolean
    source: BrowserUserScriptSource
    relativePath: string
    createdAt: number
    updatedAt: number
    lastRun?: BrowserUserScriptLastRun | null | undefined
  }

  /** 用户脚本最近一次自动注入或手动运行：在哪个页面（url）、第几版脚本（scriptRevision）、结果与出错信息。 */
  interface BrowserUserScriptLastRun {
    status: BrowserUserScriptRunStatus
    url: string
    documentId: string
    scriptRevision: number
    startedAt: number
    finishedAt: number
    error?: string | null | undefined
  }

  /** 用户脚本在页面加载的哪个时机注入：document-start、document-end、document-idle。 */
  type BrowserUserScriptRunAt = 'document-start' | 'document-end' | 'document-idle'

  /** 用户脚本跑在哪：isolated 是隔离环境（缺省，碰不到页面自己的 JavaScript 对象），main 是页面自己的环境。 */
  type BrowserUserScriptWorld = 'isolated' | 'main'

  /**
   * 一条诊断：message 是内容，url、line、column 是出处，code 是 HTTP 状态这类数字；网络条目的 details 里有 requestId（交给 request 读详情）、method、status、resourceType。
   */
  interface BrowserPageDiagnosticEntry {
    kind: BrowserPageDiagnosticKind
    level: BrowserPageDiagnosticLevel
    message: string
    url: string | null
    line: number | null
    column: number | null
    code: number | null
    capturedAt: number
    details?: Record<string, unknown>
  }

  /** 诊断的计数：按级别、种类、来源、HTTP 状态、资源类型各数了几条。 */
  interface BrowserPageDiagnosticsSummary {
    total: number
    byLevel: Record<string, number>
    byKind: Record<string, number>
    byOrigin: Record<string, number>
    byStatus: Record<string, number>
    byResourceType: Record<string, number>
  }

  /** 网络采集的说明：这次才开始采集时告诉你之前的请求没有记录，采集没能开始时说原因。 */
  type BrowserNetworkCaptureNotice = string | null | undefined

  /** console 这一类的过滤条件。 */
  interface BrowserConsoleEventFilters {
    level: BrowserPageDiagnosticLevel | null
    errorsOnly: boolean
  }

  /** network 这一类的过滤条件。 */
  interface BrowserNetworkEventFilters {
    status: number | null
    resourceType: string | null
    failedOnly: boolean
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

  /** 用户脚本是谁建的：agent（你建的）、user、user-import。 */
  type BrowserUserScriptSource = 'agent' | 'user' | 'user-import'

  /** 一次注入或运行的结果：success、error、unsupported（当前后端做不到，比如外部浏览器）。 */
  type BrowserUserScriptRunStatus = 'success' | 'error' | 'unsupported'

  /** 诊断的种类：console、page-error（未处理的异常）、load-error、render-process-gone、download、popup、permission、dialog、network、storage。 */
  type BrowserPageDiagnosticKind =
    | 'console'
    | 'page-error'
    | 'load-error'
    | 'render-process-gone'
    | 'download'
    | 'popup'
    | 'permission'
    | 'dialog'
    | 'network'
    | 'storage'
}
