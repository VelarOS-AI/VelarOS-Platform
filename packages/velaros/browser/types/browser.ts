/**
 * 浏览器产品配置的两个闭集。
 *
 * 运行期清单 / 出厂默认 / 宽容守卫全在 `BrowserConfigDefaults.ts`——加一个引擎只改那一处，
 * 这里的联合类型跟着它 `satisfies` 咬合。宿主（Desktop 的持久层 schema、Normalizer、IPC 契约）
 * 一律消费导出的清单与守卫，不再各写一份字面量。
 */
/** 浏览器页面的轻量状态快照。 */
export interface BrowserScreenshotPolicyOptions extends BrowserCaptureScreenshotOptions {
  /**
   * 面向模型的截图会额外携带压缩后的标记图片，用作供应商输入。
   * 保存到磁盘的制品路径仍指向干净的原始截图。
   */
  modelFacing?: boolean
}

export interface BrowserScreenshotPolicyDefaults {
  compareWithPrevious?: boolean
  fullPage?: BrowserCaptureScreenshotOptions['fullPage']
  includeModelImage?: BrowserCaptureScreenshotOptions['includeModelImage']
  modelFacing?: boolean
  path?: string
  waitForDomStable?: BrowserCaptureScreenshotOptions['waitForDomStable']
  waitForNetworkIdle?: BrowserCaptureScreenshotOptions['waitForNetworkIdle']
}

export interface BrowserActionPolicyRequest {
  action: string
  aliases?: readonly string[]
  label?: string
}

export type BrowserActionPolicyDecisionKind = 'allow' | 'deny'

export interface BrowserActionPolicyDecision {
  kind: BrowserActionPolicyDecisionKind
  action: string
  matchedAction: Nullable<string>
  reason: Nullable<string>
}

/**
 * @AgentView
 * 页面状态：url、title，loadState 是最近一次加载成没成（loaded、error、unknown），viewport 是用 setViewport 设过的视口（没设是 null），lastNavigationError 是最近一次导航失败的详情。
 */
export interface BrowserPageState {
  /** 当前 URL。 */
  url: string
  /** 当前 document.title。 */
  title: string
  /** 最近一次加载是否成功。 */
  loadState: 'loaded' | 'error' | 'unknown'
  /** 模型显式设置的 CSS viewport。 */
  viewport: Nullable<BrowserViewportOptions>
  /** 最近一次导航失败详情；成功或未知时为 null。 */
  lastNavigationError: LooseOptional<{
    url: string
    errorCode: number
    errorDescription: string
    failedAt: number
  }>
}

export type BrowserSearchEngineId = 'google' | 'bing'

export interface BrowserActionPolicyConfig {
  /** 没有命中 allow/deny 时的默认策略。 */
  default?: LooseOptional<'allow' | 'deny'>
  /** 允许的动作类别。非空时未列入动作默认拒绝，除非 default=allow。 */
  allow?: LooseOptional<string[]>
  /** 拒绝的动作类别；优先级高于 allow。 */
  deny?: LooseOptional<string[]>
}

/** @AgentView 站点：url 是进站时的地址，workspaceRoot 是这个站点的工作区（截图、下载、PDF 都落在这里），legacyWorkspaceRoots 是只读的旧工作区（读不到时依次往回找）。 */
export interface BrowserSiteContext {
  url: string
  /** 站点工作区根：写入的唯一落点（粒度由宿主定）。 */
  workspaceRoot: string
  /**
   * 只读的历史工作区根（换粒度前留下的资产），按新到旧排列：写只写 workspaceRoot，读不到才依次回退。
   * 不做一次性搬迁——回退读是幂等的，用户每碰一次旧资产就自然继续可用，新写入自动落到新位置。
   */
  legacyWorkspaceRoots?: readonly string[]
}

/** 每回合浏览器上下文快照里的 pending 阻塞事件计数。 */
export interface BrowserTurnContextPendingEvents {
  dialog: number
  download: number
  permission: number
}

/**
 * 每回合浏览器上下文快照。
 *
 * 只允许来自主进程事件驱动的缓存态（session URL/标题/导航错误/pending 事件/诊断计数），
 * 严禁做 CDP 往返或页面脚本求值——该快照挂在消息发送路径上，不能引入可感知延迟。
 */
export interface BrowserTurnContextSnapshot {
  url: Nullable<string>
  title: Nullable<string>
  loadState: 'loaded' | 'error' | 'unknown'
  lastNavigationError: Nullable<{
    url: string
    errorCode: number
    errorDescription: string
  }>
  /** 受控页面当前是否展示在 UI 中。 */
  visible: boolean
  /** 模型显式设置的 CSS viewport。 */
  viewport: Nullable<BrowserViewportOptions>
  pendingEvents: BrowserTurnContextPendingEvents
  /** 最近窗口期内的 console/page error 级诊断条数。 */
  recentErrorCount: number
  capturedAt: number
}

export interface BrowserTurnContextSourcePeekInput {
  sessionId: string
  afterSeq: number
  generation: Nullable<string>
}

export interface BrowserTurnContextSourcePeekResult {
  generation: string
  headSeq: number
  tailSeq: number
  droppedBeforeSeq?: number
  deltas: Array<{
    id: string
    sourceId: string
    seq: number
    occurredAt: number
    label: string
    summaryText: string
    inspect?: {
      tool: string
      argsHint?: Record<string, unknown>
    }
  }>
  anchors: Array<{
    sourceId: string
    key: string
    text: string
  }>
}

export type BrowserUserActivityKind =
  | 'click'
  | 'keyboard'
  | 'scroll'
  | 'input'
  | 'navigation'
  | 'dialog'
  | 'download'
  | 'permission'
  | 'focus'
  | 'unknown'

export interface BrowserUserActivityEvent {
  sessionId: string
  kind: BrowserUserActivityKind
  url?: LooseOptional<string>
  occurredAt?: LooseOptional<number>
  detail?: LooseOptional<string>
}

export interface BrowserNavigationHistoryEntry {
  url: string
  title?: LooseOptional<string>
  pageState?: LooseOptional<string>
}

export interface BrowserNavigationHistoryRestore {
  entries: BrowserNavigationHistoryEntry[]
  index?: number
}

/** @AgentView 用户脚本在页面加载的哪个时机注入：document-start、document-end、document-idle。 */
export type BrowserUserScriptRunAt = 'document-start' | 'document-end' | 'document-idle'
/** @AgentView 用户脚本跑在哪：isolated 是隔离环境（缺省，碰不到页面自己的 JavaScript 对象），main 是页面自己的环境。 */
export type BrowserUserScriptWorld = 'isolated' | 'main'
/** @AgentView 用户脚本是谁建的：agent（你建的）、user、user-import。 */
export type BrowserUserScriptSource = 'agent' | 'user' | 'user-import'
/** @AgentView 一次注入或运行的结果：success、error、unsupported（当前后端做不到，比如外部浏览器）。 */
export type BrowserUserScriptRunStatus = 'success' | 'error' | 'unsupported'

/** @AgentView 用户脚本最近一次自动注入或手动运行：在哪个页面（url）、第几版脚本（scriptRevision）、结果与出错信息。 */
export interface BrowserUserScriptLastRun {
  status: BrowserUserScriptRunStatus
  url: string
  documentId: string
  scriptRevision: number
  startedAt: number
  finishedAt: number
  error?: LooseOptional<string>
}

/** @AgentView 一个用户脚本：id、name、match 与 excludeMatch 是网址规则，runAt、world 是注入时机与环境，enabled 是启没启用，position 是注入顺序（越小越先），lastRun 是最近一次运行。 */
export interface BrowserUserScriptRecord {
  id: string
  name: string
  description?: LooseOptional<string>
  version: string
  /** 宿主维护的执行修订号，用于 document + revision 幂等注入。 */
  revision: number
  /** 注入顺序，数字越小越先执行。 */
  position: number
  match: string[]
  excludeMatch?: LooseOptional<string[]>
  runAt: BrowserUserScriptRunAt
  world: BrowserUserScriptWorld
  enabled: boolean
  source: BrowserUserScriptSource
  relativePath: string
  createdAt: number
  updatedAt: number
  lastRun?: LooseOptional<BrowserUserScriptLastRun>
}

/** @AgentView 用户脚本一览：globalEnabled 是总开关，scripts 是全部脚本，matchedScriptIds 是匹配当前页面的那几个。 */
export interface BrowserUserScriptOverview {
  browserContext: BrowserSiteContext
  globalEnabled: boolean
  scripts: BrowserUserScriptRecord[]
  /** 匹配当前页面的脚本 id（按宿主的匹配规则针对 browserContext.url 算出）。 */
  matchedScriptIds: string[]
}

