declare module 'velaros:computer' {
  /**
   * 桌面控制：看用户的主屏幕，在整台机器上移动指针、点击、输入文字、按组合键。
   * 先 screenshot：图交给你看，返回值里有 snapshotId；之后按这张图上量出的坐标 move、click 时原样带上它——helper 在真正动手前核对屏幕没变过，
   * 主屏、分辨率、缩放变了就拒绝，那就重新截图。要用虚拟桌面的全局坐标就写 coordinateSpace: 'global'，不带 snapshotId。
   * 桌面控制不可用（插件没装、没给系统权限）时调用抛错，message 说怎么办：照着告诉用户，不要自己去装依赖。
   * 网页里的东西用浏览器的能力，不要拿桌面截图代替。
   */

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

  /**
   * 一次截图：图本身交给你看（跟在程序结果后面，只看一次），这里是它的几何与 snapshotId。
   * width、height 是图的尺寸，也就是按截图量坐标的范围；按这张图上的坐标移动、点击时原样带上 snapshotId。
   * display 开头的几项与 origin、scaleFactor 说明这块主屏在虚拟桌面上的位置，一般用不着。
   */
  interface ComputerSnapshot {
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
   * 一个坐标，两种写法选一种：按截图量的（x、y 从截图左上角算，带上那次 screenshot 交回的 snapshotId），
   * 或者虚拟桌面的全局坐标（coordinateSpace 写 'global'、不带 snapshotId，可以为负）。坐标都是整数，绝对值不超过 20000。
   */
  type ComputerPoint =
    | { x: number; y: number; snapshotId: string; coordinateSpace?: 'primary-display' }
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

  /** 坐标空间：primary-display 是按截图量的坐标，global 是虚拟桌面的全局坐标。 */
  type ComputerCoordinateSpace = 'primary-display' | 'global'
}
