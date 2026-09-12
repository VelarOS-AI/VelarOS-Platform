/**
 * HoverCard 的开关状态机与选边计算：只认交互事件和计时器，不碰 DOM 与 React，时序可以脱离浏览器验证。
 *
 * 开：指针停在触发元素上、指针在气泡里、键盘聚焦触发元素、在气泡里按住拖选、选区落在气泡里——
 * 任一成立就该开着；全部结束才关。开和关都走延时：扫过不打扰，从触发元素移进气泡有缓冲。
 */
import type { TimerLease } from '../../lib/timerScope'

export type HoverCardSide = 'top' | 'bottom'

export interface HoverCardControllerPorts {
  /** 排一次延时回调，返回可取消的租约。 */
  schedule: (delayMs: number, callback: () => void) => Pick<TimerLease, 'cancel'>
  /** 当前的开、关延时（毫秒），每次排程时读取，跟随组件属性变化。 */
  readDelays: () => { openDelayMs: number; closeDelayMs: number }
  /** 选区是否落在气泡里：正在或刚刚选字准备复制时，指针移开也不能关。 */
  hasSelectionWithin: () => boolean
  onOpenChange: (open: boolean) => void
}

export interface HoverCardPlacementInput {
  preferredSide: HoverCardSide
  anchorTop: number
  anchorBottom: number
  cardHeight: number
  sideOffset: number
  viewportHeight: number
}

export interface HoverCardPlacement {
  side: HoverCardSide
  /** 所选一侧留给气泡的高度，写进 CSS 变量压住 max-height，放不下时气泡内部滚动而不是盖住触发元素。 */
  availableHeight: number
}

/** 气泡此刻被哪些交互「占用」。 */
interface HoverCardEngagement {
  triggerHovered: boolean
  cardHovered: boolean
  keyboardFocused: boolean
  pressedInCard: boolean
  /** 用户在仍停留于触发元素时主动关掉（Escape）；离开触发元素前不再自动弹出。 */
  dismissed: boolean
}

const ViewportPadding = 8
const MinAvailableHeight = 96

function createEngagement(): HoverCardEngagement {
  return {
    triggerHovered: false,
    cardHovered: false,
    keyboardFocused: false,
    pressedInCard: false,
    dismissed: false,
  }
}

/**
 * 同一时刻只留一个气泡：选中文字会把气泡钉住，用户转去停在另一行时，新气泡打开即收起旧的，
 * 不让两张详情叠在屏幕上。每个窗口有自己的模块实例，互不影响。
 */
let activeController: Nullable<HoverCardController> = null

export class HoverCardController {
  private engagement: HoverCardEngagement = createEngagement()
  private pending: Nullable<Pick<TimerLease, 'cancel'>> = null
  private opened = false
  private inactive = false
  private readonly ports: HoverCardControllerPorts

  public constructor(ports: HoverCardControllerPorts) {
    this.ports = ports
  }

  public get open(): boolean {
    return this.opened
  }

  /** 进入或在触发元素上移动都会调到这里；已在悬停中就不重排计时，弹出延时从首次进入算起。 */
  public pointerEnterTrigger(): void {
    if (this.engagement.triggerHovered) return

    this.engagement.triggerHovered = true
    this.reconcile()
  }

  public pointerLeaveTrigger(): void {
    this.engagement.triggerHovered = false
    this.releaseTrigger()
  }

  public focusTrigger(): void {
    if (this.engagement.keyboardFocused) return

    this.engagement.keyboardFocused = true
    this.reconcile()
  }

  public blurTrigger(): void {
    this.engagement.keyboardFocused = false
    this.releaseTrigger()
  }

  public pointerEnterCard(): void {
    this.engagement.cardHovered = true
    this.reconcile()
  }

  public pointerLeaveCard(): void {
    this.engagement.cardHovered = false
    this.reconcile()
  }

  /** 在气泡里按下开始拖选时，指针可能拖出气泡边界，按住期间不能关。 */
  public pressCard(): void {
    this.engagement.pressedInCard = true
    this.reconcile()
  }