export interface BrowserUserScriptDraft {
  name: string
  code: string
  description?: LooseOptional<string>
  version?: LooseOptional<string>
  match: string[]
  excludeMatch?: LooseOptional<string[]>
  runAt?: LooseOptional<BrowserUserScriptRunAt>
  world?: LooseOptional<BrowserUserScriptWorld>
  enabled?: LooseOptional<boolean>
  source?: LooseOptional<BrowserUserScriptSource>
}

export interface BrowserUserScriptPatch {
  name?: LooseOptional<string>
  code?: LooseOptional<string>
  description?: LooseOptional<string>
  version?: LooseOptional<string>
  match?: LooseOptional<string[]>
  excludeMatch?: LooseOptional<string[]>
  runAt?: LooseOptional<BrowserUserScriptRunAt>
  world?: LooseOptional<BrowserUserScriptWorld>
}

export type BrowserUserScriptManageRequest =
  | { action: 'list' }
  | { action: 'read'; id: string }
  | { action: 'create'; script: BrowserUserScriptDraft }
  | { action: 'update'; id: string; patch: BrowserUserScriptPatch }
  | { action: 'set_enabled'; id: string; enabled: boolean }
  | { action: 'set_global_enabled'; enabled: boolean }
  | { action: 'move'; id: string; direction: 'up' | 'down' }
  | { action: 'delete'; id: string }
  | { action: 'run_now'; id: string }

/**
 * @AgentView
 * 用户脚本操作的结果：overview 是操作之后的一览，script 是这次操作的那个脚本，code 是 readUserScript 读到的源码，run 是 runUserScript 的结果，refreshRequired 为真表示要刷新页面才能去掉已经执行过的效果。
 */
export interface BrowserUserScriptMutationResult {
  overview: BrowserUserScriptOverview
  script?: LooseOptional<BrowserUserScriptRecord>
  code?: LooseOptional<string>
  run?: LooseOptional<BrowserUserScriptLastRun>
  /** 禁用脚本不会撤销已执行的页面副作用；需要刷新页面才能得到干净文档。 */
  refreshRequired?: LooseOptional<boolean>
}

/** @AgentView 页面上的一个标题：level 是级别（1 最高）。 */
export interface BrowserPageHeading {
  level: number
  text: string
}

/** @AgentView 元素所在的同源 iframe：css、name、title、url 用来找到那个 iframe。 */
export interface BrowserElementFrameHint {
  css: Nullable<string>
  name: Nullable<string>
  title: Nullable<string>
  url: Nullable<string>
}

/**
 * @AgentView
 * 定位一个元素的线索（inspect、query、截图给的）：ref 是这次观察的引用（如 @e3:g2，新的一次 inspect 或标注截图之后作废），另有 css、role、text、name、attributes 与 frame。原样交给 click 这类操作就行。
 */
export interface BrowserElementTargetHint {
  /** 来自一次页面 snapshot/inspection 的 generation 引用，如 @e3:g2；只对原 observation 有效。 */
  ref?: LooseOptional<string>
  css: Nullable<string>
  role: Nullable<string>
  text: Nullable<string>
  name: Nullable<string>
  frame?: LooseOptional<BrowserElementFrameHint>
  attributes: Record<string, string>
}

/** @AgentView 页面上的一个链接：text、href 与它的 target。 */
export interface BrowserPageLink {
  text: string
  href: string
  target: Nullable<BrowserElementTargetHint>
}

/** @AgentView 可以点的东西是什么：button、submit、link、combobox（下拉框）、option、menuitem。 */
export type BrowserPageActionRole =
  'button' | 'submit' | 'link' | 'combobox' | 'option' | 'menuitem'

/** @AgentView 页面上一个可以点的东西：text 是文字，role 是种类，target 交给 click。 */
export interface BrowserPageAction {
  text: string
  role: BrowserPageActionRole
  target: Nullable<BrowserElementTargetHint>
}

/** @AgentView 页面上的一个表单字段：label 是标签，type 是输入类型，required 是必不必填，target 交给 fill、select、check。 */
export interface BrowserPageFormField {
  label: string
  type: string
  name: Nullable<string>
  placeholder: Nullable<string>
  required: boolean
  target: Nullable<BrowserElementTargetHint>
}

/** @AgentView 紧凑快照从哪来：dom-inspection 或 cdp-accessibility（无障碍树）。 */
export type BrowserPageSnapshotSource = 'dom-inspection' | 'cdp-accessibility'

/** @AgentView 页面的紧凑文本快照：lines 每行一个元素（带 ref），refCount 是一共几个 ref，truncated 为真表示被截断。 */
export interface BrowserPageSnapshot {
  mode: 'compact'
  source: BrowserPageSnapshotSource
  lines: string[]
  refCount: number
  truncated: boolean
}

export interface BrowserInspectPageOptions {
  maxTextChars?: number
  includeHtml?: boolean
  maxHtmlChars?: number
  maxElements?: number
  ignoreSelectors?: string[]
  /** E1: 设置后在 did-finish-load 后额外等待网络空闲；单位毫秒，也可传 true 使用默认 500ms */
  waitForNetworkIdle?: number | true
}

/**
 * @AgentView
 * 看页面的结果：text 是正文（textTruncated 为真表示被截断），html 只在 includeHtml 时有；headings、links、actions（可以点的）、formFields（表单字段）各带 target。
 * login 是登录墙的启发式检测，loginGate 只在这次停下来问过用户时出现（用户登录完之后这里已经是重读过的页面）。
 */
