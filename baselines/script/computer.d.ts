/**
 * 桌面控制：观察主屏、窗口与 UI 控件树，执行语义控件操作、键鼠输入、滚动拖拽并录制有限时长视频。
 * 先 capabilities 查平台限制，再 windows 选择目标窗口；有控件树时优先 uiTree / invokeElement / setElementValue。
 * screenshotWindow 的坐标必须写 coordinateSpace: 'window'；窗口移动或尺寸改变后旧绑定失效。
 * 先 screenshot：图交给你看，返回值里有 snapshotId；之后按这张图上量出的坐标 move、click 时原样带上它——helper 在真正动手前核对屏幕没变过，
 * 主屏、分辨率、缩放变了就拒绝，那就重新截图。要用虚拟桌面的全局坐标就写 coordinateSpace: 'global'，不带 snapshotId。
 * 桌面控制不可用（运行时缺失、没给系统权限）时调用抛错，message 说怎么办：照着告诉用户，不要自己去装依赖。
 * 手动按住输入用 try/finally 配对释放，最多保持 5000 毫秒；普通拖拽优先原子 drag。
 * 网页里的东西用浏览器的能力，不要拿桌面截图代替。
 */
declare module 'velaros:computer' {
  /** 查询本平台窗口、控件树和录像能力及限制。
   */
  export function capabilities(): Promise<ComputerCapabilities>

  /** 枚举可见窗口；id 只用于本 helper，失效后重新枚举。
   */
  export function windows(): Promise<ComputerWindow[]>

  /** 截取指定窗口。图经图片通道交给模型；图上坐标使用 coordinateSpace: 'window' 和本次 snapshotId。
   */
  export function screenshotWindow(input: ComputerWindowInput): Promise<ComputerSnapshot>

  /** 将指定窗口置前并聚焦；窗口身份失效时失败。
   */
  export function focusWindow(input: ComputerWindowInput): Promise<ComputerWindow>

  /** 在指定位置独立滚动；正数向右/下，负数向左/上，单位为滚轮刻度，每轴最多 100。
   */
  export function scroll(input: ComputerScrollInput): Promise<ComputerScrollResult>

  /** 原子拖拽，两端先校验再按下；durationMs 为 100–3000（默认 500），失败也释放鼠标。
   */
  export function drag(input: ComputerDragInput): Promise<ComputerDragResult>

  /** 在指定位置按下鼠标；用 mouseUp 配对，最多 5000 毫秒后自动释放。
   */
  export function mouseDown(input: ComputerMouseDownInput): Promise<ComputerInputState>

  /** 释放鼠标按钮；不需要旧截图，可以重复调用。
   */
  export function mouseUp(input: ComputerMouseUpInput): Promise<ComputerInputState>

  /** 按住单个键；必须用 keyUp 配对，最多 5000 毫秒后自动释放。
   */
  export function keyDown(input: ComputerKeyStateInput): Promise<ComputerInputState>

  /** 释放单个键；可重复调用。
   */
  export function keyUp(input: ComputerKeyStateInput): Promise<ComputerInputState>

  /** 释放此 helper 持有的全部键与鼠标按钮，用于错误恢复。
   */
  export function releaseInputs(): Promise<ComputerInputState>

  /** 查询窗口的 UI 控件树；maxDepth 最多 12，maxNodes 最多 500；检查 truncated 和 warnings。
   */
  export function uiTree(input: ComputerTreeInput): Promise<ComputerTree>

  /** 经控件的 Invoke/AXPress 语义激活；绑定 uiTree 的身份，过期或不支持时报错，不猜坐标。
   */
  export function invokeElement(input: ComputerElementInput): Promise<ComputerElementAction>

  /** 经 Value/AXValue 设置控件文本，最多 10000 字符；不会把文本当快捷键。
   */
  export function setElementValue(input: ComputerElementValueInput): Promise<ComputerElementAction>

  /** 录制主屏或窗口到新的绝对路径 MP4；durationMs 100–5000，fps 1–10；不覆盖，不含音频。
   */
  export function record(input: ComputerRecordInput): Promise<ComputerRecording>

