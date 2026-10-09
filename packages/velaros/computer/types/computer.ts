/**
 * 桌面控制的可移植数据：模型面（`velaros:computer` 的入参与回执，带 @AgentView 的那些）与经宿主端口、运行时流过的形状。
 * 不 import、不带函数成员、不用 Node 专属类型，整个文件随 `./computer/contracts` 入口出包。
 */

// ── 模型面：velaros:computer 的入参与回执 ─────────────────────────

/**
 * @AgentView
 * 一个坐标，两种写法选一种：按截图量的（x、y 从截图左上角算，带上那次 screenshot 交回的 snapshotId），
 * 或者虚拟桌面的全局坐标（coordinateSpace 写 'global'、不带 snapshotId，可以为负）。坐标都是整数，绝对值不超过 20000。
 */
export type ComputerPoint =
  | { x: number; y: number; snapshotId: string; coordinateSpace?: 'primary-display' }
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

/** @AgentView 坐标空间：primary-display 是按截图量的坐标，global 是虚拟桌面的全局坐标。 */
export type ComputerCoordinateSpace = 'primary-display' | 'global'

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
  coordinateSpace: 'primary-display'
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
  coordinateSpace: 'primary-display'
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
  /** 是否命中了随包解释器（兼容字段名）。 */
  bundledVenv: boolean
}
