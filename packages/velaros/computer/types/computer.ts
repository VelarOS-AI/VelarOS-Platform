/**
 * 桌面控制的可移植数据：模型面（`velaros:computer` 的入参与回执，带 @AgentView 的那些）与经宿主端口、运行时流过的形状。
 * 不 import、不带函数成员、不用 Node 专属类型，整个文件随 `./computer/contracts` 入口出包。
 */

// ── 模型面：velaros:computer 的入参与回执 ─────────────────────────

/**
 * @AgentView
 * 按主屏截图量的坐标携带 screenshot 的 snapshotId；按窗口截图量的坐标携带 screenshotWindow 的 snapshotId，coordinateSpace 必须写 'window'。
 * 虚拟桌面的全局坐标写 coordinateSpace: 'global'，不带 snapshotId，可以为负。坐标都是整数，绝对值不超过 20000。
 */
export type ComputerPoint =
  | { x: number; y: number; snapshotId: string; coordinateSpace?: 'primary-display' }
  | { x: number; y: number; snapshotId: string; coordinateSpace: 'window' }
  | { x: number; y: number; coordinateSpace: 'global' }

/** @AgentView 点击：坐标同 ComputerPoint；button 默认 left，count 默认 1（双击给 2，最多 3）。 */
export type ComputerClickInput = ComputerPoint & {
  button?: 'left' | 'right' | 'middle'
  count?: number
}

/** @AgentView 要输入的文字：原样输入到当前焦点处，一次最多 10000 个字符。 */
export interface ComputerTypeInput {
  text: string
}

/** @AgentView 按键：一个键或用 + 连起来的组合键，比如 enter、esc、tab、cmd+a、ctrl+shift+t，最多 100 个字符。 */
export interface ComputerKeyInput {
  keys: string
}

/**
 * @AgentView
 * 一次截图：图本身交给你看（跟在程序结果后面，只看一次），这里是它的几何与 snapshotId。
 * width、height 是图的尺寸，也就是按截图量坐标的范围；按这张图上的坐标移动、点击时原样带上 snapshotId。
 * display 开头的几项与 origin、scaleFactor 说明这块主屏在虚拟桌面上的位置，一般用不着。
 */
export interface ComputerSnapshot {
  /** 窗口截图时提供；该图上的坐标必须显式写 coordinateSpace: 'window'。 */
  windowId?: string
  snapshotId: string
  width: number
  height: number
  displayWidth: number
  displayHeight: number
  displayId: number
  originX: number
  originY: number
  scaleFactor: number
}

/**
 * @AgentView
 * 指针落在哪：x、y 是你给的那套坐标，globalX、globalY 是虚拟桌面上的实际位置；按截图坐标时还带着显示器与 snapshotId。
 */
export interface ComputerMoved {
  x: number
  y: number
  coordinateSpace: ComputerCoordinateSpace
  globalX: number
  globalY: number
  displayId?: number
  snapshotId?: string
}

/** @AgentView 点击的结果：落点同 ComputerMoved，另有按了哪个键、按了几下。 */
export interface ComputerClicked extends ComputerMoved {
  button: string
  count: number
}

// ── 运行时与宿主端口上流过的形状 ─────────────────────────────────

/** `check` 的结果：当前平台与操作系统层面的桌面控制权限。 */
export interface ComputerPermissionStatus {
  platform: string
  accessibility: boolean
  screenRecording: Nullable<boolean>
}

/** 主显示器的逻辑几何。 */
export interface ComputerScreenSize {
  displayId: number
  width: number
  height: number
  scaleFactor: number
  originX: number
  originY: number
}

/** 一次截图的结果：图片本体、与它绑定的不透明标识，以及拍下这张图时的屏幕几何。 */
export interface ComputerScreenshot {
  windowId?: string
  base64: string
  format: 'jpeg'
  /** 用这张截图上量出的坐标点击时必须原样带回的绑定标识。 */
  snapshotId: string
  /** 图片宽度（逻辑分辨率，等于 displayWidth），也就是按截图量坐标的范围；换成全局坐标（加 originX）是 helper 的事。 */
  width: number
  /** 图片高度（逻辑分辨率，等于 displayHeight），也就是按截图量坐标的范围；换成全局坐标（加 originY）是 helper 的事。 */
  height: number
  displayWidth: number
  displayHeight: number
  displayId: number
  originX: number
  originY: number
  scaleFactor: number
}