  /** 截主屏：图交给你看（跟在程序结果后面，只看一次），返回值是它的几何与 snapshotId。
   */
  export function screenshot(): Promise<ComputerSnapshot>

  /** 把指针移到一个坐标，不点击（悬停用）。
   */
  export function move(input: ComputerPoint): Promise<ComputerMoved>

  /** 在一个坐标点击：按钮、菜单、输入框这类桌面元素。
   */
  export function click(input: ComputerClickInput): Promise<ComputerClicked>

  /** 在当前焦点处原样输入文字；先点一下输入框拿到焦点。组合键用 key。
   */
  export function typeText(input: ComputerTypeInput): Promise<ComputerTypeResult>

  /** 按一个键或组合键：Enter、Esc、Tab、快捷键。普通文字用 typeText。
   */
  export function key(input: ComputerKeyInput): Promise<ComputerKeyResult>

  /** 当前运行环境支持情况；能力不可用时会返回原因，调用不伪装成功。 */
  interface ComputerCapabilities {
    platform: string
    windows: boolean
    uiTree: boolean
    recording: boolean
    captureMode: 'visible-region' | 'window'
    limitations: string[]
  }

  /** 可见窗口，不透明 id 只在当前 helper 进程内有效。 */
  interface ComputerWindow {
    id: string
    title: string
    processId: number
    bounds: ComputerBounds
  }

  /** 指定一个 windows 返回的窗口。 */
  interface ComputerWindowInput {
    windowId: string
  }

  /**
   * 一次截图：图本身交给你看（跟在程序结果后面，只看一次），这里是它的几何与 snapshotId。
   * width、height 是图的尺寸，也就是按截图量坐标的范围；按这张图上的坐标移动、点击时原样带上 snapshotId。
   * display 开头的几项与 origin、scaleFactor 说明这块主屏在虚拟桌面上的位置，一般用不着。
   */
  interface ComputerSnapshot {
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

  /** 在 at 指定的位置滚轮滚动；正数向右/向下，负数向左/向上，单位是滚轮刻度，每轴绝对值最多 100。 */
  interface ComputerScrollInput {
    at: ComputerPoint
    deltaX?: number
    deltaY?: number
  }

  /** 已完成的滚轮刻度，正号向右和向下。 */
  interface ComputerScrollResult {
    deltaX: number
    deltaY: number
  }

  /** 原子拖拽：先校验两端的截图绑定，再按下、移动、保证松开；durationMs 为 100–3000，默认 500。 */
  interface ComputerDragInput {
    from: ComputerPoint
    to: ComputerPoint
    button?: 'left' | 'right' | 'middle'
    durationMs?: number
  }

  /** 原子拖拽完成回执。 */
  interface ComputerDragResult {
    dragged: boolean
  }

  /** 在 at 处按下鼠标；必须用 mouseUp 配对，最多保持 5000 毫秒后自动释放。 */
  interface ComputerMouseDownInput {
    at: ComputerPoint
    button?: 'left' | 'right' | 'middle'
  }

  /** 输入状态回执；released 表示本次实际释放的键和鼠标按钮。 */
  interface ComputerInputState {
    held: string[]
    released: string[]
    leaseMs: number
  }

  /** 释放鼠标按钮，默认 left；可重复调用。 */
  interface ComputerMouseUpInput {
    button?: 'left' | 'right' | 'middle'
  }

  /** 按住或释放单个键（如 ctrl、shift）；组合键仍用 key。按住最多 5000 毫秒自动释放。 */
  interface ComputerKeyStateInput {
    key: string
  }

  /** 控件树查询；maxDepth 为 1–12（默认 6），maxNodes 为 1–500（默认 200）；超出预算以 truncated 标明。 */
  interface ComputerTreeInput extends ComputerWindowInput {
    maxDepth?: number
    maxNodes?: number
  }

  /** 有界控件树；warnings 说明不可访问的子树，不能把截断结果视为完整界面。 */
  interface ComputerTree {
    treeId: string
    windowId: string
    nodes: ComputerElement[]
    truncated: boolean
    warnings: string[]
  }

