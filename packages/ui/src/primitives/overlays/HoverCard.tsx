/**
 * 可悬停详情气泡：指针在触发元素上停留片刻后弹出，移进气泡本身时保持打开，气泡里的文字可读可选；
 * 键盘聚焦触发元素同样弹出。定位、滚动跟随、外部点击与 Escape 关闭复用 Popover，开关时序由
 * `hoverCardController` 的状态机决定。
 *
 * 与 BubbleTooltip 的分工：BubbleTooltip 是一句话提示，指针离开触发元素即关；HoverCard 承载需要
 * 细看、复制的多行内容，所以要能「追进去」，选中文字后也不会在复制前消失。
 *
 * 样式：`.velar-hover-card` · 见 styles/components/。
 */
import {
  cloneElement,
  type CSSProperties,
  type FocusEvent,
  isValidElement,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useEventListener, useLatest } from 'ahooks'

import { Popover, PopoverAnchor, PopoverContent } from '@velaros-ai/ui/primitives/overlays/Popover'

import {
  isBoolean,
  isEmpty,
  isFunction,
  isPresent,
  isString,
  optionalWhen,
  optionalWhenLazy,
  toNullable,
} from '../../lib/runtime'
import { TimerScope } from '../../lib/timerScope'

import {
  HoverCardController,
  type HoverCardPlacement,
  type HoverCardSide,
  resolveHoverCardPlacement,
} from './hoverCardController'

export type { HoverCardSide } from './hoverCardController'
export type HoverCardAlign = 'start' | 'center' | 'end'
export type HoverCardWidthStrategy = 'content' | 'anchor'

export interface HoverCardProps {
  /** 触发元素：单个能接收 ref 与指针、焦点事件的元素（通常就是被描述的那一行）。 */
  children: ReactElement
  /** 气泡内容；为空时触发元素照常渲染但不弹出。 */
  content: ReactNode
  /** 触发器保持挂载但不弹出——按条件启用时避免包裹层增减导致子树重挂载。 */
  disabled?: boolean
  /** 指针停留多久才弹出；指针只是扫过触发元素时不打扰。 */
  openDelayMs?: number
  /** 指针离开触发元素与气泡后多久关闭；留出从触发元素移进气泡的时间。 */
  closeDelayMs?: number
  /** 首选弹出方向；该侧放不下而另一侧更宽裕时自动翻到另一侧。 */
  side?: HoverCardSide
  align?: HoverCardAlign
  sideOffset?: number
  /**
   * 气泡宽度：`content` 按内容自适应（有上限）；`anchor` 与触发元素等宽，触发元素变宽变窄
   * （拖分隔条、窗口缩放）时跟着同步。
   */
  widthStrategy?: HoverCardWidthStrategy
}

interface HoverCardTriggerBindings {
  ref?: Ref<HTMLElement>
  onBlur?: (event: FocusEvent<HTMLElement>) => void
  onFocus?: (event: FocusEvent<HTMLElement>) => void
  onPointerEnter?: (event: PointerEvent<HTMLElement>) => void
  onPointerLeave?: (event: PointerEvent<HTMLElement>) => void
  onPointerMove?: (event: PointerEvent<HTMLElement>) => void
  'aria-describedby'?: string
  'data-hover-card-open'?: boolean
}

const DefaultOpenDelayMs = 300
const DefaultCloseDelayMs = 200
const DefaultSideOffset = 6
const AvailableHeightVariable = '--velar-hover-card-available-height'
const AnchorWidthVariable = '--velar-hover-card-anchor-width'

function hasRenderableContent(content: ReactNode): boolean {
  if (!isPresent(content) || isBoolean(content)) return false

  return !isString(content) || !isEmpty(content)
}

/** 所选一侧的可用高度与首帧的触发元素宽度，都以 CSS 变量交给样式层。 */
function toSurfaceStyle(
  placement: Nullable<HoverCardPlacement>,
  anchorWidth: Nullable<number>
): Optional<CSSProperties> {
  const variables: Record<string, string> = {}
  if (placement) variables[AvailableHeightVariable] = `${placement.availableHeight}px`
  if (isPresent(anchorWidth)) variables[AnchorWidthVariable] = `${anchorWidth}px`

  return isEmpty(Object.keys(variables)) ? undefined : (variables as CSSProperties)
}

function assignRef<T>(ref: LooseOptional<Ref<T>>, value: Nullable<T>): void {
  if (!ref) return

  if (isFunction(ref)) {
    ref(value)
    return
  }

  ;(ref as { current: Nullable<T> }).current = value
}

