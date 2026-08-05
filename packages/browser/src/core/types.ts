/**
 * 浏览器产品配置的两个闭集。
 *
 * 运行期清单 / 出厂默认 / 宽容守卫全在 `BrowserConfigDefaults.ts`——加一个引擎只改那一处，
 * 这里的联合类型跟着它 `satisfies` 咬合。宿主（Desktop 的持久层 schema、Normalizer、IPC 契约）
 * 一律消费导出的清单与守卫，不再各写一份字面量。
 */
export type BrowserSearchEngineId = 'google' | 'bing'
export type BrowserAutomationMode = 'webview' | 'external'

export interface BrowserActionPolicyConfig {
  /** 没有命中 allow/deny 时的默认策略。 */
  default?: LooseOptional<'allow' | 'deny'>
  /** 允许的动作类别。非空时未列入动作默认拒绝，除非 default=allow。 */
  allow?: LooseOptional<string[]>
  /** 拒绝的动作类别；优先级高于 allow。 */
  deny?: LooseOptional<string[]>
}

export interface BrowserSiteContext {
  url: string
  /** 站点工作区根：写入唯一落点。宿主决定粒度（Desktop 按站点全局，与登录态、站点记忆同轴）。 */
  workspaceRoot: string
  /**
   * 只读的历史工作区根（旧粒度留下的资产），按新→旧排列。
   *
   * 存在的唯一理由是**换粒度不丢资产**：写只写 {@link workspaceRoot}，读不到才依次回退。
   * 刻意不做一次性搬迁脚本——搬迁要在启动路径上遍历用户全部会话目录，失败一半比不搬更糟；
   * 回退读是幂等的，用户每碰一次旧资产就自然继续可用，新写入自动落到新位置。
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

/** Browser-owned adapter shape structurally compatible with Kernel's generic turn-context source. */
export interface BrowserTurnContextDeltaSource {
  id: string
  scopes: readonly string[]
  rendererVisible?: boolean
  peekCached(input: BrowserTurnContextSourcePeekInput): BrowserTurnContextSourcePeekResult
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

export interface BrowserUserActivityItem {
  kind: BrowserUserActivityKind
  url: Nullable<string>
  occurredAt: number
  detail?: LooseOptional<string>
}

export interface BrowserUserActivitySummary {
  startedAt: number
  endedAt: number
  itemCount: number
  items: BrowserUserActivityItem[]
  text: string
}

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

export type BrowserWorkspaceArtifactKind =
  | 'page'
  | 'recipe'
  | 'extract'
  | 'note'
  | 'run'
  | 'download'
export type BrowserWorkspaceArtifactFormat = 'json' | 'text' | 'markdown' | 'html'

export interface BrowserWorkspaceManifest {
  version: 1
  siteUrl: string
  siteOrigin: Nullable<string>
  workspaceRoot: string
  directories: Record<BrowserWorkspaceArtifactKind, string>
  createdAt: number
  lastActivatedAt: number
}

export interface BrowserWorkspaceArtifactRecord {
  kind: BrowserWorkspaceArtifactKind
  format: BrowserWorkspaceArtifactFormat
  path: string
  relativePath: string
  bytes: number
  savedAt: number
}

export interface BrowserWorkspaceArtifactListItem {
  kind: BrowserWorkspaceArtifactKind
  type: 'file' | 'directory'
  path: string
  relativePath: string
  name: string
}

export interface BrowserWorkspaceArtifactsOverview {
  browserContext: BrowserSiteContext
  manifest: BrowserWorkspaceManifest
  artifacts: BrowserWorkspaceArtifactListItem[]
}

export type BrowserUserScriptRunAt = 'document-start' | 'document-end' | 'document-idle'
export type BrowserUserScriptWorld = 'isolated' | 'main'
export type BrowserUserScriptSource = 'agent' | 'user' | 'user-import'
export type BrowserUserScriptRunStatus = 'success' | 'error' | 'unsupported'

/** 某个脚本最近一次自动注入或手动运行结果。 */
export interface BrowserUserScriptLastRun {
  status: BrowserUserScriptRunStatus
  url: string
  documentId: string
  scriptRevision: number
  startedAt: number
  finishedAt: number
  error?: LooseOptional<string>
}

/** 浏览器会话全局用户脚本索引中保存的持久脚本元数据。 */
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

export interface BrowserUserScriptOverview {
  browserContext: BrowserSiteContext
  globalEnabled: boolean
  scripts: BrowserUserScriptRecord[]
  /** 使用宿主注入 matcher 针对 browserContext.url 计算，Renderer 不应重复实现匹配规则。 */
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

export interface BrowserUserScriptMutationResult {
  overview: BrowserUserScriptOverview
  script?: LooseOptional<BrowserUserScriptRecord>
  code?: LooseOptional<string>
  run?: LooseOptional<BrowserUserScriptLastRun>
  /** 禁用脚本不会撤销已执行的页面副作用；需要刷新页面才能得到干净文档。 */
  refreshRequired?: LooseOptional<boolean>
}

export interface BrowserPageHeading {
  level: number
  text: string
}

export interface BrowserElementFrameHint {
  css: Nullable<string>
  name: Nullable<string>
  title: Nullable<string>
  url: Nullable<string>
}

export interface BrowserElementTargetHint {
  /** 来自最近一次页面 snapshot/inspection 的短引用，如 @e3。 */
  ref?: LooseOptional<string>
  css: Nullable<string>
  role: Nullable<string>
  text: Nullable<string>
  name: Nullable<string>
  frame?: LooseOptional<BrowserElementFrameHint>
  attributes: Record<string, string>
}

export interface BrowserPageLink {
  text: string
  href: string
  target: Nullable<BrowserElementTargetHint>
}

export type BrowserPageActionRole =
  | 'button'
  | 'submit'
  | 'link'
  | 'combobox'
  | 'option'
  | 'menuitem'

export interface BrowserPageAction {
  text: string
  role: BrowserPageActionRole
  target: Nullable<BrowserElementTargetHint>
}

export interface BrowserPageFormField {
  label: string
  type: string
  name: Nullable<string>
  placeholder: Nullable<string>
  required: boolean
  target: Nullable<BrowserElementTargetHint>
}

export type BrowserPageSnapshotSource = 'dom-inspection' | 'cdp-accessibility'

export interface BrowserPageSnapshot {
  mode: 'compact'
  source: BrowserPageSnapshotSource
  lines: string[]
  refCount: number
  truncated: boolean
}

export interface BrowserRecipeSkeletonLink {
  text: string
  href: string
  target: Nullable<BrowserElementTargetHint>
}

export type BrowserRecipeSkeletonStepKind =
  | 'review_page'
  | 'review_section'
  | 'click_action'
  | 'fill_field'
  | 'follow_link'
  | 'extract_links'
  | 'wait_for_selector'
  | 'scroll'
  | 'navigate'
  | 'extract_table'
  | 'extract_list'

export interface BrowserRecipeSkeletonStepInput {
  name: string
  label: string
  type: string
  required: boolean
}

export interface BrowserRecipeSkeletonStep {
  id: string
  kind: BrowserRecipeSkeletonStepKind
  title: string
  instruction: string
  heading?: string
  href?: string
  text?: string
  target?: LooseOptional<BrowserElementTargetHint>
  input?: BrowserRecipeSkeletonStepInput
  /** C2: 条件表达式，支持 {{inputName}} 占位符；运行时求値为空字符串时跳过此步骤 */
  condition?: string
  /** C2: 失败时最多重试次数（每次间隔 300ms），不填或 0 表示不重试 */
  retryCount?: number
  /** navigate 步骤的导航动作；默认 goto（需 href）。 */
  navigationAction?: BrowserPageNavigationAction
  /** scroll 步骤方向。 */
  direction?: BrowserPageScrollDirection
  /** scroll 步骤像素量。 */
  amount?: number
  /** scroll 步骤水平偏移。 */
  scrollX?: number
  /** scroll 步骤垂直偏移。 */
  scrollY?: number
  /** wait / extract 的显式 selector；可替代 target.css。 */
  selector?: string
  /** wait_for_selector 是否要求可见。 */
  visible?: boolean
  /** wait_for_selector 超时毫秒。 */
  timeoutMs?: number
  /** extract_table 最多行数。 */
  maxRows?: number
  /** extract_table 表格索引。 */
  tableIndex?: number
  /** extract_list 最多条目数。 */
  maxItems?: number
}

export interface BrowserRecipeSkeleton {
  version: 1
  url: string
  title: string
  summary: string
  sourceSnapshotPath: Nullable<string>
  sectionHeadings: string[]
  primaryLinks: BrowserRecipeSkeletonLink[]
  inputs: BrowserRecipeSkeletonStepInput[]
  suggestedSteps: BrowserRecipeSkeletonStep[]
  generatedAt: number
}

export interface BrowserRecipeSkeletonPreview {
  path: string
  url: string
  title: string
  summary: string
  inputs: BrowserRecipeSkeletonStepInput[]
  stepCount: number
  requiredInputNames: string[]
  optionalInputNames: string[]
  generatedAt: number
}

/** Browser-owned request for persisting an element-picker selection as a recipe step. */
export interface BrowserSaveRecipeStepRequest {
  sessionId: string
  selection: BrowserElementSelection
  stepKind?: BrowserRecipeSkeletonStepKind
  recipePath?: string
}

/** Browser-owned result returned after a recipe step is persisted. */
export interface BrowserSaveRecipeStepResult {
  recipePath: string
  stepId: string
  stepCount: number
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
  /**
   * 登录墙检测（与截图元数据同一份启发式，随检查脚本顺带产出）。
   *
   * 刻意内嵌进检查脚本而不是另发一次 `evaluateScript`：inspect 是常驻主回路，多一次页面
   * 往返既是延迟也会撞上浏览器动作策略里 `evaluate` 这条门——一条只读的观察不该因为
   * 用户关掉了脚本执行权限就整条失效。
   */
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

export interface BrowserScreenshotElementLegendItem {
  index: number
  label: string
  role: Nullable<string>
  text: Nullable<string>
  selector: Nullable<string>
  description: string
  target: BrowserElementTargetHint
}

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

/**
 * 登录墙**门控**结论（检测的下游）：这一页停下来问过用户了没有、用户怎么答的。
 *
 * 与 {@link BrowserLoginDetection} 分开是刻意的：检测只是启发式观察，可以误判；门控是
 * 一次真实发生过的人机交互，带用户裁决。渲染层据此显示「登录待处理 / 登录后继续」，
 * 只有本记录能回答那个问题——检测字段回答不了「问过没有」。
 */
export interface BrowserLoginGateRecord {
  /** 是否真的阻塞并向用户征询过；本记录存在即为 true（缺席表示从未触发门控）。 */
  prompted: boolean
  /** 用户是否表示已完成登录并继续。 */
  approved: boolean
  /** 触发门控的站点身份（与空间 identityStrategy:'origin' 同口径）。 */
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

/** 干跑 recipe 时单个步骤的结论（面向人看的精简投影，不带 runtime 原始返回）。 */
export interface BrowserRecipeDryRunStep {
  id: string
  kind: string
  status: string
  message: string
  inputName: Nullable<string>
  targetCss: Nullable<string>
}

/**
 * 「干跑 recipe」的结构化结论。
 *
 * 存在的理由是一条判决：**UI 动作不该塞提示词**。制品面板的干跑按钮从前往输入框里写一句
 * 「请对 X 执行 browser:run_recipe_skeleton，dryRun=true 预检」——工具收门面之后那个名字
 * 已经不是注册工具了，模型在清单里找不到它，运气好自己改调、运气不好凭空编一个，
 * 而任何门都拦不住一段字符串。改成 IPC 直调之后，按钮与 recipe 执行器之间是编译期关系。
 */
export interface BrowserRecipeDryRunSummary {
  path: string
  url: string
  title: Nullable<string>
  executableStepCount: number
  readyStepCount: number
  missingInputCount: number
  skippedStepCount: number
  requiredInputNames: string[]
  /** 缺失的输入项（step 里声明了、这次没给值的字段）。 */
  missingInputs: BrowserRecipeDryRunMissingInput[]
  steps: BrowserRecipeDryRunStep[]
}

/** 干跑发现的缺失输入；面板据此告诉用户「真跑之前还得填什么」。 */
export interface BrowserRecipeDryRunMissingInput {
  stepId: string
  name: string
  label: string
  required: boolean
}

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

export interface BrowserScreenshotRect {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserScreenshotCaptureRegion extends BrowserScreenshotRect {
  mode: 'viewport' | 'full-page' | 'region'
  coordinateSpace: 'page-css-px'
  documentWidth: number
  documentHeight: number
  viewport: BrowserScreenshotRect
  clipped: boolean
}

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

export type BrowserTargetActionKind =
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

export type BrowserTargetActionValue = string | string[]

export interface BrowserTargetActionOptions {
  action: BrowserTargetActionKind
  target: BrowserElementTargetHint
  value?: BrowserTargetActionValue
  waitForNavigation?: boolean
}

export type BrowserObservedActionSource = 'action' | 'link' | 'form_field'
export type BrowserObservedActionKind = BrowserTargetActionKind | 'upload'

export interface BrowserObservedActionInput {
  action: 'target'
  targetAction: BrowserTargetActionKind
  target: BrowserElementTargetHint
  value?: BrowserTargetActionValue
}

export interface BrowserObservedUploadInput {
  target: BrowserElementTargetHint
  filePath: string
}

export interface BrowserObservedActionPreview {
  label: string
  target: string
  command: string
  requiresValue: boolean
  twoStep: boolean
}

export interface BrowserObservedTargetActionReplay {
  tool: 'browser:act'
  input: BrowserObservedActionInput
}

export interface BrowserObservedUploadReplay {
  tool: 'browser:upload_file'
  input: BrowserObservedUploadInput
}

export type BrowserObservedActionReplay =
  | BrowserObservedTargetActionReplay
  | BrowserObservedUploadReplay

export interface BrowserObservedActionCandidateBase {
  id: string
  actionId: string
  method: BrowserObservedActionKind
  description: string
  source: BrowserObservedActionSource
  score: number
  twoStep: boolean
  requiresValue: boolean
  arguments: string[]
  preview: BrowserObservedActionPreview
  target: BrowserElementTargetHint
}

export interface BrowserObservedTargetActionCandidate extends BrowserObservedActionCandidateBase {
  method: BrowserTargetActionKind
  replay: BrowserObservedTargetActionReplay
  actionInput: BrowserObservedActionInput
}

export interface BrowserObservedUploadCandidate extends BrowserObservedActionCandidateBase {
  method: 'upload'
  replay: BrowserObservedUploadReplay
}

export type BrowserObservedActionCandidate =
  | BrowserObservedTargetActionCandidate
  | BrowserObservedUploadCandidate

export interface BrowserObserveActionsResult {
  url: string
  title: string
  instruction: Nullable<string>
  candidates: BrowserObservedActionCandidate[]
  capturedAt: number
}

export interface BrowserTargetActionResult {
  action: BrowserTargetActionKind
  url: string
  matched: boolean
  selector: Nullable<string>
  text: Nullable<string>
  clickPoint?: LooseOptional<{ x: number; y: number }>
  clickMethod?: LooseOptional<'dom' | 'coordinate'>
  effect?: LooseOptional<BrowserTargetActionEffect>
  failureReason?: LooseOptional<'not-found' | 'not-interactable' | 'covered' | 'option-not-found'>
  blockedBy?: LooseOptional<string>
  selectedValues?: LooseOptional<string[]>
  availableOptions?: LooseOptional<Array<{ value: string; text: string; selected: boolean }>>
  controlState?: LooseOptional<{
    kind: 'text' | 'checkable' | 'select' | 'contenteditable'
    value?: LooseOptional<string>
    valueLength?: LooseOptional<number>
    checked?: LooseOptional<boolean>
    selectedValues?: LooseOptional<string[]>
  }>
  capturedAt: number
}

export interface BrowserTargetActionEffectSnapshot {
  url: string
  title: string
  textHash: string
  textLength: number
}

export interface BrowserTargetActionTextDiff {
  changed: boolean
  additions: number
  removals: number
  unchanged: number
  truncated: boolean
}

export interface BrowserTargetActionEffect {
  observed: boolean
  urlChanged: boolean
  titleChanged: boolean
  textChanged: boolean
  textDiff?: LooseOptional<BrowserTargetActionTextDiff>
  before: BrowserTargetActionEffectSnapshot
  after: BrowserTargetActionEffectSnapshot
}

export type BrowserPageNavigationAction = 'back' | 'forward' | 'reload' | 'goto'

export interface BrowserPageNavigationOptions {
  action: BrowserPageNavigationAction
  url?: string
}

export interface BrowserPageNavigationResult {
  action: BrowserPageNavigationAction
  navigated: boolean
  url: string
  title: Nullable<string>
  canGoBack: boolean
  canGoForward: boolean
  capturedAt: number
}

export type BrowserPageScrollDirection = 'up' | 'down' | 'left' | 'right' | 'top' | 'bottom'

export interface BrowserPageScrollOptions {
  direction?: BrowserPageScrollDirection
  amount?: number
  x?: number
  y?: number
}

export interface BrowserPageScrollResult {
  url: string
  scrollX: number
  scrollY: number
  maxScrollX: number
  maxScrollY: number
  viewportWidth: number
  viewportHeight: number
  capturedAt: number
}

export interface BrowserElementQueryOptions {
  selector: string
  attributes?: string[]
  includeHtml?: boolean
  limit?: number
  maxTextChars?: number
  maxHtmlChars?: number
}

export interface BrowserQueriedElement {
  index: number
  tagName: string
  text: string
  textTruncated: boolean
  html?: string
  htmlTruncated?: boolean
  attributes: Record<string, string>
  href: Nullable<string>
  value: Nullable<string>
  checked: Nullable<boolean>
  visible: boolean
  target: Nullable<BrowserElementTargetHint>
}

export interface BrowserElementQueryResult {
  url: string
  selector: string
  selectorError: Nullable<string>
  count: number
  limit: number
  elements: BrowserQueriedElement[]
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

export type BrowserPendingEventKind = 'dialog' | 'download' | 'permission'

export interface BrowserPendingEventSummary {
  id: string
  kind: BrowserPendingEventKind
  createdAt: number
  details: Record<string, unknown>
}

export interface BrowserPendingEventsResult {
  pending: BrowserPendingEventSummary[]
  capturedAt: number
}

export interface BrowserHandleDialogOptions {
  eventId?: string
  accept: boolean
  promptText?: string
}

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

export interface BrowserHandlePermissionResult {
  handled: boolean
  eventId: string
  granted: boolean
}

export interface BrowserUploadFileOptions {
  target: BrowserElementTargetHint
  filePath: string
}

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

export interface BrowserFetchResourceResult {
  url: string
  path: string
  relativePath: string
  mimeType: Nullable<string>
  bytes: number
  status: number
  capturedAt: number
}

export type BrowserMediaSourceKind = 'image' | 'video' | 'audio' | 'other'

export interface BrowserMediaSourceItem {
  kind: BrowserMediaSourceKind
  url: string
  fetchable: boolean
  tagName: Nullable<string>
  attribute: Nullable<string>
  alt: Nullable<string>
  width: Nullable<number>
  height: Nullable<number>
}

export interface BrowserListMediaSourcesOptions {
  limit?: number
  includeDataUrls?: boolean
  includeBlobUrls?: boolean
}

export interface BrowserListMediaSourcesResult {
  url: string
  items: BrowserMediaSourceItem[]
  truncated: boolean
  capturedAt: number
}

export type BrowserPageContentFormat = 'plain' | 'markdown' | 'html'

export interface BrowserExtractPageContentOptions {
  format?: BrowserPageContentFormat
  selector?: string
  maxChars?: number
  save?: boolean
  name?: string
}

export interface BrowserExtractPageContentResult {
  ok: boolean
  format: BrowserPageContentFormat
  selector: Nullable<string>
  content: string
  truncated: boolean
  url: string
  capturedAt: number
  savedPath?: string
  savedRelativePath?: string
}

export interface BrowserListPageResourcesOptions {
  limit?: number
  includeIframes?: boolean
}

export interface BrowserPageResourceLink {
  text: Nullable<string>
  href: string
}

export interface BrowserPageResourceIframe {
  src: Nullable<string>
  title: Nullable<string>
  sandbox: Nullable<string>
}

export interface BrowserPageResourceOrigins {
  pageOrigin: string
  sameOrigin: string[]
  crossOrigin: string[]
  totalUniqueOrigins: number
}

export interface BrowserListPageResourcesResult {
  url: string
  links: BrowserPageResourceLink[]
  iframes: BrowserPageResourceIframe[]
  resourceOrigins: BrowserPageResourceOrigins
  mediaCount: number
  truncated: boolean
  capturedAt: number
}

export interface BrowserExportPagePdfOptions {
  savePath?: string
  printBackground?: boolean
}

export interface BrowserExportPagePdfResult {
  url: string
  path: string
  relativePath: string
  bytes: number
  capturedAt: number
}

export type BrowserPageDiagnosticLevel = 'debug' | 'info' | 'warning' | 'error'
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
  limit?: number
  clear?: boolean
}

export interface BrowserPageDiagnosticsSummary {
  total: number
  byLevel: Record<string, number>
  byKind: Record<string, number>
  byOrigin: Record<string, number>
  byStatus: Record<string, number>
  byResourceType: Record<string, number>
}

export interface BrowserPageDiagnostics {
  url: string
  title: Nullable<string>
  entries: BrowserPageDiagnosticEntry[]
  summary: BrowserPageDiagnosticsSummary
  capturedAt: number
}

export interface BrowserTypeTextOptions {
  text: string
}

export interface BrowserTypeTextResult {
  url: string
  textLength: number
  capturedAt: number
}

export type BrowserKeyModifier = 'shift' | 'control' | 'alt' | 'meta'

export interface BrowserPressKeyOptions {
  key: string
  modifiers?: BrowserKeyModifier[]
  repeat?: number
  waitForNavigation?: boolean
}

export interface BrowserPressKeyResult {
  url: string
  key: string
  repeat: number
  capturedAt: number
}

export type BrowserMouseButton = 'left' | 'middle' | 'right'

export interface BrowserMoveMouseOptions {
  x: number
  y: number
}

export interface BrowserMoveMouseResult {
  url: string
  x: number
  y: number
  capturedAt: number
}

export interface BrowserClickCoordinatesOptions {
  x: number
  y: number
  button?: BrowserMouseButton
  clickCount?: number
  waitForNavigation?: boolean
}

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

export interface BrowserDragEndpointResult {
  matched: boolean
  selector: Nullable<string>
  text: Nullable<string>
  point: Nullable<{ x: number; y: number }>
}

export type BrowserDragFailureReason = 'source-not-found' | 'target-not-found' | 'not-interactable'

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

export interface BrowserWaitForSelectorOptions {
  selector: string
  state?: BrowserWaitForSelectorState
  visible?: boolean
  timeoutMs?: number
}

export type BrowserWaitForSelectorState = 'attached' | 'visible' | 'hidden' | 'detached'

export interface BrowserWaitForSelectorResult {
  url: string
  selector: string
  state: BrowserWaitForSelectorState
  matched: boolean
  visible: boolean
  count: number
  elapsedMs: number
  target: Nullable<BrowserElementTargetHint>
  capturedAt: number
}

export type BrowserPageWaitLoadState = 'domcontentloaded' | 'load' | 'networkidle'

export interface BrowserPageWaitOptions {
  durationMs?: number
  loadState?: BrowserPageWaitLoadState
  urlPattern?: string
  functionExpression?: string
  text?: string
  timeoutMs?: number
}

export interface BrowserPageWaitResult {
  url: string
  loadState: 'loading' | 'interactive' | 'complete'
  requestedLoadState: Nullable<BrowserPageWaitLoadState>
  urlPattern: Nullable<string>
  functionExpression: Nullable<string>
  functionResult: unknown
  text: Nullable<string>
  matched: boolean
  durationMs: number
  timeoutMs: number
  elapsedMs: number
  timedOut: boolean
  capturedAt: number
}

export interface BrowserViewportOptions {
  width: number
  height: number
}

export interface BrowserViewportResult {
  url: string
  width: number
  height: number
  capturedAt: number
}

export type BrowserPageZoomAction = 'in' | 'out' | 'reset' | 'set'

export interface BrowserPageZoomOptions {
  action: BrowserPageZoomAction
  zoomFactor?: number
  step?: number
}

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

export interface BrowserNetworkMockResponse {
  urlPattern: string
  status?: number
  contentType?: string
  body?: string
  headers?: Record<string, string>
}

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

export interface BrowserNetworkRequestSnapshot {
  method: string
  url: string
  headers: Record<string, string>
  postData?: string
  resourceType: string
  timestamp: Nullable<number>
  wallTime: Nullable<number>
}

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

export interface BrowserNetworkFailureSnapshot {
  errorText: string
  canceled: boolean
}

export interface BrowserNetworkRequestResponseBodySnapshot {
  body: string
  base64Encoded: boolean
  bodyLength: number
  returnedChars: number
  bodyTruncated: boolean
}

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

export type BrowserColorScheme = 'light' | 'dark' | 'no-preference'

export type BrowserReducedMotion = 'reduce' | 'no-preference'

export interface BrowserGeolocationOptions {
  latitude: number
  longitude: number
  accuracy?: number
}

export interface BrowserGeolocationState {
  latitude: number
  longitude: number
  accuracy: number
}

/** 网络节流预设；数值与 DevTools「Network conditions」面板同源。 */
export type BrowserNetworkThrottlingPreset = 'none' | 'slow-3g' | 'fast-3g' | 'slow-4g' | 'fast-4g'

export interface BrowserEmulationOptions {
  colorScheme?: BrowserColorScheme
  reducedMotion?: BrowserReducedMotion
  timezoneId?: string
  locale?: string
  geolocation?: BrowserGeolocationOptions
  /** CPU 减速倍率（1 = 不减速，4 = 4 倍减速）。 */
  cpuThrottlingRate?: number
  /** 网络节流预设；none 恢复原速。与 configure_network 的 offline 互相独立。 */
  networkThrottling?: BrowserNetworkThrottlingPreset
}

export interface BrowserEmulationResult {
  url: string
  colorScheme: BrowserColorScheme
  reducedMotion: BrowserReducedMotion
  timezoneId: Nullable<string>
  locale: Nullable<string>
  geolocation: Nullable<BrowserGeolocationState>
  cpuThrottlingRate: number
  networkThrottling: BrowserNetworkThrottlingPreset
  capturedAt: number
}

export interface BrowserPerformanceTraceStartOptions {
  /** true（默认）：先跳 about:blank 再回跳原 URL，录制完整加载过程；false：从当前页面状态原地开录。 */
  reload?: boolean
  /** 录制这么久后自动停止并返回分析；null/0 表示保持录制直到显式 stop_trace。默认 5000ms。 */
  autoStopMs?: LooseOptional<number>
}

export interface BrowserPerformanceTraceStopResult {
  url: string
  /**
   * 每个 insight set 的顶层 Core Web Vitals 紧凑摘要（如 `NAVIGATION_0: LCP 258 ms, CLS 0.00`）。
   * 从完整 summary 抽出,保证即使 summary 被折叠也能第一眼看到关键指标。
   */
  keyMetrics: string
  /** DevTools trace 引擎生成的整体摘要（含 CWV 指标与可用 insight 清单）。 */
  summary: string
  /** 可传给 analyze_insight 的 insightSetId 列表。 */
  insightSetIds: string[]
  /** 原始 trace 落盘绝对路径（.json.gz，可直接拖进 DevTools Performance 面板）。 */
  rawTracePath: string
  rawTraceRelativePath: string
  durationMs: number
  capturedAt: number
}

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

export interface BrowserHeapSnapshotResult {
  url: string
  path: string
  relativePath: string
  bytes: number
  capturedAt: number
}

export interface BrowserPerformanceInsightResult {
  insightSetId: string
  insightName: string
  output: string
  capturedAt: number
}

export interface BrowserPageStorageOptions {
  includeLocalStorage?: boolean
  includeSessionStorage?: boolean
  includeCookies?: boolean
  storageScope?: BrowserStorageScope
  cookieScope?: BrowserCookieScope
  limit?: number
  maxValueChars?: number
}

export type BrowserStorageScope = 'current-origin' | 'all-origins'

export type BrowserCookieScope = 'current-url' | 'all'

export interface BrowserStorageEntry {
  name: string
  value: string
  valueTruncated: boolean
  details?: Record<string, unknown>
}

export interface BrowserOriginStorage {
  origin: string
  localStorage?: BrowserStorageEntry[]
  sessionStorage?: BrowserStorageEntry[]
}

export interface BrowserPageStorageResult {
  url: string
  localStorage?: BrowserStorageEntry[]
  sessionStorage?: BrowserStorageEntry[]
  origins?: BrowserOriginStorage[]
  cookies?: BrowserStorageEntry[]
  capturedAt: number
}

export type BrowserEvaluateScriptMode = 'expression' | 'function-body'

export interface BrowserEvaluateScriptOptions {
  script: string
  mode?: BrowserEvaluateScriptMode
  timeoutMs?: number
  maxResultChars?: number
}

export interface BrowserEvaluateScriptResult {
  url: string
  ok: boolean
  mode: BrowserEvaluateScriptMode
  result: unknown
  resultText: string
  resultTruncated: boolean
  error: LooseOptional<{
    name: string
    message: string
    stack: Nullable<string>
  }>
  durationMs: number
  capturedAt: number
}

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

export interface BrowserPageTargetInfo {
  id: string
  type: 'page'
  url: string
  title: string
  active: boolean
}

export interface BrowserPageTargetsResult {
  driverKind: 'webview' | 'external'
  activeTargetId: Nullable<string>
  targets: BrowserPageTargetInfo[]
  capturedAt: number
}

export interface BrowserSwitchPageTargetOptions {
  targetId: string
}

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