  public releasePress(): void {
    if (!this.engagement.pressedInCard) return

    this.engagement.pressedInCard = false
    this.reconcile()
  }

  public selectionChanged(): void {
    this.reconcile()
  }

  /** 切走窗口时收不到指针离开事件，按离开处理，避免回来时残留一个没人看的气泡。 */
  public blurWindow(): void {
    this.engagement.triggerHovered = false
    this.engagement.cardHovered = false
    this.engagement.pressedInCard = false
    this.reconcile()
  }

  /** 外部点击或 Escape 请求关闭：立即关；仍停留在触发元素上时记为用户主动关掉。 */
  public requestClose(): void {
    this.engagement.cardHovered = false
    this.engagement.pressedInCard = false
    this.engagement.dismissed = this.engagement.triggerHovered || this.engagement.keyboardFocused
    this.apply(false)
  }

  public forceClose(): void {
    this.engagement = createEngagement()
    this.apply(false)
  }

  public setInactive(inactive: boolean): void {
    this.inactive = inactive
    if (inactive) this.forceClose()
  }

  /** 卸载时撤掉未到期的计时并让出「当前气泡」的位置；控制器本身仍可复用（StrictMode 会先卸再装）。 */
  public dispose(): void {
    this.cancelPending()
    if (activeController === this) activeController = null
  }

  private wantsOpen(): boolean {
    const engagement = this.engagement
    if (this.inactive || engagement.dismissed) return false

    return (
      engagement.triggerHovered ||
      engagement.cardHovered ||
      engagement.keyboardFocused ||
      engagement.pressedInCard ||
      this.ports.hasSelectionWithin()
    )
  }

  /** 交互状态变化后按当前意图排一次延时开或关；意图在等待期间又变了就放弃这次切换。 */
  private reconcile(): void {
    this.cancelPending()
    const shouldOpen = this.wantsOpen()
    if (shouldOpen === this.opened) return

    const delays = this.ports.readDelays()
    this.pending = this.ports.schedule(shouldOpen ? delays.openDelayMs : delays.closeDelayMs, () => {
      this.pending = null
      if (this.wantsOpen() === shouldOpen) this.apply(shouldOpen)
    })
  }

  private releaseTrigger(): void {
    if (!this.engagement.triggerHovered && !this.engagement.keyboardFocused) {
      this.engagement.dismissed = false
    }
    this.reconcile()
  }

  private apply(nextOpen: boolean): void {
    this.cancelPending()
    if (this.opened === nextOpen) return

    this.opened = nextOpen
    if (nextOpen) {
      const previous = activeController
      activeController = this
      if (previous && previous !== this) previous.forceClose()
    } else if (activeController === this) {
      activeController = null
    }
    this.ports.onOpenChange(nextOpen)
  }

  private cancelPending(): void {
    this.pending?.cancel()
    this.pending = null
  }
}

/**
 * 选择弹出方向：首选侧放得下就用首选侧；放不下且另一侧更宽裕时翻过去。
 * 同时给出所选一侧可用的高度，由 CSS 变量压住气泡 max-height。
 */
export function resolveHoverCardPlacement({
  preferredSide,
  anchorTop,
  anchorBottom,
  cardHeight,
  sideOffset,
  viewportHeight,
}: HoverCardPlacementInput): HoverCardPlacement {
  const spaceAbove = Math.max(0, anchorTop - sideOffset - ViewportPadding)
  const spaceBelow = Math.max(0, viewportHeight - anchorBottom - sideOffset - ViewportPadding)
  const preferredSpace = preferredSide === 'top' ? spaceAbove : spaceBelow
  const oppositeSpace = preferredSide === 'top' ? spaceBelow : spaceAbove
  const shouldFlip = cardHeight > preferredSpace && oppositeSpace > preferredSpace
  const oppositeSide: HoverCardSide = preferredSide === 'top' ? 'bottom' : 'top'

  return {
    side: shouldFlip ? oppositeSide : preferredSide,
    availableHeight: Math.max(MinAvailableHeight, shouldFlip ? oppositeSpace : preferredSpace),
  }
}