function composeRefs<T>(...refs: Array<LooseOptional<Ref<T>>>): (node: Nullable<T>) => void {
  return (node) => {
    refs.forEach((ref) => assignRef(ref, node))
  }
}

function composeHandlers<EventType>(
  ownHandler: Optional<(event: EventType) => void>,
  cardHandler: (event: EventType) => void
): (event: EventType) => void {
  return (event) => {
    ownHandler?.(event)
    cardHandler(event)
  }
}

function mergeDescribedBy(existing: Optional<string>, contentId: string): string {
  return existing ? `${existing} ${contentId}` : contentId
}

function isNodeWithin(container: Nullable<Element>, target: Nullable<EventTarget>): boolean {
  if (!container || !target) return false

  return container.contains(target as Node)
}

/** 只有键盘带来的焦点才弹出：鼠标点一下行不该在指针悬停之外再开一条通道。 */
function isKeyboardFocus(target: EventTarget): boolean {
  const element = target as Partial<Element>
  return isFunction(element.matches) && element.matches(':focus-visible')
}

function hasSelectionWithin(element: Nullable<HTMLElement>): boolean {
  const selection = element?.ownerDocument.getSelection()
  if (!element || !selection || selection.isCollapsed) return false

  return isNodeWithin(element, selection.anchorNode) || isNodeWithin(element, selection.focusNode)
}

/** 触屏没有悬停；按着按键拖选正文时扫过也不算悬停，松开后在行内移动再补上。 */
function isHoverPointer(event: PointerEvent<HTMLElement>): boolean {
  return event.pointerType !== 'touch' && event.buttons === 0
}

function preventFocusRestore(event: Event): void {
  // 悬停气泡从不接管焦点，关闭时也就不该把焦点「还」给触发元素。
  event.preventDefault()
}

export function HoverCard({
  children,
  content,
  disabled = false,
  openDelayMs = DefaultOpenDelayMs,
  closeDelayMs = DefaultCloseDelayMs,
  side = 'top',
  align = 'start',
  sideOffset = DefaultSideOffset,
  widthStrategy = 'content',
}: HoverCardProps): ReactElement {
  const [open, setOpen] = useState(false)
  const [placement, setPlacement] = useState<Nullable<HoverCardPlacement>>(null)
  const [anchorWidth, setAnchorWidth] = useState<Nullable<number>>(null)
  const contentId = useId()
  const triggerRef = useRef<Nullable<HTMLElement>>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const timersRef = useRef<Nullable<TimerScope>>(null)
  const settingsRef = useLatest({ openDelayMs, closeDelayMs, widthStrategy })
  const inactive = disabled || !hasRenderableContent(content)
  const [controller] = useState(
    () =>
      new HoverCardController({
        schedule: (delayMs, callback) => {
          // 卸载会释放作用域（StrictMode 下还会先卸再装一次），用到时按需重建。
          if (!timersRef.current || timersRef.current.isDisposed) {
            timersRef.current = new TimerScope({ name: 'HoverCard' })
          }
          return timersRef.current.after(delayMs, callback)
        },
        readDelays: () => settingsRef.current,
        hasSelectionWithin: () => hasSelectionWithin(contentRef.current),
        onOpenChange: (nextOpen) => {
          // 等宽模式下首帧就按触发元素的宽度排版，选边时量到的高度才是最终宽度下的高度；
          // 打开之后的宽度变化由 Popover 跟随触发元素实时写入。
          if (nextOpen && settingsRef.current.widthStrategy === 'anchor') {
            setAnchorWidth(toNullable(triggerRef.current?.getBoundingClientRect().width))
          }
          setOpen(nextOpen)
          // 下次打开要按不受上次限高影响的自然高度重新选边。
          if (!nextOpen) setPlacement(null)
        },
      })
  )

  useEffect(() => {
    controller.setInactive(inactive)
  }, [controller, inactive])

  useEffect(
    () => () => {
      controller.dispose()
      timersRef.current?.dispose()
      timersRef.current = null
    },
    [controller]
  )

  // 首帧量出气泡的自然高度再选边：子组件 PopoverContent 的布局 effect 先跑，这里在绘制前改方向，不闪。
  useLayoutEffect(() => {
    if (!open) return

    const trigger = triggerRef.current
    const card = contentRef.current
    if (!trigger || !card) return

    const anchorRect = trigger.getBoundingClientRect()
    setPlacement(
      resolveHoverCardPlacement({
        preferredSide: side,
        anchorTop: anchorRect.top,
        anchorBottom: anchorRect.bottom,
        cardHeight: card.getBoundingClientRect().height,
        sideOffset,
        viewportHeight: trigger.ownerDocument.defaultView?.innerHeight ?? 0,
      })
    )
  }, [open, side, sideOffset])

  const childRef = optionalWhenLazy(isValidElement<HoverCardTriggerBindings>(children), () =>
    (children.props as HoverCardTriggerBindings).ref
  )
  const composedTriggerRef = useMemo(
    () =>
      composeRefs<HTMLElement>(childRef, (node) => {
        triggerRef.current = node
      }),
    [childRef]
  )

  if (!isValidElement<HoverCardTriggerBindings>(children)) return <>{children}</>

  const childProps = children.props
  const trigger = cloneElement(children, {
    ref: composedTriggerRef,
    onBlur: composeHandlers(childProps.onBlur, (event: FocusEvent<HTMLElement>) => {
      // 焦点只是在触发元素内部移动（比如移到行里的复制按钮）不算离开。
      if (!isNodeWithin(event.currentTarget, event.relatedTarget)) controller.blurTrigger()
    }),
    onFocus: composeHandlers(childProps.onFocus, (event: FocusEvent<HTMLElement>) => {
      if (isKeyboardFocus(event.target)) controller.focusTrigger()
    }),
    onPointerEnter: composeHandlers(childProps.onPointerEnter, (event: PointerEvent<HTMLElement>) => {
      if (isHoverPointer(event)) controller.pointerEnterTrigger()
    }),
    onPointerLeave: composeHandlers(childProps.onPointerLeave, (event: PointerEvent<HTMLElement>) => {
      if (event.pointerType !== 'touch') controller.pointerLeaveTrigger()
    }),
    onPointerMove: composeHandlers(childProps.onPointerMove, (event: PointerEvent<HTMLElement>) => {
      if (isHoverPointer(event)) controller.pointerEnterTrigger()
    }),
    'aria-describedby': open
      ? mergeDescribedBy(childProps['aria-describedby'], contentId)
      : childProps['aria-describedby'],
    'data-hover-card-open': optionalWhen(open, true),
  })

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        // Popover 只会请求关闭（外部点击或 Escape）。
        if (!nextOpen) controller.requestClose()
      }}
    >
      <PopoverAnchor asChild>{trigger}</PopoverAnchor>
      {open && (
        <HoverCardSurface
          controller={controller}
          contentId={contentId}
          contentRef={contentRef}
          getOwnerDocument={() => triggerRef.current?.ownerDocument ?? document}
          placement={placement}
          side={side}
          align={align}
          sideOffset={sideOffset}
          widthStrategy={widthStrategy}
          anchorWidth={widthStrategy === 'anchor' ? anchorWidth : null}
        >
          {content}
        </HoverCardSurface>
      )}
    </Popover>
  )
}