export interface BrowserPageInspection {
  url: string
  title: string
  metaDescription: Nullable<string>
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

export interface BrowserScreenshotRegionOptions {
  /** CSS selector；与 x/y/width/height 二选一，优先 selector。 */
  selector?: string
  /** 页面 CSS 坐标（含 scroll）。 */
  x?: number
  y?: number
  width?: number
  height?: number
}

export interface BrowserCaptureScreenshotOptions {
  path?: string
  width?: number
  height?: number
  waitForNetworkIdle?: boolean | number
  waitForDomStable?: boolean | BrowserDomStabilityOptions
  fullPage?: boolean | BrowserScreenshotFullPageOptions
  /** 截取页面指定区域（selector 或 page-css 矩形）；与 fullPage 互斥，region 优先。 */
  region?: BrowserScreenshotRegionOptions
  includeModelImage?: boolean | BrowserScreenshotModelImageOptions
  annotateElements?: boolean | BrowserScreenshotElementLabelOptions
  compareWithPrevious?: boolean
}

export interface BrowserScreenshotFullPageOptions {
  enabled?: boolean
  maxWidth?: number
  maxHeight?: number
}

export interface BrowserDomStabilityOptions {
  stableFrames?: number
  sampleIntervalMs?: number
  maxWaitMs?: number
}

export interface BrowserPageStabilityResult {
  stable: boolean
  reason: 'stable' | 'timeout' | 'unavailable'
  durationMs: number
  frames: number
}

export interface BrowserScreenshotModelImageOptions {
  maxWidth?: number
  maxHeight?: number
  quality?: number
  highlightViewport?: boolean
}

export interface BrowserScreenshotElementLabelOptions {
  enabled?: boolean
  maxElements?: number
}

export interface BrowserScreenshotElementLabel {
  index: number
  tagName: string
  role: Nullable<string>
  text: Nullable<string>
  selector: Nullable<string>
  x: number
  y: number
  width: number
  height: number
}

/** @AgentView 标注截图里的一个编号元素：index 是图上的编号，label、description 说它是什么，target 交给 click 这类操作。 */
export interface BrowserScreenshotElementLegendItem {
  index: number
  label: string
  role: Nullable<string>
  text: Nullable<string>
  selector: Nullable<string>
  description: string
  target: BrowserElementTargetHint
}

/** @AgentView 登录墙的启发式检测：requiresLogin 为真表示这页像登录、验证或支付页，confidence 是把握（0 到 1），reason 与 signals 说依据。遇到登录墙别自己填账号密码，交给用户。 */
export interface BrowserLoginDetection {
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

/** @AgentView 这一页停下来问过用户：approved 为真表示用户说已经登录好、可以继续，reason 是结论说明。同一站点在一次会话里只问一次。 */
export interface BrowserLoginGateRecord {
  /** 是否真的阻塞并向用户征询过；本记录存在即为 true（缺席表示从未触发门控）。 */
  prompted: boolean
  /** 用户是否表示已完成登录并继续。 */
  approved: boolean
  /** 触发门控的站点源。 */
  origin: Nullable<string>
  confidence: number
  signals: string[]
  /** 门控结论说明：批准时取检测理由，拒绝时取用户/宿主给的原因。 */
  reason: string
  resolvedAt: number
}

export interface BrowserScreenshotMetadata {
  viewportWidth: number
  viewportHeight: number
  scrollX: number
  scrollY: number
  documentWidth: number
  documentHeight: number
  deviceScaleFactor: number
  zoomFactor: number
  cursor: Nullable<{
    x: number
    y: number
    pressed: boolean
  }>
  elementLabels: BrowserScreenshotElementLabel[]
  elementLegend: BrowserScreenshotElementLegendItem[]
  stability: Nullable<BrowserPageStabilityResult>
  recentEvents: BrowserPageDiagnosticEntry[]
  login: BrowserLoginDetection
}

/** @AgentView 与上一张截图的比较：changed 是变没变，reason 是 first-capture（第一张）、changed、unchanged，changedRatio 是变了多大比例的像素。 */
export interface BrowserScreenshotDiff {
  changed: boolean
  reason: 'first-capture' | 'changed' | 'unchanged'
  fingerprint: string
  previousFingerprint: Nullable<string>
  changedPixels?: number
  totalPixels?: number
  changedRatio?: number
}

export interface BrowserScreenshotModelImage {
  data: string
  mediaType: 'image/jpeg' | 'image/png'
  path?: string
  relativePath?: string
  width: number
  height: number
  bytes: number
  sourceWidth: number
  sourceHeight: number
  scale: number
  quality: number
  coordinateMap?: BrowserScreenshotModelCoordinateMap
}

/** @AgentView 一个矩形（页面 CSS 像素）。 */
export interface BrowserScreenshotRect {
  x: number
  y: number
  width: number
  height: number
}

/** @AgentView 截的是页面哪一块：mode 是 viewport、full-page、region；x、y、width、height 是那块在页面上的位置（CSS 像素，含滚动），clipped 为真表示超出上限被裁过。 */
export interface BrowserScreenshotCaptureRegion extends BrowserScreenshotRect {
  mode: 'viewport' | 'full-page' | 'region'
  coordinateSpace: 'page-css-px'
  documentWidth: number
  documentHeight: number
  viewport: BrowserScreenshotRect
  clipped: boolean
}

/** @AgentView 页面坐标与图上坐标怎么换算：图上的点乘 imageToPageScaleX、imageToPageScaleY 就是页面 CSS 像素；viewportRectInImage 是视口在图上的位置。clickAt 用的是视口坐标。 */
export interface BrowserScreenshotModelCoordinateMap {
  coordinateSpace: 'page-css-px'
  pageToImageScaleX: number
  pageToImageScaleY: number
  imageToPageScaleX: number
  imageToPageScaleY: number
  viewportRectInImage: BrowserScreenshotRect
  visibleViewport: BrowserScreenshotRect
}

export interface BrowserScreenshotArtifact {
  url: string
  path: string
  relativePath: string
  width: number
  height: number
  bytes: number
  capturedAt: number
  capture?: BrowserScreenshotCaptureRegion
  metadata?: BrowserScreenshotMetadata
  diff?: BrowserScreenshotDiff
  modelImage?: BrowserScreenshotModelImage
  /** 本次截图是否触发过登录墙门控；缺席 = 没触发（不是「没检测」）。 */
  loginGate?: BrowserLoginGateRecord
}

/** 页面元素动作；fill 对日期类控件设置原生值，其余可编辑控件全选后由宿主输入。 */
export type BrowserTargetActionKind = 'click' | 'hover' | 'focus' | 'select_all' | 'fill'

export interface BrowserTargetActionOptions {
  action: BrowserTargetActionKind
  target: BrowserElementTargetHint
  /** fill 要填入的完整值；日期类使用 HTML 标准格式。 */
  value?: string
  waitForNavigation?: boolean
  /** 点击用哪个键，缺省 left。 */
  button?: BrowserMouseButton
  /** 点击连击几下，缺省 1。 */
  clickCount?: number
}

/**
 * @AgentView
 * 按元素动手的结果：matched 为假时 failureReason 说为什么（not-found 没找到、not-interactable 点不动或不是文本控件、covered 被挡住），blockedBy 是挡住它的元素。
 * effect 是动手前后页面的变化，controlState 是动完之后控件的值或勾选状态。
 */
export interface BrowserTargetActionOutcome {
  url: string
  matched: boolean
  selector: Nullable<string>
  text: Nullable<string>
  clickPoint?: LooseOptional<{ x: number; y: number }>
  clickMethod?: LooseOptional<'dom' | 'coordinate'>
  effect?: LooseOptional<BrowserTargetActionEffect>
  failureReason?: LooseOptional<'not-found' | 'not-interactable' | 'covered'>
  blockedBy?: LooseOptional<string>
  controlState?: LooseOptional<{
    kind: 'text' | 'checkable' | 'select' | 'contenteditable'
    value?: LooseOptional<string>
    valueLength?: LooseOptional<number>
    checked?: LooseOptional<boolean>
    selectedValues?: LooseOptional<string[]>
  }>
  capturedAt: number
}

/** 页面里按元素做一步的结果：action 是请求的那一步。 */
export interface BrowserTargetActionResult extends BrowserTargetActionOutcome {
  action: BrowserTargetActionKind
  /** fill 已完成原生赋值时为假；文本全选后仍需宿主输入时为真。 */
  inputRequired?: boolean
}

/** @AgentView 动手前或动手后页面的一份指纹：地址、标题、正文的哈希与长度。 */
export interface BrowserTargetActionEffectSnapshot {
  url: string
  title: string
  textHash: string
  textLength: number
}

/** @AgentView 动手前后正文的差别：多了几行、少了几行、没变几行。 */
export interface BrowserTargetActionTextDiff {
  changed: boolean
  additions: number
  removals: number
  unchanged: number
  truncated: boolean
}

/** @AgentView 动手前后页面的变化：observed 为真表示量到了，urlChanged、titleChanged、textChanged 说哪里变了。都没变时多半没点中想要的东西，重新 inspect 看看。 */
export interface BrowserTargetActionEffect {
  observed: boolean
  urlChanged: boolean
  titleChanged: boolean
  textChanged: boolean
  textDiff?: LooseOptional<BrowserTargetActionTextDiff>
  before: BrowserTargetActionEffectSnapshot
  after: BrowserTargetActionEffectSnapshot
}

/** @AgentView 导航动作：back、forward、reload、goto。 */
export type BrowserPageNavigationAction = 'back' | 'forward' | 'reload' | 'goto'

export interface BrowserPageNavigationOptions {
  action: BrowserPageNavigationAction
  url?: string
}

/** @AgentView 导航的结果：navigated 是真的跳了没有，url、title 是落地的页面，canGoBack、canGoForward 是还能不能后退、前进。 */
export interface BrowserPageNavigationResult {
  action: BrowserPageNavigationAction
  navigated: boolean
  url: string
  title: Nullable<string>
  canGoBack: boolean
  canGoForward: boolean
  capturedAt: number
}

export interface BrowserElementSelectionRect {
  x: number
  y: number
  width: number
  height: number
  centerX: number
  centerY: number
}

export interface BrowserElementSelectionSnapshot {
  id: string
  url: string
  title: string
  label: string
  tagName: string
  role: Nullable<string>
  text: string
  selector: Nullable<string>
  attributes: Record<string, string>
  rect: BrowserElementSelectionRect
  viewportWidth: number
  viewportHeight: number
  target: Nullable<BrowserElementTargetHint>
  capturedAt: number
}

export interface BrowserElementSelectionStep extends BrowserElementSelectionSnapshot {
  action: 'click' | 'select'
  sequence: number
}

export interface BrowserElementSelection extends BrowserElementSelectionSnapshot {
  interactionSteps?: BrowserElementSelectionStep[]
}

/** @AgentView 挂起事件的种类：dialog（JS 弹窗）、download（下载）、permission（权限请求）。 */
export type BrowserPendingEventKind = 'dialog' | 'download' | 'permission'

/** @AgentView 一个挂着等处理的事件：id 交给 handleDialog、handleDownload、handlePermission，details 里是弹窗文字、文件名、要的权限这些细节。 */
export interface BrowserPendingEventSummary {
  id: string
  kind: BrowserPendingEventKind
  createdAt: number
  details: Record<string, unknown>
}

/** 此刻挂着的全部事件。 */
export interface BrowserPendingEventsResult {
  pending: BrowserPendingEventSummary[]
  capturedAt: number
}

export interface BrowserHandleDialogOptions {
  eventId?: string
  accept: boolean
  promptText?: string
}

/** @AgentView 弹窗处理的结果：handled 为真表示处理掉了。 */
export interface BrowserHandleDialogResult {
  handled: boolean
  eventId: string
  accept: boolean
  promptText: string
}

export interface BrowserHandleDownloadOptions {
  eventId?: string
  action: 'accept' | 'cancel'
  savePath?: string
}

/** @AgentView 下载处理的结果：savePath 是存到的位置，state 是下载的最终状态。 */
export interface BrowserHandleDownloadResult {
  handled: boolean
  eventId: string
  action: 'accept' | 'cancel'
  savePath: Nullable<string>
  state: Nullable<string>
}

export interface BrowserHandlePermissionOptions {
  eventId?: string
  grant: boolean
}

/** @AgentView 权限请求处理的结果。 */
export interface BrowserHandlePermissionResult {
  handled: boolean
  eventId: string
  granted: boolean
}

export interface BrowserUploadFileOptions {
  target: BrowserElementTargetHint
  filePath: string
}

/** @AgentView 上传的结果：matched 为假表示没找到那个 file input，files 是塞进去的文件。 */
export interface BrowserUploadFileResult {
  matched: boolean
  selector: Nullable<string>
  files: string[]
  capturedAt: number
}

export interface BrowserFetchResourceOptions {
  url: string
  savePath: string
  referer?: string
}

/** @AgentView 下载到站点工作区的文件：path 是绝对路径，relativePath 是工作区里的相对路径，mimeType、bytes、status 是类型、大小与 HTTP 状态。 */
export interface BrowserFetchResourceResult {
  url: string
  path: string
  relativePath: string
  mimeType: Nullable<string>
  bytes: number
  status: number
  capturedAt: number
}

export interface BrowserExportPagePdfOptions {
  savePath?: string
  printBackground?: boolean
}

/** @AgentView 导出的 PDF：path 是绝对路径，relativePath 是工作区里的相对路径。 */
export interface BrowserExportPagePdfResult {
  url: string
  path: string
  relativePath: string
  bytes: number
  capturedAt: number
}

/** @AgentView 诊断的级别：debug、info、warning、error。 */
export type BrowserPageDiagnosticLevel = 'debug' | 'info' | 'warning' | 'error'
/** @AgentView 诊断的种类：console、page-error（未处理的异常）、load-error、render-process-gone、download、popup、permission、dialog、network、storage。 */
export type BrowserPageDiagnosticKind =
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

/**
 * @AgentView
 * 一条诊断：message 是内容，url、line、column 是出处，code 是 HTTP 状态这类数字；网络条目的 details 里有 requestId（交给 request 读详情）、method、status、resourceType。
 */
export interface BrowserPageDiagnosticEntry {
  kind: BrowserPageDiagnosticKind
  level: BrowserPageDiagnosticLevel
  message: string
  url: Nullable<string>
  line: Nullable<number>
  column: Nullable<number>
  code: Nullable<number>
  capturedAt: number
  details?: Record<string, unknown>
}

export interface BrowserPageDiagnosticsOptions {
  /** 过滤之后最多返回几条；缺席时用引擎缺省。 */
  limit?: number
  /**
   * 只要这些种类的诊断；缺席表示全部种类。
   *
   * 过滤发生在取窗口**之前**：先按种类挑，再取最近 limit 条。反过来做的话，一个 console
   * 刷屏的页面会把失败请求整批挤出窗口——`list_network_events` 回 0 条，而失败请求就在
   * 更早的诊断里。`clear` 同样只清这里选中的种类。
   */
  kinds?: readonly BrowserPageDiagnosticKind[]
  clear?: boolean
}

/** @AgentView 网络采集的说明：这次才开始采集时告诉你之前的请求没有记录，采集没能开始时说原因。 */
export type BrowserNetworkCaptureNotice = LooseOptional<string>

/** @AgentView 诊断的计数：按级别、种类、来源、HTTP 状态、资源类型各数了几条。 */
export interface BrowserPageDiagnosticsSummary {
  total: number
  byLevel: Record<string, number>
  byKind: Record<string, number>
  byOrigin: Record<string, number>
  byStatus: Record<string, number>
  byResourceType: Record<string, number>
}

/** @AgentView 整份诊断：entries 是最近的条目（先按种类过滤再取窗口），summary 是计数，networkCaptureNotice 在网络采集这次才开始时出现。 */
export interface BrowserPageDiagnostics {
  url: string
  title: Nullable<string>
  entries: BrowserPageDiagnosticEntry[]
  summary: BrowserPageDiagnosticsSummary
  /**
   * 网络采集的如实说明：内嵌页面的采集是读诊断时才建立的，这次才开始时要告诉模型
   * 「之前的请求没有记录」，采集没能建立时要说清原因。没有要说的就不给这个字段。
   */
  networkCaptureNotice?: BrowserNetworkCaptureNotice
  capturedAt: number
}

/** 在当前焦点处插入一段文字。 */
export interface BrowserInsertTextOptions {
  text: string
}

/** @AgentView 插入的结果：textLength 是插入了几个字符。 */
export interface BrowserInsertTextResult {
  url: string
  textLength: number
  capturedAt: number
}

/** @AgentView 组合键的修饰键：shift、control、alt、meta。 */
export type BrowserKeyModifier = 'shift' | 'control' | 'alt' | 'meta'

export interface BrowserPressKeyOptions {
  key: string
  modifiers?: BrowserKeyModifier[]
  repeat?: number
  waitForNavigation?: boolean
}

/** @AgentView 按键的结果：key 是按的键，repeat 是按了几次。 */
export interface BrowserPressKeyResult {
  url: string
  key: string
  repeat: number
  capturedAt: number
}

/** @AgentView 鼠标按键：left、middle、right。 */
export type BrowserMouseButton = 'left' | 'middle' | 'right'

/** 把鼠标移到视口里的一个点：steps 是拆成几步移动。 */
export interface BrowserMoveMouseOptions {
  x: number
  y: number
  steps?: number
}

export interface BrowserClickCoordinatesOptions {
  x: number
  y: number
  button?: BrowserMouseButton
  clickCount?: number
  waitForNavigation?: boolean
}

/** 坐标点击的结果：点在视口里的 x、y，用的哪个键、点了几下。 */
export interface BrowserClickCoordinatesResult {
  url: string
  x: number
  y: number
  button: BrowserMouseButton
  clickCount: number
  capturedAt: number
}

export interface BrowserDragCoordinatesOptions {
  startX: number
  startY: number
  endX: number
  endY: number
  steps?: number
}

export interface BrowserDragOptions {
  source: BrowserElementTargetHint
  target: BrowserElementTargetHint
  steps?: number
  waitForNavigation?: boolean
}

/** @AgentView 拖拽的一端：matched 为假表示没找到这个元素，point 是按下或松开的位置。 */
export interface BrowserDragEndpointResult {
  matched: boolean
  selector: Nullable<string>
  text: Nullable<string>
  point: Nullable<{ x: number; y: number }>
}

/** @AgentView 拖拽没成的原因：source-not-found、target-not-found、not-interactable。 */
export type BrowserDragFailureReason = 'source-not-found' | 'target-not-found' | 'not-interactable'

/** @AgentView 拖拽的结果：matched 为假时 failureReason 说为什么；startX、startY 到 endX、endY 是拖动的路径。 */
export interface BrowserDragResult {
  url: string
  matched: boolean
  source: BrowserDragEndpointResult
  target: BrowserDragEndpointResult
  startX: Nullable<number>
  startY: Nullable<number>
  endX: Nullable<number>
  endY: Nullable<number>
  steps: number
  failureReason: Nullable<BrowserDragFailureReason>
  capturedAt: number
}

/** @AgentView 页面加载状态：domcontentloaded、load、networkidle（网络空闲）。 */
export type BrowserPageWaitLoadState = 'domcontentloaded' | 'load' | 'networkidle'

/** 等页面到某个加载状态：不给 loadState 就不等；timeoutMs 是最多等多久。 */
export interface BrowserPageWaitOptions {
  loadState?: BrowserPageWaitLoadState
  timeoutMs?: number
}

/** 等页面的结果：matched 为真表示等到了，timedOut 为真表示到点没等到；elapsedMs 是实际等了多久。 */
export interface BrowserPageWaitResult {
  url: string
  loadState: 'loading' | 'interactive' | 'complete'
  requestedLoadState: Nullable<BrowserPageWaitLoadState>
  matched: boolean
  timeoutMs: number
  elapsedMs: number
  timedOut: boolean
  capturedAt: number
}

/** @AgentView 视口尺寸：width、height 是 CSS 像素，mobile 为真时按手机视口处理。 */
export interface BrowserViewportOptions {
  width: number
  height: number
  /** 是否启用 Chromium 的移动设备 viewport 语义；缺省保持桌面兼容行为。 */
  mobile?: boolean
}

/** 设视口之后的尺寸。 */
export interface BrowserViewportResult {
  url: string
  width: number
  height: number
  /** 实际应用的移动设备 viewport 语义；旧实现可能不返回此字段。 */
  mobile?: boolean
  capturedAt: number
}

/** @AgentView 缩放动作：in 放大、out 缩小、reset 还原、set 设成指定倍数。 */
export type BrowserPageZoomAction = 'in' | 'out' | 'reset' | 'set'

export interface BrowserPageZoomOptions {
  action: BrowserPageZoomAction
  zoomFactor?: number
  step?: number
}

/** @AgentView 缩放之后的倍数：zoomFactor 是现在的，previousZoomFactor 是之前的。 */
export interface BrowserPageZoomResult {
  url: string
  zoomFactor: number
  previousZoomFactor: number
  capturedAt: number
}

export interface BrowserNetworkControlOptions {
  offline?: boolean
  extraHTTPHeaders?: Record<string, string>
  blockedURLPatterns?: string[]
  blockedResourceTypes?: string[]
  mockResponses?: BrowserNetworkMockResponse[]
}

/** @AgentView 一条假响应：urlPattern 匹配的请求直接回这里的 status（缺省 200）、contentType、body 与 headers，不再发到服务器。 */
export interface BrowserNetworkMockResponse {
  urlPattern: string
  status?: number
  contentType?: string
  body?: string
  headers?: Record<string, string>
}

/** @AgentView 网络条件设好之后的全部状态：离线没有、加了哪些请求头、拦了哪些地址与资源类型、挂着哪些假响应。 */
export interface BrowserNetworkControlResult {
  url: string
  offline: boolean
  extraHTTPHeaders: Record<string, string>
  blockedURLPatterns: string[]
  blockedResourceTypes: string[]
  mockResponses: BrowserNetworkMockResponse[]
  capturedAt: number
}

export interface BrowserNetworkResponseBodyOptions {
  requestId: string
  maxChars?: number
}

export interface BrowserNetworkResponseBodyResult {
  url: string
  requestId: string
  body: string
  base64Encoded: boolean
  bodyLength: number
  returnedChars: number
  bodyTruncated: boolean
  capturedAt: number
}

export interface BrowserNetworkRequestDetailsOptions {
  requestId: string
  includeResponseBody?: boolean
  maxBodyChars?: number
}

/** @AgentView 请求：method、url、headers、postData、resourceType 与发出的时间。 */
export interface BrowserNetworkRequestSnapshot {
  method: string
  url: string
  headers: Record<string, string>
  postData?: string
  resourceType: string
  timestamp: Nullable<number>
  wallTime: Nullable<number>
}

/** @AgentView 响应：status、statusText、headers、mimeType、协议，是不是来自缓存或 Service Worker，体积与对端地址，timing 是各阶段耗时。 */
export interface BrowserNetworkResponseSnapshot {
  status: number
  statusText: string
  headers: Record<string, string>
  mimeType: Nullable<string>
  protocol: Nullable<string>
  fromDiskCache: boolean
  fromServiceWorker: boolean
  encodedDataLength: Nullable<number>
  remoteIPAddress: Nullable<string>
  remotePort: Nullable<number>
  timing: Nullable<Record<string, unknown>>
}

/** @AgentView 请求失败：errorText 是原因，canceled 为真表示被取消。 */
export interface BrowserNetworkFailureSnapshot {
  errorText: string
  canceled: boolean
}

/** @AgentView 响应体：body 是内容（base64Encoded 为真时是 base64），bodyLength 是原长，bodyTruncated 为真表示只交回了一部分。 */
export interface BrowserNetworkRequestResponseBodySnapshot {
  body: string
  base64Encoded: boolean
  bodyLength: number
  returnedChars: number
  bodyTruncated: boolean
}

/** @AgentView 一次请求的详情：request、response、failure 与总耗时；responseBody 只在 includeResponseBody 时有。 */
export interface BrowserNetworkRequestDetailsResult {
  url: string
  requestId: string
  request: BrowserNetworkRequestSnapshot
  response: Nullable<BrowserNetworkResponseSnapshot>
  failure: Nullable<BrowserNetworkFailureSnapshot>
  durationMs: Nullable<number>
  responseBody?: BrowserNetworkRequestResponseBodySnapshot
  capturedAt: number
}

export interface BrowserPerformanceTraceStartOptions {
  /** true（默认）：先跳 about:blank 再回跳原 URL，录制完整加载过程；false：从当前页面状态原地开录。 */
  reload?: boolean
  /** 录制这么久后自动停止并返回分析；null/0 表示保持录制直到显式 stop_trace。默认 5000ms。 */
  autoStopMs?: LooseOptional<number>
}

/**
 * @AgentView
 * trace 的分析：keyMetrics 是各段的 Core Web Vitals（如 NAVIGATION_0: LCP 258 ms, CLS 0.00），summary 是整体摘要与可深入的 insight 清单，
 * insightSetIds 交给 insight 的 insightSetId；原始 trace 落在 rawTracePath（.json.gz，能拖进 DevTools 的 Performance 面板）。
 */
export interface BrowserPerformanceTraceStopResult {
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

/** @AgentView 开始录 trace 的结果：status 是 recording 时还在录（note 说怎么停），是 completed 时已经到点自动停、带着和 stopTrace 一样的分析。 */
export type BrowserPerformanceTraceStartResult =
  | {
      status: 'recording'
      url: string
      startedAt: number
      /** 给模型的操作提示：怎么停、能做什么。 */
      note: string
    }
  | ({ status: 'completed' } & BrowserPerformanceTraceStopResult)

export interface BrowserPerformanceInsightOptions {
  insightSetId: string
  insightName: string
}

export interface BrowserScreencastStartOptions {
  /** 帧最大宽度（默认 800，CDP 侧缩放）。 */
  maxWidth?: number
  /** 每 N 帧取 1 帧（默认 2）；越大文件越小。 */
  everyNthFrame?: number
}

/** @AgentView 开始录屏的结果：note 说怎么停。 */
export interface BrowserScreencastStartResult {
  url: string
  status: 'recording'
  startedAt: number
  note: string
}

export interface BrowserScreencastStopOptions {
  /** 产物名（默认按时间戳生成）。 */
  name?: string
}

/** @AgentView 录屏的产物：GIF 落在 path（relativePath 是工作区里的相对路径），frameCount 是几帧，frameLimitReached 为真表示到帧数上限被截断。 */
export interface BrowserScreencastStopResult {
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

export interface BrowserHeapSnapshotOptions {
  /** 保存相对路径（工作区内）；缺省 artifacts/memory/heap-<ts>.heapsnapshot。 */
  path?: string
}

/** @AgentView 堆快照的产物：落在 path，bytes 是大小。 */
export interface BrowserHeapSnapshotResult {
  url: string
  path: string
  relativePath: string
  bytes: number
  capturedAt: number
}

/** @AgentView 一条 insight 的详细分析：output 是 DevTools 给的分析文字。 */
export interface BrowserPerformanceInsightResult {
  insightSetId: string
  insightName: string
  output: string
  capturedAt: number
}

/** 页面脚本的一次求值。 */
export interface BrowserEvaluateScriptOptions {
  /** 一个表达式；求出来是函数就用 args 调它，是 Promise 就等它。 */
  script: string
  /** 交给函数的参数（JSON 值）。 */
  args?: unknown[]
  /** 在哪个框架里跑（listFrames 给的 id）；不给是顶层页面。 */
  frame?: string
  /** 页面里最多等多少毫秒。 */
  timeoutMs?: number
  /** 结果 JSON 最长多少字符；超了只回它的长度，不把结果运出页面。 */
  maxResultChars: number
}

/** 页面脚本抛的错：name、message 原样，line、column 是它在 script 里的行列（从 1 数，定位不到时缺席）。 */
export interface BrowserScriptError {
  name: string
  message: string
  line?: number
  column?: number
}

/**
 * 页面脚本求值的结局，三种之一：成功时 json 是结果的 JSON（返回 undefined 时缺席）；页面里抛了错时 error 在；
 * 结果超过上限时 tooLargeChars 是它的 JSON 长度。url 是求值时页面的地址。
 */
export interface BrowserScriptOutcome {
  url: string
  ok: boolean
  json?: string
  error?: BrowserScriptError
  tooLargeChars?: number
}

/** @AgentView 受控页面的窗口状态：visible 是用户看不看得见，driverKind 是内嵌页面（webview）还是外部浏览器（external），以及地址、标题、能不能前进后退。 */
export interface BrowserPageWindowState {
  active: boolean
  visible: boolean
  driverKind: 'webview' | 'external'
  url: Nullable<string>
  title: Nullable<string>
  canGoBack: boolean
  canGoForward: boolean
  /** 模型显式设置的 CSS viewport；null 表示跟随浏览器工作区可用尺寸。 */
  viewport: Nullable<BrowserViewportOptions>
}

/**
 * 供宿主 UI 短时观察受控页面的轻量预览帧。
 *
 * 与 BrowserScreenshotArtifact 不同，这个帧只经 IPC 返回、不写入浏览器工作区。
 */
export interface BrowserPagePreviewFrame {
  dataUrl: string
  width: number
  height: number
  url: string
  title: Nullable<string>
  capturedAt: number
}

/** Agent 浏览器输入在画中画上的轻量指针事件；与 JPEG 帧分开发送。 */
export interface BrowserPagePreviewPointerEvent {
  x: number
  y: number
  xRatio: number
  yRatio: number
  action: 'move' | 'hover' | 'click' | 'drag'
  phase: 'move' | 'down' | 'up'
  button: Nullable<BrowserMouseButton>
  capturedAt: number
}

/** 画中画实时通道：页面合成帧与高频指针事件共用一个有序事件流。 */
export type BrowserPagePreviewStreamEvent =
  | { kind: 'frame'; frame: BrowserPagePreviewFrame }
  | { kind: 'pointer'; pointer: BrowserPagePreviewPointerEvent }

/** @AgentView 一个标签页：id 交给 switchTab，active 为真表示当前在操作它。 */
export interface BrowserPageTargetInfo {
  id: string
  type: 'page'
  url: string
  title: string
  active: boolean
}

/** 标签页列表：activeTargetId 是当前在操作的那一页。 */
export interface BrowserPageTargetsResult {
  driverKind: 'webview' | 'external'
  activeTargetId: Nullable<string>
  targets: BrowserPageTargetInfo[]
  capturedAt: number
}

export interface BrowserSwitchPageTargetOptions {
  targetId: string
}

/** @AgentView 切换之后：target 是现在在操作的那一页，targets 是全部标签页。 */
export interface BrowserSwitchPageTargetResult {
  driverKind: 'webview' | 'external'
  activeTargetId: Nullable<string>
  target: BrowserPageTargetInfo
  targets: BrowserPageTargetInfo[]
  url: string
  title: Nullable<string>
  capturedAt: number
}

/** Narrow file port used by browser artifact and user-script storage adapters. */
export interface WorkspaceFileEntry {
  path: string
  type: 'file' | 'directory'
}

export interface WorkspaceListOptions {
  path?: string
  include?: string[]
  exclude?: string[]
  excludeGitignored?: boolean
  recursive?: boolean
  maxDepth?: number
  limit?: number
}

export interface ProjectReadFileResult {
  path: string
  content: string
  totalLines: number
  startLine: number
  endLine: number
  totalChars: number
  returnedChars: number
  truncated: boolean
  hasMore?: boolean
  remainingLines?: number
  nextStartLine?: LooseOptional<number>
}

export interface WorkspaceFileChangeDescriptor {
  changeId: string
  path: string
  created: boolean
  added: number
  removed: number
}

export interface WorkspaceWriteFileResult {
  path: string
  bytes: number
  created: boolean
  changed: boolean
  message?: string
  change?: LooseOptional<WorkspaceFileChangeDescriptor>
}

export interface WorkspaceWriteFileOptions {
  overwrite?: boolean
}

/** 请求一个受控浏览器页面时给的输入：哪个会话、工作区刷新键、激活令牌。 */
export interface ControlledBrowserSurfaceInput {
  /** 浏览器会话 id。 */
  sessionId: string
  /** 工作区刷新键：变了就重取一次页面状态。 */
  workspaceRefreshKey: number
  /** 激活令牌；未激活时是 null。 */
  activationToken: Nullable<string>
}

// ── 模型面：velaros:browser 的入参 ─────────────────────────────────

/**
 * @AgentView
 * 定位一个元素的线索，至少给一样：ref 是 inspect、标注截图给的引用（如 @e3:g2，原样传回；新的一次 inspect 或标注截图之后旧 ref 作废），
 * css 是 CSS selector（最多 1000 个字符），text、name、role、attributes（id、data-testid 这类）按可见文字、可访问名称、角色与属性找；
 * frame 限定在哪个同源 iframe 里找（只进一层）。inspect 结果、截图 legend 里的 target 可以原样传进来。
 */
export interface BrowserTargetHint {
  ref?: LooseOptional<string>
  css?: LooseOptional<string>
  role?: LooseOptional<string>
  text?: LooseOptional<string>
  name?: LooseOptional<string>
  frame?: LooseOptional<{
    css?: LooseOptional<string>
    name?: LooseOptional<string>
    title?: LooseOptional<string>
    url?: LooseOptional<string>
  }>
  attributes?: Record<string, string>
}

/** @AgentView 要操作的元素：字符串以 @ 开头当 ref，其余当 CSS selector；也可以给一份定位线索。 */
export type BrowserTarget = string | BrowserTargetHint

/** @AgentView 打开一个网站并进入它的站点：url 最多 2048 个字符，不带协议按 https:// 补全，localhost 也行。 */
export interface BrowserOpenInput {
  url: string
}

/** @AgentView 切到外部浏览器的另一个标签页：targetId 取自 state() 结果里的 tabs[].id。 */
export interface BrowserSwitchTabInput {
  targetId: string
}

/**
 * @AgentView
 * 看页面：maxTextChars 是正文最多交回多少字符（最多 100000），includeHtml 为真再带上 HTML（maxHtmlChars 最多 100000），
 * maxElements 是可交互元素最多几个（最多 400），ignoreSelectors 是先排除掉的噪音子树（导航、cookie 提示条、广告，最多 50 个 selector）。
 * 不给就取到上限。
 */
export interface BrowserInspectInput {
  maxTextChars?: number
  includeHtml?: boolean
  maxHtmlChars?: number
  maxElements?: number
  ignoreSelectors?: string[]
}

/** @AgentView 只截页面上的一块：给 selector（截那个元素），或者给完整的 x、y、width、height（页面 CSS 像素，含滚动，最多 20000）。 */
export type BrowserScreenshotRegion =
  { selector: string } | { x: number; y: number; width: number; height: number }

/**
 * @AgentView
 * 截图：图交给你看，原图落进站点工作区（path 是工作区里的相对路径，最多 180 个字符，不给就按时间命名）。
 * 缺省截当前视口；fullPage 为真截整页（单边最多 32000 像素），region 只截一块（与 fullPage 同时给时以 region 为准）。
 * annotate 为真先给可交互元素画上编号（最多 120 个），legend 里给每个编号的 target，能直接交给 click 这类操作。
 * width、height 是截图前把视口设成多大（宽 320 到 3840，高 240 到 2160）。截图前缺省会等一小会儿网络空闲与页面不再变（动画、骨架屏）：
 * waitForNetworkIdle 给数字是网络空闲多少毫秒（100 到 5000），两个都可以传 false 不等；compareWithPrevious 缺省为真，diff 里说与上一张比变没变。
 */
export interface BrowserScreenshotInput {
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
 * @AgentView
 * 在页面里跑一段 JavaScript：script 是一个表达式（最多 20000 个字符），求出来是函数就用 args 调它，是 Promise 就等它；
 * 多条语句写成 `() => { …; return x }`。args 是交给函数的参数（JSON 值，合起来最多 1000000 个字符）：值用它传，别拼进源码。
 * frame 是 frames() 给的 id，不给就在顶层页面里跑。timeoutMs 缺省 5000、最多 30000。
 */
export interface BrowserEvaluateInput {
  script: string
  args?: unknown[]
  frame?: string
  timeoutMs?: number
}

/**
 * @AgentView
 * 点一下：target 是元素（点它的中心：先滚进视口，确认没被挡住），或者给视口坐标 x、y（0 到 10000；取自截图时按 image.coordinateMap 换算），两样只给一样。
 * button 缺省 left，clickCount 是连击几下（最多 5，双击给 2）；按住的修饰键（keyDown）会带上。
 * waitForNavigation 为真时按完整的导航稳定窗口等（缺省只短暂等一下可能的跳转）。
 */
export interface BrowserClickInput {
  target?: BrowserTarget
  x?: number
  y?: number
  button?: BrowserMouseButton
  clickCount?: number
  waitForNavigation?: boolean
}

/**
 * @AgentView
 * 往输入框、文本域或可编辑区域写入文字，替换原来的内容：value 最多 20000 个字符，空字符串就是清空。
 * 文本控件聚焦、全选后使用真实输入，React、Vue 与富文本编辑器都认。
 * date/time/datetime-local/month/week 按 HTML 标准格式设置原生值并触发 input/change，事件不标为 isTrusted；用返回的 controlState 核对实际值。
 * 勾选框与下拉框回 matched 为假：勾选用 click，下拉框在 evaluate 里设值再派发 change。
 */
export interface BrowserFillInput {
  target: BrowserTarget
  value: string
}

/** @AgentView 悬停：把鼠标移到元素中心（出菜单、出提示）；移到一个坐标用 mouseMove。 */
export interface BrowserHoverInput {
  target: BrowserTarget
}

/** @AgentView 在当前焦点处插入文字（像输入法上屏：发 beforeinput、input，不发按键事件）：text 最多 20000 个字符。要先点中输入框。 */
export interface BrowserInsertTextInput {
  text: string
}

/**
 * @AgentView
 * 按一个键（按下再抬起）：key 是 Enter、Tab、Escape、Backspace、ArrowDown、Home、F5 这类键名或一个字符（最多 80 个字符），组合键写 Control+a 或给 modifiers；
 * repeat 是连按几次（最多 50），waitForNavigation 为真时按完等可能的跳转。按住的修饰键（keyDown）也会带上。
 */
export interface BrowserPressInput {
  key: string
  modifiers?: BrowserKeyModifier[]
  repeat?: number
  waitForNavigation?: boolean
}

/**
 * @AgentView
 * 按下或抬起一个键：key 的写法同 press，一次一个键（最多 80 个字符）。Shift、Control、Alt、Meta 按下之后带到之后的每个按键与鼠标事件上，
 * 直到 keyUp：keyDown Shift 之后的 click 就是 Shift 点击。
 */
export interface BrowserKeyInput {
  key: string
}

/** @AgentView 把鼠标移到视口里的一个点（CSS 像素，0 到 10000）：steps 是拆成几步移动（最多 60，缺省 1）；按着鼠标键时就是拖。 */
export interface BrowserMouseMoveInput {
  x: number
  y: number
  steps?: number
}

/** @AgentView 在鼠标现在的位置按下或松开一个键：button 缺省 left，clickCount 是连击的第几下（双击的第二下给 2，最多 5）。 */
export interface BrowserMouseButtonInput {
  button?: BrowserMouseButton
  clickCount?: number
}

/** @AgentView 在鼠标现在的位置滚一下滚轮：deltaX、deltaY 是像素（绝对值最多 10000，往下、往右为正），至少给一个。要先 mouseMove 到要滚的区域上。 */
export interface BrowserWheelInput {
  deltaX?: number
  deltaY?: number
}

/** @AgentView 把一个元素拖到另一个元素上：steps 是拆成几步移动（最多 60）。拖出任意路径用 mouseDown、mouseMove、mouseUp。 */
export interface BrowserDragInput {
  source: BrowserTarget
  target: BrowserTarget
  steps?: number
  waitForNavigation?: boolean
}

/** @AgentView 给 file input 选文件：filePath 是站点工作区里的相对路径（出了工作区一律拒绝），最多 4096 个字符。 */
export interface BrowserUploadInput {
  target: BrowserTarget
  filePath: string
}

/** @AgentView 跳到一个网址：url 最多 2048 个字符。 */
export interface BrowserGotoInput {
  url: string
}

/**
 * @AgentView
 * 等页面里一个条件成立：script、args、frame 的写法同 evaluate；宿主每隔 intervalMs（50 到 5000，缺省 100）在当前页面上跑一次，
 * 结果为真就交回它，页面跳转途中的那一次算没到、新页面上接着判。timeoutMs 最多 60000、缺省 30000，等不到抛 TIMEOUT；
 * 页面里抛错直接抛 BROWSER_SCRIPT_FAILED（元素可能还没出现时写 `?.`）。
 */
export interface BrowserWaitForFunctionInput {
  script: string
  args?: unknown[]
  frame?: string
  timeoutMs?: number
  intervalMs?: number
}

/** @AgentView 等页面加载到某个状态：state 缺省 load（也可以 domcontentloaded、networkidle），timeoutMs 最多 60000、缺省 30000，等不到抛 TIMEOUT。 */
export interface BrowserWaitForLoadInput {
  state?: BrowserPageWaitLoadState
  timeoutMs?: number
}

/** @AgentView 等一个挂起事件出现：kind 缺省 download，timeoutMs 缺省 5000、最多 60000，等不到抛 TIMEOUT。 */
export interface BrowserWaitForEventInput {
  kind?: BrowserPendingEventKind
  timeoutMs?: number
}

/** @AgentView 处理 JS 弹窗：accept 为真是确认、为假是取消；prompt 弹窗用 promptText 填值。eventId 不给就处理最早的那个弹窗。 */
export interface BrowserDialogInput {
  eventId?: string
  accept: boolean
  promptText?: string
}

/** @AgentView 处理一次下载：给 savePath（站点工作区里的相对路径）就保存到那里，cancel 为真就取消。eventId 不给就处理最早的那个下载。 */
export interface BrowserDownloadDecisionInput {
  eventId?: string
  savePath?: string
  cancel?: boolean
}

/** @AgentView 处理权限请求（定位、通知、剪贴板这类）：grant 为真是允许。eventId 不给就处理最早的那个请求。 */
export interface BrowserPermissionInput {
  eventId?: string
  grant: boolean
}

/**
 * @AgentView
 * 带着当前页面的 cookie 下载一个 http(s) 资源到站点工作区：url 与 savePath 各最多 4096 个字符，单个文件最多 52428800 字节；
 * referer 不给就用当前页面的地址。blob:、data: 与 DRM 保护的流下不了。
 */
export interface BrowserDownloadInput {
  url: string
  savePath: string
  referer?: string
}

/** @AgentView 把当前页面导出成 PDF 落进站点工作区：path 是相对路径，不给就按时间命名。 */
export interface BrowserSavePdfInput {
  path?: string
}

// ── 模型面：velaros:browser 的回执 ─────────────────────────────────

/** @AgentView 进站的结果：站点工作区在哪（workspaceRoot），以及落地后的页面状态。 */
export interface BrowserOpened {
  site: BrowserSiteContext
  page: BrowserPageState
}

/**
 * @AgentView
 * 当前状态：没进站点时 active 为假、其余字段都没有；进了站点时带着站点与页面状态，tabs 是标签页（内嵌页面只有当前这一页，外部浏览器是全部），
 * pending 是挂着等处理的弹窗、下载与权限请求（没人处理的会在超时后按缺省结算：弹窗取消、下载取消、权限拒绝）。
 */
export interface BrowserState {
  active: boolean
  site?: BrowserSiteContext
  page?: BrowserPageState
  tabs?: BrowserPageTargetInfo[]
  pending?: BrowserPendingEventSummary[]
}

/** @AgentView 页面里的一个框架：id 交给 evaluate、waitForFunction 的 frame，parentId 是上一层（顶层页面是 null），crossOrigin 为真是和顶层页面不同源的 iframe。 */
export interface BrowserFrameInfo {
  id: string
  parentId: Nullable<string>
  url: string
  name: string
  crossOrigin: boolean
}

/** @AgentView 交给你看的那张图：宽高（像素）、相对原图缩了多少（scale）、页面 CSS 坐标与图上坐标怎么换算（coordinateMap）。 */
export interface BrowserScreenshotImage {
  width: number
  height: number
  scale: number
  coordinateMap?: BrowserScreenshotModelCoordinateMap
}

/**
 * @AgentView
 * 截图的结果：原图落在 path（relativePath 是站点工作区里的相对路径），width、height、bytes 是原图的尺寸与大小；
 * capture 说截的是页面哪一块，image 是交给你看的那张图，legend 是 annotate 时每个编号元素的说明与 target，
 * diff 是与上一张的比较，login 是登录墙的启发式检测，loginGate 只在这次停下来问过用户时出现。
 */
export interface BrowserScreenshot {
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

/** @AgentView 点击没命中而改用坐标补点的记录：x、y 是补点的视口坐标，screenshotPath 是找坐标用的那张标注截图。 */
export interface BrowserSelectorRecovery {
  source: 'selector-coordinate-recovery'
  screenshotPath: string
  x: number
  y: number
}

/** @AgentView 点中了、页面却看不出变化时的提示：recommendedNextActions 是建议下一步做的（重新 inspect 或截图看看）。 */
export interface BrowserActionEffectHint {
  source: 'target-action-effect'
  reason: 'no-observable-change'
  recommendedNextActions: Array<'inspect' | 'screenshot'>
}

/**
 * @AgentView
 * click、fill、hover 的结果：action 是做的哪件事；matched 为假时 failureReason 说为什么（没找到、点不动、被挡住），blockedBy 是挡住它的元素；
 * effect 是动手前后页面的变化（地址、标题、正文），controlState 是动完之后控件的状态（fill 之后读它确认写进去的值）。
 * 按坐标点的 selector 与 text 是 null。selectorRecovery 在改用坐标补点时出现，actionEffect 在点中了却没有变化时出现。
 */
export interface BrowserActed extends BrowserTargetActionOutcome {
  action: 'click' | 'fill' | 'hover'
  selectorRecovery?: BrowserSelectorRecovery
  actionEffect?: BrowserActionEffectHint
}

/** @AgentView 按键之后：held 是现在还按着的键（keyDown 了还没 keyUp 的）。 */
export interface BrowserKeyResult {
  url: string
  key: string
  held: string[]
}

/** @AgentView 鼠标动过之后：x、y 是它现在在视口里的位置，buttons 是还按着的鼠标键。 */
export interface BrowserMouseResult {
  url: string
  x: number
  y: number
  buttons: BrowserMouseButton[]
}

// ── 模型面：velaros:devtools 的入参 ────────────────────────────────

/** @AgentView 读哪一类诊断：all 全部、console 控制台、network 网络请求、page_error 未处理的异常。 */
export type BrowserPageDiagnosticsReadKind = 'all' | 'console' | 'network' | 'page_error'

/**
 * @AgentView
 * 读诊断：kind 缺省 all；limit 是过滤之后最多几条（最多 300，不给就取到上限），clear 为真读完把这一类清掉。
 * console 可按 level 或 errorsOnly 过滤；network 可按 status（100 到 999）、resourceType（最多 80 个字符）或 failedOnly 过滤，
 * 回执里的 requestId 交给 request 读详情。
 */
export interface DevtoolsDiagnosticsInput {
  kind?: BrowserPageDiagnosticsReadKind
  limit?: number
  clear?: boolean
  level?: BrowserPageDiagnosticLevel
  errorsOnly?: boolean
  status?: number
  resourceType?: string
  failedOnly?: boolean
}

/** @AgentView 读一次网络请求的详情：requestId 取自 diagnostics 的网络条目（最多 200 个字符）；includeResponseBody 为真时带上响应体（maxBodyChars 最多 200000，不给就取到上限）。 */
export interface DevtoolsRequestInput {
  requestId: string
  includeResponseBody?: boolean
  maxBodyChars?: number
}

/** @AgentView 调页面缩放：action 是 in、out、reset、set；set 要给 zoomFactor（0.25 到 3），in、out 的步长 step 是 0.05 到 0.5。 */
export interface DevtoolsZoomInput {
  action: BrowserPageZoomAction
  zoomFactor?: number
  step?: number
}

/**
 * @AgentView
 * 设网络条件，至少给一样：offline 断网；extraHTTPHeaders 加请求头（名最多 120、值最多 4000 个字符）；
 * blockedURLPatterns 拦这些地址（最多 100 条，每条最多 2048 个字符），blockedResourceTypes 拦这些资源类型（最多 32 种）；
 * mockResponses 给匹配的请求直接回一个假响应（最多 50 条，正文最多 1000000 个字符）。
 */
export interface DevtoolsNetworkInput {
  offline?: boolean
  extraHTTPHeaders?: Record<string, string>
  blockedURLPatterns?: string[]
  blockedResourceTypes?: string[]
  mockResponses?: BrowserNetworkMockResponse[]
}

/**
 * @AgentView
 * 开始录性能 trace：reload 缺省 true（先重载，录完整加载）；autoStopMs 是录多久自动停并交回分析（缺省 5000，1000 到 60000），
 * 给 null 就一直录到 stopTrace（录交互时这么用）。
 */
export interface DevtoolsTraceInput {
  reload?: boolean
  autoStopMs?: LooseOptional<number>
}

/** @AgentView 对最近一次 trace 里的一条 insight 出详细分析：insightSetId 与 insightName 都取自 trace 摘要（各最多 120 个字符）。 */
export interface DevtoolsInsightInput {
  insightSetId: string
  insightName: string
}

/** @AgentView 采一份 V8 堆快照落进站点工作区：path 是相对路径（最多 300 个字符），不给就按时间命名。快照很大，别读进来，交给 memlab 这类工具分析。 */
export interface DevtoolsHeapSnapshotInput {
  path?: string
}

/** @AgentView 开始录屏：maxWidth 是帧宽（240 到 1600，缺省 800），everyNthFrame 是每几帧取一帧（1 到 10，缺省 2）。页面不变不出新帧。 */
export interface DevtoolsRecordingInput {
  maxWidth?: number
  everyNthFrame?: number
}

/** @AgentView 停止录屏并合成 GIF：name 是产物名（最多 60 个字符），不给就按时间命名。 */
export interface DevtoolsStopRecordingInput {
  name?: string
}

/** @AgentView 指定一个用户脚本。 */
export interface DevtoolsUserScriptIdInput {
  id: string
}

/**
 * @AgentView
 * 新建一个用户脚本（进到匹配的网站时自动注入的 JavaScript）：name 最多 120 个字符，code 最多 1000000 字节；
 * match、excludeMatch 是网址规则（如 https://example.com/*，各最多 64 条、每条最多 500 个字符，只认 http 与 https），
 * runAt 缺省 document-idle，world 缺省 isolated（只有要碰页面自己的 JavaScript 对象时才用 main）。
 * 新建的脚本一律停用：先把 name、match、world、runAt 讲给用户，用户明确同意后再 enableUserScript。
 */
export interface DevtoolsCreateUserScriptInput {
  name: string
  code: string
  description?: string
  version?: string
  match: string[]
  excludeMatch?: string[]
  runAt?: BrowserUserScriptRunAt
  world?: BrowserUserScriptWorld
}

/** @AgentView 改一个用户脚本，至少改一样；改了代码或执行范围之后脚本自动停用，要用户重新确认后再启用。上限同 createUserScript。 */
export interface DevtoolsUpdateUserScriptInput {
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

/** @AgentView 启用或停用一个用户脚本；未经用户明确同意不要启用。停用不会撤销当前页面已经执行的副作用，要刷新页面。 */
export interface DevtoolsEnableUserScriptInput {
  id: string
  enabled: boolean
}

/** @AgentView 用户脚本的总开关：为假时所有脚本都不注入。 */
export interface DevtoolsEnableUserScriptsInput {
  enabled: boolean
}

/** @AgentView 调整注入顺序：把一个脚本往前（up）或往后（down）挪一位，越靠前越先执行。 */
export interface DevtoolsMoveUserScriptInput {
  id: string
  direction: 'up' | 'down'
}

// ── 模型面：velaros:devtools 的回执 ────────────────────────────────

/** @AgentView console 这一类的过滤条件。 */
export interface BrowserConsoleEventFilters {
  level: Nullable<BrowserPageDiagnosticLevel>
  errorsOnly: boolean
}

/** @AgentView console 诊断：entries 是过滤后的条目，consoleTotal 是缓冲里 console 条目一共几条。 */
export interface BrowserConsoleEventsResult {
  url: string
  title: Nullable<string>
  entries: BrowserPageDiagnosticEntry[]
  summary: BrowserPageDiagnosticsSummary
  filters: BrowserConsoleEventFilters
  diagnosticTotal: number
  consoleTotal: number
}

/** @AgentView network 这一类的过滤条件。 */
export interface BrowserNetworkEventFilters {
  status: Nullable<number>
  resourceType: Nullable<string>
  failedOnly: boolean
}

/** @AgentView 网络诊断：entries 带 requestId（交给 request 读详情）；networkCaptureNotice 在网络采集这次才开始时说明之前的请求看不到。 */
export interface BrowserNetworkEventsResult {
  url: string
  title: Nullable<string>
  entries: BrowserPageDiagnosticEntry[]
  summary: BrowserPageDiagnosticsSummary
  filters: BrowserNetworkEventFilters
  diagnosticTotal: number
  networkTotal: number
  networkCaptureNotice: Nullable<string>
}

/** @AgentView 未处理异常的诊断。 */
export interface BrowserPageErrorsResult {
  url: string
  title: Nullable<string>
  entries: BrowserPageDiagnosticEntry[]
  summary: BrowserPageDiagnosticsSummary
  diagnosticTotal: number
  pageErrorTotal: number
}

/** @AgentView 读诊断的结果：kind 是 all 时是整份诊断，其余三类各是自己的形状。 */
export type BrowserPageDiagnosticsReadResult =
  | BrowserPageDiagnostics
  | BrowserConsoleEventsResult
  | BrowserNetworkEventsResult
  | BrowserPageErrorsResult

// ── 模型面：velaros:cdp ──────────────────────────────────────────

/**
 * @AgentView
 * 一条 CDP 命令：method 是完整方法名（如 DOM.getDocument，最多 200 个字符），params 是它的参数（按 JSON 算最多 10000000 个字符）。
 * session 是子会话 id（最多 200 个字符）：跨源 iframe、worker 先发 Target.setAutoAttach（autoAttach、flatten 为真），从 Target.attachedToTarget 事件里取；不给就是页面本身。
 */
export interface CdpSendInput {
  method: string
  params?: Record<string, unknown>
  session?: string
}

/** @AgentView 读事件：method 是完整方法名，或以点结尾的域（如 Network.），不给就是全部；after 是上一次拿到的 last，只要它之后的。 */
export interface CdpEventsInput {
  method?: string
  after?: number
}

/** @AgentView 等一条事件：method 写法同 events；after 不给就从现在起等新来的，给了就从那之后找（已经到了的也算）。timeoutMs 最多 60000、缺省 30000，等不到抛 TIMEOUT。 */
export interface CdpWaitForEventInput {
  method: string
  after?: number
  timeoutMs?: number
}

/** @AgentView 一条 CDP 事件：seq 是序号（只增不减），session 是它来自哪个子会话（页面本身是 null），params 是协议原样的参数。 */
export interface BrowserProtocolEvent {
  seq: number
  method: string
  params: any
  session: Nullable<string>
}

/** @AgentView 缓冲里的事件：events 按收到的先后排，last 交给下一次的 after；dropped 是缓冲满了挤掉的条数（最多留 5000 条）。 */
export interface BrowserProtocolEvents {
  events: BrowserProtocolEvent[]
  last: number
  dropped: number
}