/** 指针移动后落在的全局坐标，以及主屏坐标移动时的显示器与截图绑定。 */
export interface ComputerMoveResult {
  x: number
  y: number
  coordinateSpace?: ComputerCoordinateSpace
  displayId?: number
  snapshotId?: string
}

/** 点击结果：落点、按键、连击次数，以及主屏坐标点击时的显示器与截图绑定。 */
export interface ComputerClickResult {
  x: number
  y: number
  button: string
  count: number
  coordinateSpace?: ComputerCoordinateSpace
  displayId?: number
  snapshotId?: string
}

/** @AgentView 坐标空间：primary-display 为主屏截图，window 为窗口截图，global 为虚拟桌面全局坐标。 */
export type ComputerCoordinateSpace = 'primary-display' | 'window' | 'global'

/** 两种坐标空间共用的点击修饰：按哪个键、连击几次。 */
export interface ComputerClickModifiers {
  button?: 'left' | 'right' | 'middle'
  count?: number
}

/** 全局坐标点击的选项：不带截图绑定。 */
export interface ComputerGlobalClickOptions extends ComputerClickModifiers {
  /** 省略时仍按全局坐标解释，直接持有运行时的调用方因此不受影响。 */
  coordinateSpace?: 'global'
  snapshotId?: never
}

/** 主屏截图局部坐标点击的选项：必须带上给出这组坐标的那次截图的绑定标识。 */
export interface ComputerPrimaryDisplayClickOptions extends ComputerClickModifiers {
  coordinateSpace: 'primary-display' | 'window'
  /** 提供 x、y 的那次截图返回的不透明标识。 */
  snapshotId: string
}

export type ComputerClickOptions = ComputerGlobalClickOptions | ComputerPrimaryDisplayClickOptions

/** 两种坐标空间共用的移动修饰：走多久（需要平滑移动的宿主用）。 */
export interface ComputerMoveModifiers {
  durationMs?: number
}

/** 全局坐标移动的选项：不带截图绑定。 */
export interface ComputerGlobalMoveOptions extends ComputerMoveModifiers {
  /** 省略时仍按全局坐标解释，直接持有运行时的调用方因此不受影响。 */
  coordinateSpace?: 'global'
  snapshotId?: never
}

/** 主屏截图局部坐标移动的选项：与点击同一套，必须带上那次截图的绑定标识。 */
export interface ComputerPrimaryDisplayMoveOptions extends ComputerMoveModifiers {
  coordinateSpace: 'primary-display' | 'window'
  /** 提供 x、y 的那次截图返回的不透明标识。 */
  snapshotId: string
}

export type ComputerMoveOptions = ComputerGlobalMoveOptions | ComputerPrimaryDisplayMoveOptions

/** @AgentView 输入文字的结果：实际输入了多少个字符。 */
export interface ComputerTypeResult {
  typed: number
}

/** @AgentView 按键的结果：实际按下的键，按顺序。 */
export interface ComputerKeyResult {
  pressed: string[]
}

/** 桌面控制为什么不可用，交给智能体与界面按原因引导。 */
export type ComputerAvailabilityReason =
  | 'available'
  | 'unsupported-platform'
  | 'python-missing'
  | 'helper-missing'
  | 'dependencies-missing'
  | 'permission-missing'
  | 'spawn-failed'

/** 可用性探测的结构化结果；探测永不抛错，一切失败都落在这里。 */
export interface ComputerAvailability {
  available: boolean
  reason: ComputerAvailabilityReason
  detail: Nullable<string>
  permissions?: ComputerPermissionStatus
}

/** 当前平台上 Python helper 脚本与解释器的解析结果。 */
export interface ComputerHelperLaunchSpec {
  /** Python 解释器命令；来自宿主分发的自包含 Python。 */
  pythonCommand: string
  /** 平台 helper 脚本的绝对路径。 */
  helperScript: string
  /** helper 脚本目录，作为 cwd 以便共享模块导入能解析。 */
  runtimeDir: string
  /** 平台包根目录（含 Python、helper、package.json），供宿主管理资源。 */
  packageRoot: string
  /** 平台包版本（读取 package.json，缺省 0.0.0）。 */
  version: string
}

/** @AgentView 截图范围；省略 windowId 截主屏，窗口 id 从 windows 获取。 */
export interface ComputerScreenshotInput {
  windowId?: string
}

