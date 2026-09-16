/**
 * 包内可调参数：超时、缓冲、保留条数、缺省条数、阈值。都是取舍，没有唯一正确的值；要调就改这一个文件，全包跟着变。
 *
 * 常量按四处放（ADR 0007）：
 * - 对外承诺的（工具名、错误码、写进工具说明和 schema 的上限）在 `contract/constants.ts`，改了等于改契约；
 * - 可调的都在这里，按用途分组、每项一句说明；实现里不再散写数字缺省值，门禁核对；
 * - 某个类里固定用的文案、模式、名单写成那个类的 `private static readonly`；
 * - 规则本身的数据（节流预设的带宽与时延、自愈权重）跟着规则写在各自的文件里；算法与格式里的数字就地写。
 */

/** 浏览器包的可调参数，按用途分组。 */
export const BrowserTuning = Object.freeze({
  /** 会话：动作队列、挂起事件、用户活动、回合上下文。 */
  session: Object.freeze({
    /** 单个动作独占一条会话队列的上限，毫秒；到点放行队伍，动作本身仍挂着。最后一道网，不是主超时。 */
    actionHoldCapMs: 150_000,
    /** 用户最近一次手动操作之后，多少毫秒之内仍算「用户正在操作」，agent 的动作要让路。 */
    userIdleWindowMs: 1_200,
    /** 弹窗（JS dialog）没人处理时，多少毫秒后按「取消」结算。 */
    dialogTimeoutMs: 30_000,
    /** 权限请求没人处理时，多少毫秒后按「拒绝」结算。 */
    permissionTimeoutMs: 15_000,
    /** 下载没人处理时，多少毫秒后按「取消」结算。 */
    downloadTimeoutMs: 60_000,
    /** 回合上下文里「最近的导航错误」往回看多少毫秒；再早的不再提示模型。 */
    recentErrorWindowMs: 300_000,
    /** 等会话的 WebContents attach 完成的缺省毫秒数。 */
    attachTimeoutMs: 5_000,
    /** 等一个挂起事件出现的缺省毫秒数；模型没给 timeoutMs 时用它。 */
    pendingEventWaitTimeoutMs: 5_000,
    /** 等挂起事件时的轮询间隔毫秒数。 */
    pendingEventPollIntervalMs: 50,
  }),
  /** CDP 协议层：命令超时、诊断与网络记录保留条数、trace 传输。 */
  cdp: Object.freeze({
    /** 一条 CDP 命令等回包的毫秒数；超时按失败返回，不留悬挂的 promise。 */
    commandTimeoutMs: 10_000,
    /** 外部 CDP 页面的诊断缓冲最多留多少条，超过从最早的挤掉。 */
    diagnosticEntries: 300,
    /** 网络请求明细最多留多少条（按 requestId 读详情时的缓存）。 */
    networkRequestRecords: 300,
    /** 内嵌页面的网络诊断最多留多少条。 */
    embeddedNetworkDiagnostics: 300,
    /** 无 Electron 的 CDP 运行时里，诊断缓冲最多留多少条。 */
    runtimeDiagnosticEntries: 300,
    /** 读 trace 数据流时每次取多少字节。 */
    traceStreamChunkBytes: 1_048_576,
    /** 停止 trace 后等它落完的毫秒数。 */
    traceCompleteTimeoutMs: 30_000,
  }),
  /** 外部浏览器：拉起 Chrome、等它把调试端口写出来。 */
  externalBrowser: Object.freeze({
    /** 等外部浏览器可连接的总毫秒数。 */
    launchTimeoutMs: 30_000,
    /** 轮询 DevToolsActivePort 的间隔毫秒数。 */
    pollIntervalMs: 50,
    /** 启动失败重试几次。 */
    launchMaxAttempts: 3,
    /** 两次启动尝试之间等多少毫秒。 */
    launchRetryDelayMs: 500,
    /** 启动失败时回报浏览器 stderr 的末尾多少行。 */
    stderrMaxLines: 20,
  }),
  /** 截图：给模型的图、整页图、预览流、稳定等待。 */
  screenshot: Object.freeze({
    /** 给模型的图的字节预算；超了就按质量阶梯降质重编。 */
    modelImageByteBudget: 96_000,
    /** 给模型的图的宽度上限，像素。 */
    modelImageMaxWidth: 1_280,
    /** 给模型的图的高度上限，像素。 */
    modelImageMaxHeight: 900,
    /** 给模型的图的初始 JPEG 质量。 */
    modelImageQuality: 72,
    /** 整页截图的宽度上限，像素。 */
    fullPageMaxWidth: 10_000,
    /** 整页截图的高度上限，像素。 */
    fullPageMaxHeight: 16_000,
    /** 元素标注最多标几个，超过的不画框。 */
    elementLabelLimit: 40,
    /** 宿主预览帧的宽度上限，像素。 */
    previewMaxWidth: 720,
    /** 宿主预览帧的 JPEG 质量。 */
    previewJpegQuality: 68,
    /** 预览帧流的宽度上限，像素。 */
    previewStreamMaxWidth: 960,
    /** 预览帧流的高度上限，像素。 */
    previewStreamMaxHeight: 1_600,
    /** 截图前等网络空闲的缺省毫秒数。 */
    networkIdleMs: 700,
    /** 判 DOM 稳定要连续多少帧没有变化。 */
    domStableFrames: 5,
    /** 判 DOM 稳定的取样间隔毫秒数。 */
    domStableSampleIntervalMs: 80,
    /** 等 DOM 稳定最多等多少毫秒。 */
    domStableMaxWaitMs: 2_500,
  }),
  /** 受控弹窗：被接管的 window.open 与命名窗口。 */
  popup: Object.freeze({
    /** 一次弹窗引导的有效毫秒数，过期就不再接管。 */
    bootstrapLifetimeMs: 30_000,
    /** 弹窗引导失败后重试的间隔毫秒数。 */
    bootstrapRetryDelayMs: 250,
    /** 一个会话里同时最多留几个弹窗引导。 */
    maxBootstrapsPerSession: 4,
    /** 命名弹窗的缺省宽度，像素。 */
    width: 900,
    /** 命名弹窗的缺省高度，像素。 */
    height: 700,
    /** 命名弹窗的最小宽度，像素。 */
    minWidth: 480,
    /** 命名弹窗的最小高度，像素。 */
    minHeight: 320,
    /** 命名弹窗的最大宽度，像素。 */
    maxWidth: 1_600,
    /** 命名弹窗的最大高度，像素。 */
    maxHeight: 1_200,
  }),
  /** 页面观察与动作：检查、自愈、等待。 */
  page: Object.freeze({
    /** 内嵌浏览器的缺省视口宽度，像素。 */
    viewportWidth: 1_365,
    /** 内嵌浏览器的缺省视口高度，像素。 */
    viewportHeight: 768,
    /** 检查页面时缺省取多少字符正文。 */
    inspectTextChars: 20_000,
    /** 检查页面时缺省取多少字符 HTML。 */
    inspectHtmlChars: 30_000,
    /** 检查页面时缺省取多少个可交互元素。 */
    inspectElements: 80,
    /** 找动作候选时重读页面取多少字符正文（只用来认元素，不整份给模型）。 */
    observeTextChars: 2_000,
    /** 找动作候选时至少取多少个可交互元素；limit 大时按 limit 的四倍取。 */
    observeMinElements: 80,
    /** 点击没命中后为自愈重读页面时取多少字符正文（只用来认元素，不给模型）。 */
    selfHealTextChars: 2_000,
    /** 自愈重读时取多少字符 HTML。 */
    selfHealHtmlChars: 1_000,
    /** 自愈重读时取多少个可交互元素。 */
    selfHealElements: 120,
    /** 动作效果指纹取页面前多少行文本做对比。 */
    actionEffectSampleLines: 200,
    /** 坐标拖拽把整段路径切成多少步发出去。 */
    dragSteps: 10,
    /** 目标高亮框在页面上停留多少毫秒。 */
    highlightDurationMs: 1_600,
    /** 等页面网络空闲：多少毫秒没有新请求就算空闲。 */
    networkIdleMs: 500,
    /** 等页面网络空闲最多等多少毫秒。 */
    networkIdleTimeoutMs: 5_000,
    /**
     * 在内嵌页面里求值的兜底期限毫秒数：渲染进程不回话时，主进程自己收口，不让 await 永远挂着。
     *
     * 判据取「队列里最长的合法页内脚本是等待族（钳到 60 秒），加上注入与序列化余量」；越过它只可能是渲染进程不会再回话了。
     */
    evaluateDeadlineMs: 90_000,
  }),
  /** 提取：结构化提取与正文提取的页内超时。 */
  extraction: Object.freeze({
    /** 表格 / 列表提取的页内求值超时毫秒数。 */
    structuredTimeoutMs: 10_000,
    /** 正文提取的页内求值超时毫秒数（正文脚本要遍历整篇文档，给得更宽）。 */
    contentTimeoutMs: 15_000,
    /** 翻页提取里「下一页存在吗」这一小段判定脚本的求值超时毫秒数。 */
    paginateProbeTimeoutMs: 5_000,
    /** 翻页提取点完下一页之后等页面换内容的毫秒数。 */
    paginateSettleMs: 1_200,
    /** recipe 的提取步骤缺省取多少行表格。 */
    recipeTableRows: 200,
    /** recipe 的提取步骤缺省取多少条列表项。 */
    recipeListItems: 50,
    /** recipe 的检查步骤缺省取多少字符正文。 */
    recipeInspectTextChars: 20_000,
  }),
  /** 录屏：帧间隔与合成。 */
  screencast: Object.freeze({
    /** 两帧之间的最小间隔毫秒数，低于它按这个算，避免 GIF 播得过快。 */
    minFrameDelayMs: 30,
    /** 两帧之间的最大间隔毫秒数，页面长时间不动时按这个截断。 */
    maxFrameDelayMs: 2_000,
    /** 末帧停留多少毫秒再循环。 */
    lastFrameDelayMs: 800,
    /** 采帧的缺省 JPEG 质量。 */
    frameQuality: 60,
    /** 合成 GIF 的缺省宽度上限，像素。 */
    gifMaxWidth: 800,
  }),
  /** 列表缺省：工作区文件与页面资源。 */
  lists: Object.freeze({
    /** 列工作区文件缺省返回多少条。 */
    workspaceFiles: 200,
    /** 递归列工作区文件缺省往下走几层。 */
    workspaceDepth: 4,
    /** 列产物目录时往下走几层。 */
    artifactDepth: 4,
    /** 列页面媒体缺省返回多少条。 */
    mediaSources: 80,
    /** 导出页面媒体或资源清单时一次取多少条。 */
    exportMediaSources: 120,
  }),
  /** 性能：trace 与 insight。 */
  performance: Object.freeze({
    /** 没给 autoStopMs 时，trace 录多少毫秒自动停。 */
    traceAutoStopMs: 5_000,
    /** 录 trace 前重载页面后，等多少毫秒没有新请求就算空闲。 */
    reloadNetworkIdleMs: 800,
    /** 录 trace 前重载页面后，等网络空闲最多等多少毫秒。 */
    reloadNetworkIdleTimeoutMs: 10_000,
  }),
  /** 诊断：宿主侧记录器的保留条数。 */
  diagnostics: Object.freeze({
    /** 内嵌页面的诊断记录最多留多少条。 */
    maxEntries: 300,
  }),
  /** recipe：读三类产物文件时各自最多读多少字符。 */
  recipes: Object.freeze({
    /** 读一份 recipe 骨架最多读多少字符；超过就不是骨架而是别的东西了。 */
    skeletonReadChars: 200_000,
    /** 读一份页面快照或运行记录最多读多少字符（它们比骨架大得多）。 */
    snapshotReadChars: 500_000,
  }),
})