  /** 通过 UI 自动化激活控件；treeId、elementId 必须来自最近 30 秒内同一次 uiTree，不会回落成坐标点击。 */
  interface ComputerElementInput {
    treeId: string
    elementId: string
  }

  /** 控件语义操作回执。 */
  interface ComputerElementAction {
    treeId: string
    elementId: string
    action: 'invoke' | 'set-value'
  }

  /** 通过控件的 Value/AXValue 接口设置文本，最多 10000 个字符。 */
  interface ComputerElementValueInput extends ComputerElementInput {
    value: string
  }

  /** 录制主屏或窗口到新的绝对路径 MP4；durationMs 为 100–5000，fps 为 1–10（默认 5）；不覆盖已有文件，不含音频。 */
  interface ComputerRecordInput extends ComputerScreenshotInput {
    path: string
    durationMs: number
    fps?: number
  }

  /** 已完成并关闭编码器的录像；durationMs 为实际采集时长，fps 为编码帧率。 */
  interface ComputerRecording {
    path: string
    width: number
    height: number
    frames: number
    fps: number
    durationMs: number
    bytes: number
  }

  /**
   * 按主屏截图量的坐标携带 screenshot 的 snapshotId；按窗口截图量的坐标携带 screenshotWindow 的 snapshotId，coordinateSpace 必须写 'window'。
   * 虚拟桌面的全局坐标写 coordinateSpace: 'global'，不带 snapshotId，可以为负。坐标都是整数，绝对值不超过 20000。
   */
  type ComputerPoint =
    | { x: number; y: number; snapshotId: string; coordinateSpace?: 'primary-display' }
    | { x: number; y: number; snapshotId: string; coordinateSpace: 'window' }
    | { x: number; y: number; coordinateSpace: 'global' }

  /**
   * 指针落在哪：x、y 是你给的那套坐标，globalX、globalY 是虚拟桌面上的实际位置；按截图坐标时还带着显示器与 snapshotId。
   */
  interface ComputerMoved {
    x: number
    y: number
    coordinateSpace: ComputerCoordinateSpace
    globalX: number
    globalY: number
    displayId?: number
    snapshotId?: string
  }

  /** 点击：坐标同 ComputerPoint；button 默认 left，count 默认 1（双击给 2，最多 3）。 */
  type ComputerClickInput = ComputerPoint & {
    button?: 'left' | 'right' | 'middle'
    count?: number
  }

  /** 点击的结果：落点同 ComputerMoved，另有按了哪个键、按了几下。 */
  interface ComputerClicked extends ComputerMoved {
    button: string
    count: number
  }

  /** 要输入的文字：原样输入到当前焦点处，一次最多 10000 个字符。 */
  interface ComputerTypeInput {
    text: string
  }

  /** 输入文字的结果：实际输入了多少个字符。 */
  interface ComputerTypeResult {
    typed: number
  }

  /** 按键：一个键或用 + 连起来的组合键，比如 enter、esc、tab、cmd+a、ctrl+shift+t，最多 100 个字符。 */
  interface ComputerKeyInput {
    keys: string
  }

  /** 按键的结果：实际按下的键，按顺序。 */
  interface ComputerKeyResult {
    pressed: string[]
  }

  /** 矩形使用虚拟桌面全局坐标。 */
  interface ComputerBounds {
    x: number
    y: number
    width: number
    height: number
  }

  /** 扁平控件节点；不返回密码或输入框的值。节点 id 只用于同一次 treeId 下的语义操作。 */
  interface ComputerElement {
    id: string
    parentId?: string
    role: string
    name: string
    automationId: string
    bounds: ComputerBounds
    enabled: boolean
  }

  /** 截图范围；省略 windowId 截主屏，窗口 id 从 windows 获取。 */
  interface ComputerScreenshotInput {
    windowId?: string
  }

  /** 坐标空间：primary-display 为主屏截图，window 为窗口截图，global 为虚拟桌面全局坐标。 */
  type ComputerCoordinateSpace = 'primary-display' | 'window' | 'global'
}