/** 打开期间才挂载的气泡本体：文档级监听只在有气泡时存在，关着的行不背这些监听和定位逻辑。 */
function HoverCardSurface({
  controller,
  contentId,
  contentRef,
  getOwnerDocument,
  placement,
  side,
  align,
  sideOffset,
  widthStrategy,
  anchorWidth,
  children,
}: {
  controller: HoverCardController
  contentId: string
  contentRef: Ref<HTMLDivElement>
  getOwnerDocument: () => Document
  placement: Nullable<HoverCardPlacement>
  side: HoverCardSide
  align: HoverCardAlign
  sideOffset: number
  widthStrategy: HoverCardWidthStrategy
  anchorWidth: Nullable<number>
  children: ReactNode
}): ReactElement {
  useEventListener('pointerup', () => controller.releasePress(), { target: getOwnerDocument })
  useEventListener('pointercancel', () => controller.releasePress(), { target: getOwnerDocument })
  useEventListener('selectionchange', () => controller.selectionChanged(), {
    target: getOwnerDocument,
  })
  useEventListener('blur', () => controller.blurWindow(), {
    target: () => getOwnerDocument().defaultView ?? window,
  })

  return (
    <PopoverContent
      ref={contentRef}
      id={contentId}
      role="tooltip"
      className="velar-hover-card"
      data-width-strategy={widthStrategy}
      side={placement?.side ?? side}
      align={align}
      sideOffset={sideOffset}
      // Popover 的 anchor 宽度策略跟随触发元素的实际宽度（尺寸观察 + 窗口缩放）实时写入 width。
      widthStrategy={widthStrategy}
      style={toSurfaceStyle(placement, anchorWidth)}
      onCloseAutoFocus={preventFocusRestore}
      onPointerDown={(event) => {
        if (event.button === 0) controller.pressCard()
      }}
      onPointerEnter={(event) => {
        if (event.pointerType !== 'touch') controller.pointerEnterCard()
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== 'touch') controller.pointerLeaveCard()
      }}
    >
      {children}
    </PopoverContent>
  )
}