/** @AgentView 在 at 指定的位置滚轮滚动；正数向右/向下，负数向左/向上，单位是滚轮刻度，每轴绝对值最多 100。 */
export interface ComputerScrollInput {
  at: ComputerPoint
  deltaX?: number
  deltaY?: number
}

/** @AgentView 已完成的滚轮刻度，正号向右和向下。 */
export interface ComputerScrollResult {
  deltaX: number
  deltaY: number
}

/** @AgentView 原子拖拽完成回执。 */
export interface ComputerDragResult {
  dragged: boolean
}

/** @AgentView 原子拖拽：先校验两端的截图绑定，再按下、移动、保证松开；durationMs 为 100–3000，默认 500。 */
export interface ComputerDragInput {
  from: ComputerPoint
  to: ComputerPoint
  button?: 'left' | 'right' | 'middle'
  durationMs?: number
}

/** @AgentView 在 at 处按下鼠标；必须用 mouseUp 配对，最多保持 5000 毫秒后自动释放。 */
export interface ComputerMouseDownInput {
  at: ComputerPoint
  button?: 'left' | 'right' | 'middle'
}

/** @AgentView 释放鼠标按钮，默认 left；可重复调用。 */
export interface ComputerMouseUpInput {
  button?: 'left' | 'right' | 'middle'
}

/** @AgentView 按住或释放单个键（如 ctrl、shift）；组合键仍用 key。按住最多 5000 毫秒自动释放。 */
export interface ComputerKeyStateInput {
  key: string
}

/** @AgentView 输入状态回执；released 表示本次实际释放的键和鼠标按钮。 */
export interface ComputerInputState {
  held: string[]
  released: string[]
  leaseMs: number
}

/** @AgentView 矩形使用虚拟桌面全局坐标。 */
export interface ComputerBounds {
  x: number
  y: number
  width: number
  height: number
}

/** @AgentView 可见窗口，不透明 id 只在当前 helper 进程内有效。 */
export interface ComputerWindow {
  id: string
  title: string
  processId: number
  bounds: ComputerBounds
}

/** @AgentView 指定一个 windows 返回的窗口。 */
export interface ComputerWindowInput {
  windowId: string
}

/** @AgentView 控件树查询；maxDepth 为 1–12（默认 6），maxNodes 为 1–500（默认 200）；超出预算以 truncated 标明。 */
export interface ComputerTreeInput extends ComputerWindowInput {
  maxDepth?: number
  maxNodes?: number
}

/** @AgentView 扁平控件节点；不返回密码或输入框的值。节点 id 只用于同一次 treeId 下的语义操作。 */
export interface ComputerElement {
  id: string
  parentId?: string
  role: string
  name: string
  automationId: string
  bounds: ComputerBounds
  enabled: boolean
}

/** @AgentView 有界控件树；warnings 说明不可访问的子树，不能把截断结果视为完整界面。 */
export interface ComputerTree {
  treeId: string
  windowId: string
  nodes: ComputerElement[]
  truncated: boolean
  warnings: string[]
}

/** @AgentView 通过 UI 自动化激活控件；treeId、elementId 必须来自最近 30 秒内同一次 uiTree，不会回落成坐标点击。 */
export interface ComputerElementInput {
  treeId: string
  elementId: string
}

/** @AgentView 通过控件的 Value/AXValue 接口设置文本，最多 10000 个字符。 */
export interface ComputerElementValueInput extends ComputerElementInput {
  value: string
}

/** @AgentView 控件语义操作回执。 */
export interface ComputerElementAction {
  treeId: string
  elementId: string
  action: 'invoke' | 'set-value'
}

/** @AgentView 录制主屏或窗口到新的绝对路径 MP4；durationMs 为 100–5000，fps 为 1–10（默认 5）；不覆盖已有文件，不含音频。 */
export interface ComputerRecordInput extends ComputerScreenshotInput {
  path: string
  durationMs: number
  fps?: number
}

/** @AgentView 已完成并关闭编码器的录像；durationMs 为实际采集时长，fps 为编码帧率。 */
export interface ComputerRecording {
  path: string
  width: number
  height: number
  frames: number
  fps: number
  durationMs: number
  bytes: number
}

/** @AgentView 当前运行环境支持情况；能力不可用时会返回原因，调用不伪装成功。 */
export interface ComputerCapabilities {
  platform: string
  windows: boolean
  uiTree: boolean
  recording: boolean
  captureMode: 'visible-region' | 'window'
  limitations: string[]
}
