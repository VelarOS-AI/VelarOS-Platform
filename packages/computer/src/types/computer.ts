/**
 * 桌面控制的可移植数据：经宿主端口、内核能力面与工具结果流过的形状。
 * 不 import、不带函数成员、不用 Node 专属类型，整个文件随 `./contracts` 入口出包。
 */

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
  /** 图片宽度（逻辑分辨率，等于 displayWidth）；模型工具把该局部坐标加 originX 后执行点击。 */
  width: number
  /** 图片高度（逻辑分辨率，等于 displayHeight）；模型工具把该局部坐标加 originY 后执行点击。 */
  height: number
  displayWidth: number
  displayHeight: number
  displayId: number
  originX: number
  originY: number
  scaleFactor: number
}

/** 指针移动后落在的全局坐标。 */
export interface ComputerMoveResult {
  x: number
  y: number
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

/** 坐标空间：主屏截图局部坐标，或虚拟桌面全局坐标。 */
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

export type ComputerClickOptions =
  | ComputerGlobalClickOptions
  | ComputerPrimaryDisplayClickOptions

/** 输入文本的结果：实际输入了多少个字符。 */
export interface ComputerTypeResult {
  typed: number
}

/** 按键的结果：实际按下的键序列。 */
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
  /** Python 解释器命令；来自随插件分发的自包含 venv。 */
  pythonCommand: string
  /** 平台 helper 脚本的绝对路径。 */
  helperScript: string
  /** helper 脚本目录，作为 cwd 以便共享模块导入能解析。 */
  runtimeDir: string
  /** 平台包根目录（含 venv、helper、package.json），供插件目录服务使用。 */
  packageRoot: string
  /** 平台包版本（读取 package.json，缺省 0.0.0）。 */
  version: string
  /** 是否命中了随包/随插件的 venv 解释器。 */
  bundledVenv: boolean
}
