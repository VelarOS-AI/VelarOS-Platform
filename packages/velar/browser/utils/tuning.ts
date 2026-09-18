/**
 * 包内可调参数：超时、缓冲、保留条数、缺省条数、阈值。都是取舍，没有唯一正确的值；要调就改这一个文件，全包跟着变。
 *
 * 常量按四处放（ADR 0007）：
 * - 对外承诺的（错误码、写进声明的上限）在 `contract/constants.ts`，改了等于改契约；
 * - 可调的都在这里，按用途分组、每项一句说明；实现里不再散写数字缺省值，门禁核对；
 * - 某个类里固定用的文案、模式、名单写成那个类的 `private static readonly`；
 * - 规则本身的数据（比如自愈权重）跟着规则写在各自的文件里；算法与格式里的数字就地写。
 */

/** 浏览器包的可调参数，按用途分组。 */
export const BrowserTuning = Object.freeze({
  /** 入参核对：一次报错最多点名几处不对。 */
  input: Object.freeze({
    /** 入参不对时 message 里最多列几条问题。 */
    reportedIssues: 5,
  }),
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
    /** 等挂起事件时的轮询间隔毫秒数。 */
    pendingEventPollIntervalMs: 50,
  }),
  /** 宿主轮询的等待：页面判定式。 */
  wait: Object.freeze({
    /** 判定式每一拍在页面里最多跑多少毫秒；跳转途中那一拍拿不到回话，靠它尽快进下一拍。 */
    conditionTickTimeoutMs: 5_000,
  }),
  /** 模型自己那条 CDP 会话：命令超时、读事件、兜住没人放行的拦截。 */
  protocol: Object.freeze({
    /** 一条命令最多等多少毫秒回话；模型的命令可能要等页面里的 Promise（awaitPromise），给得比宿主自己的宽。 */
    commandTimeoutMs: 60_000,
    /** 等事件时读缓冲的间隔毫秒数。 */
    eventPollIntervalMs: 50,
    /** 检查被拦下的请求有没有超时没人放行的间隔毫秒数。 */
    pausedRequestSweepMs: 1_000,
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
  /** 列表缺省：工作区文件。 */
  lists: Object.freeze({
    /** 列工作区文件缺省返回多少条。 */
    workspaceFiles: 200,
    /** 递归列工作区文件缺省往下走几层。 */
    workspaceDepth: 4,
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
  /** Electron：内嵌页面这条路上的平台常量。 */
  electron: Object.freeze({
    /** Electron 在「导航被新导航打断」时给的错误码；判定按这个码走，不按文案。 */
    navigationAbortErrorCode: -3,
  }),
  /** 诊断：内嵌页面的诊断记录保留量。 */
  diagnostics: Object.freeze({
    /** 内嵌页面的诊断记录最多留多少条。 */
    maxEntries: 300,
  }),
})
