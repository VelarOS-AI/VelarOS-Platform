/**
 * 锚定浮层：负责定位、外部交互和焦点生命周期。
 *
 * 样式：`.velar-popover-layer-id` · 见 styles/components/。
 */
import {
  cloneElement,
  type ComponentPropsWithoutRef,
  createContext,
  type CSSProperties,
  forwardRef,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type Ref,
  type RefAttributes,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { useEventListener, useLatest, useMemoizedFn } from 'ahooks'

import { cn } from '../../lib/cn'
import { isFunction, isPresent, optionalWhen, toNullable, toOptional } from '../../lib/runtime'
type PopoverSide = 'top' | 'right' | 'bottom' | 'left'
type PopoverAlign = 'start' | 'center' | 'end'
type PopoverWidthStrategy = 'content' | 'anchor' | 'adaptive'

interface PopoverContextValue {
  anchorElement: Nullable<HTMLElement>
  contentElement: Nullable<HTMLElement>
  onOpenChange: (open: boolean) => void
  open: boolean
  setAnchorElement: (node: Nullable<HTMLElement>) => void
  setContentElement: (node: Nullable<HTMLElement>) => void
}

interface PopoverProps {
  children: ReactNode
  onOpenChange: (open: boolean) => void
  open: boolean
}

interface PopoverAnchorProps extends ComponentPropsWithoutRef<'span'> {
  asChild?: boolean
}

interface PopoverContentProps extends Omit<ComponentPropsWithoutRef<'div'>, 'style'> {
  align?: PopoverAlign
  onCloseAutoFocus?: (event: Event) => void
  onInteractOutside?: (event: Event) => void
  onOpenAutoFocus?: (event: Event) => void
  side?: PopoverSide
  sideOffset?: number
  style?: CSSProperties
  viewportPadding?: number
  widthStrategy?: PopoverWidthStrategy
}

const PopoverContext = createContext<Nullable<PopoverContextValue>>(null)
const ModalInteractionLayerSelector =
  '[data-slot="dialog-content"], [data-slot="settings-panel-dialog"]'
const PopoverLayerSelector = '[data-velar-popover-layer-id]'
const ViewportPadding = 8

function usePopoverContext(componentName: string): PopoverContextValue {
  const context = useContext(PopoverContext)
  if (!context) {
    throw new Error(`${componentName} must be used inside Popover.`)
  }

  return context
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

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min

  return Math.min(Math.max(value, min), max)
}

function getElementWindow(element: Nullable<HTMLElement>): Window {
  return element?.ownerDocument.defaultView ?? window
}

function getPopoverPortalElement(anchorElement: Nullable<HTMLElement>): Nullable<HTMLElement> {
  if (!anchorElement) return toNullable(globalThis.document?.body)

  const modalInteractionLayer = anchorElement.closest<HTMLElement>(ModalInteractionLayerSelector)
  if (isPresent(modalInteractionLayer)) return modalInteractionLayer

  return anchorElement.ownerDocument.body
}

function isElementNodeForTarget(target: Nullable<EventTarget>, element: Nullable<HTMLElement>): target is Node {
  const ownerWindow = getElementWindow(element)
  return target instanceof (ownerWindow as Window & { Node: typeof Node }).Node
}

function getElementForTarget(
  target: Nullable<EventTarget>,
  element: Nullable<HTMLElement>
): Nullable<HTMLElement> {
  const ownerWindow = getElementWindow(element) as Window & {
    HTMLElement: typeof HTMLElement
    Node: typeof Node
  }
  if (!(target instanceof ownerWindow.Node)) return null
  if (target instanceof ownerWindow.HTMLElement) return target

  return target.parentElement
}

function getParentPopoverLayerId(anchorElement: Nullable<HTMLElement>): Nullable<string> {
  return toNullable(
    anchorElement
      ?.closest<HTMLElement>(PopoverLayerSelector)
      ?.dataset.velarPopoverLayerId
  )
}

function isNestedPopoverLayerTarget(
  target: Nullable<EventTarget>,
  anchorElement: Nullable<HTMLElement>,
  contentElement: Nullable<HTMLElement>
): boolean {
  const currentLayerId = contentElement?.dataset.velarPopoverLayerId
  if (!currentLayerId) return false

  const targetElement = getElementForTarget(target, anchorElement)
  const targetPopoverLayer = targetElement?.closest<HTMLElement>(PopoverLayerSelector)

  return targetPopoverLayer?.dataset.velarPopoverParentLayerId === currentLayerId
}

function getPosition(
  anchorElement: HTMLElement,
  contentElement: HTMLElement,
  widthStrategy: PopoverWidthStrategy,
  side: PopoverSide,
  align: PopoverAlign,
  sideOffset: number,
  viewportPadding: number,
  portalElement: HTMLElement
): CSSProperties {
  const ownerWindow = getElementWindow(anchorElement)
  const anchorRect = anchorElement.getBoundingClientRect()
  const contentRect = contentElement.getBoundingClientRect()
  const isBodyPortal = portalElement === ownerWindow.document.body
  const portalRect = optionalWhen(!isBodyPortal, portalElement.getBoundingClientRect())
  const originLeft = isPresent(portalRect) ? portalRect.left : 0
  const originTop = isPresent(portalRect) ? portalRect.top : 0
  const maxAvailableWidth = ownerWindow.innerWidth - viewportPadding * 2
  const contentWidth =
    widthStrategy === 'anchor'
      ? anchorRect.width
      : widthStrategy === 'adaptive'
        ? clamp(contentRect.width, anchorRect.width, maxAvailableWidth)
        : contentRect.width
  const contentHeight = contentRect.height
  let top = anchorRect.bottom + sideOffset
  let left = anchorRect.left

  if (side === 'top') {
    top = anchorRect.top - contentHeight - sideOffset
  } else if (side === 'left') {
    top = anchorRect.top
    left = anchorRect.left - contentWidth - sideOffset
  } else if (side === 'right') {
    top = anchorRect.top
    left = anchorRect.right + sideOffset
  }

  if (side === 'top' || side === 'bottom') {
    if (align === 'center') {
      left = anchorRect.left + (anchorRect.width - contentWidth) / 2
    } else if (align === 'end') {
      left = anchorRect.right - contentWidth
    }
  } else if (align === 'center') {
    top = anchorRect.top + (anchorRect.height - contentHeight) / 2
  } else if (align === 'end') {
    top = anchorRect.bottom - contentHeight
  }

  return {
    left:
      clamp(left, viewportPadding, ownerWindow.innerWidth - contentWidth - viewportPadding) -
      originLeft,
    maxWidth: optionalWhen((widthStrategy === 'adaptive'), maxAvailableWidth),
    minWidth:
      optionalWhen((widthStrategy === 'anchor' || widthStrategy === 'adaptive'), anchorRect.width),
    position: isBodyPortal ? 'fixed' : 'absolute',
    top:
      clamp(top, viewportPadding, ownerWindow.innerHeight - contentHeight - viewportPadding) -
      originTop,
    width: optionalWhen((widthStrategy === 'anchor'), anchorRect.width),
  }
}

export function Popover({ children, onOpenChange, open }: PopoverProps): ReactElement {
  const [anchorElement, setAnchorElement] = useState<Nullable<HTMLElement>>(null)
  const [contentElement, setContentElement] = useState<Nullable<HTMLElement>>(null)
  const contextValue: PopoverContextValue = {
    anchorElement,
    contentElement,
    onOpenChange,
    open,
    setAnchorElement,
    setContentElement,
  }

  return <PopoverContext.Provider value={contextValue}>{children}</PopoverContext.Provider>
}

export const PopoverAnchor = forwardRef<HTMLElement, PopoverAnchorProps>(
  ({ asChild = false, children, ...props }, ref): ReactElement => {
    const { setAnchorElement } = usePopoverContext('PopoverAnchor')
    // `optionalWhen` 是**急求值**（第二参在调用前就算完），非元素 children 会先命中
    // `undefined.ref` 而不是被条件挡住——非 asChild 分支本来就允许纯文本 children，
    // 那条路径曾 100% 抛 TypeError。这里用 `isValidElement` 的收窄结果直接取，
    // 谓词与收窄绑成一件事（§1.10），顺带消掉断言。同款正解见 Tooltip.tsx 的 `optionalWhenLazy`。
    const childRef = isValidElement<{ ref?: Ref<HTMLElement> }>(children)
      ? children.props.ref
      : undefined
    const composedRef = useMemo(
      () => composeRefs<HTMLElement>(ref, setAnchorElement),
      [ref, setAnchorElement]
    )
    const anchorRef = useMemo(
      () => (asChild ? composeRefs<HTMLElement>(childRef, composedRef) : composedRef),
      [asChild, childRef, composedRef]
    )

    if (asChild) {
      if (!isValidElement(children)) {
        throw new Error('PopoverAnchor with asChild expects a single React element.')
      }

      return cloneElement(children as ReactElement<RefAttributes<HTMLElement>>, {
        ref: anchorRef,
      })
    }

    return (
      <span {...props} ref={anchorRef}>
        {children}
      </span>
    )
  }
)

PopoverAnchor.displayName = 'PopoverAnchor'

export const PopoverContent = forwardRef<HTMLDivElement, PopoverContentProps>(
  (
    {
      align = 'start',
      children,
      className,
      onCloseAutoFocus,
      onInteractOutside,
      onOpenAutoFocus,
      side = 'bottom',
      sideOffset = 10,
      style,
      viewportPadding = ViewportPadding,
      widthStrategy,
      ...props
    },
    ref
  ): Nullable<ReactElement> => {
    const { anchorElement, contentElement, onOpenChange, open, setContentElement } =
      usePopoverContext('PopoverContent')
    const [positionStyle, setPositionStyle] = useState<CSSProperties>({
      left: 0,
      position: 'fixed',
      top: 0,
      visibility: 'hidden',
    })
    const [positionedContent, setPositionedContent] = useState<Nullable<HTMLElement>>(null)
    const wasOpenRef = useRef(open)
    const interactedOutsideRef = useRef(false)
    const openFocusRef = useRef<{
      opened: boolean
      handled: boolean
      previousActiveElement: Nullable<Element>
    }>({
      opened: false,
      handled: false,
      previousActiveElement: null,
    })
    const layerId = useId()
    const portalElement = getPopoverPortalElement(anchorElement)
    const parentPopoverLayerId = getParentPopoverLayerId(anchorElement)
    // Portals escape their anchor's DOM subtree, so any scoped theme tokens set on
    // an ancestor (e.g. a themed workbench region) are lost. Carry the nearest
    // `data-velar-theme-scope` onto the portalled content so app-level CSS can
    // re-apply the matching token set. App-agnostic: the attribute value is opaque.
    const themeScope =
      toOptional(
        anchorElement
          ?.closest<HTMLElement>('[data-velar-theme-scope]')
          ?.getAttribute('data-velar-theme-scope')
      )
    const composedRef = useMemo(
      () => composeRefs<HTMLDivElement>(ref, setContentElement),
      [ref, setContentElement]
    )

    const onCloseAutoFocusLatest = useLatest(onCloseAutoFocus)
    const onInteractOutsideLatest = useLatest(onInteractOutside)
    const onOpenAutoFocusLatest = useLatest(onOpenAutoFocus)
    const onOpenChangeLatest = useLatest(onOpenChange)

    const updatePosition = useCallback((): void => {
      if (!anchorElement || !contentElement || !portalElement) return

      setPositionStyle(
        getPosition(
          anchorElement,
          contentElement,
          widthStrategy ?? 'content',
          side,
          align,
          sideOffset,
          viewportPadding,
          portalElement
        )
      )
      setPositionedContent(contentElement)
    }, [
      align,
      anchorElement,
      contentElement,
      portalElement,
      side,
      sideOffset,
      viewportPadding,
      widthStrategy,
    ])

    const handleInteractPointerDown = useMemoizedFn((event: PointerEvent): void => {
      const target = event.target
      if (
        isElementNodeForTarget(target, anchorElement) &&
        (contentElement?.contains(target) || anchorElement?.contains(target))
      ) return

      if (isNestedPopoverLayerTarget(target, anchorElement, contentElement)) return

      onInteractOutsideLatest.current?.(event)
      if (!event.defaultPrevented) {
        interactedOutsideRef.current = true
        onOpenChangeLatest.current(false)
      }
    })

    const handleEscapeKeyDown = useMemoizedFn((event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        interactedOutsideRef.current = false
        onOpenChangeLatest.current(false)
      }
    })

    useLayoutEffect(() => {
      if (!open) return

      updatePosition()
    }, [open, updatePosition])

    useLayoutEffect(() => {
      const focus = openFocusRef.current
      if (!open) {
        focus.opened = false
        focus.handled = false
        focus.previousActiveElement = null
        return
      }

      const ownerDocument = anchorElement?.ownerDocument ?? contentElement?.ownerDocument
      if (!ownerDocument) return
      if (!focus.opened) {
        focus.opened = true
        focus.previousActiveElement = ownerDocument.activeElement
        interactedOutsideRef.current = false
      }
      if (focus.handled || !contentElement || positionedContent !== contentElement) return
      if (contentElement.getClientRects().length === 0
        || getElementWindow(contentElement).getComputedStyle(contentElement).visibility !== 'visible') return

      focus.handled = true
      const activeElement = ownerDocument.activeElement
      if (contentElement.contains(activeElement)) return
      if (activeElement && activeElement !== ownerDocument.body
        && activeElement !== focus.previousActiveElement) return

      // The owner chooses the focus target after positioning makes it visible.
      // A generic popover must not infer that its first input wants autofocus.
      const event = new Event('popover-open-auto-focus', { cancelable: true })
      onOpenAutoFocusLatest.current?.(event)
    }, [anchorElement, contentElement, onOpenAutoFocusLatest, open, positionedContent, style?.display, style?.visibility])

    useLayoutEffect(() => {
      if (!open || !anchorElement || !contentElement) return

      const ResizeObserverConstructor = globalThis.ResizeObserver
      if (!ResizeObserverConstructor) return

      const resizeObserver = new ResizeObserverConstructor(updatePosition)
      resizeObserver.observe(anchorElement)
      resizeObserver.observe(contentElement)

      return () => resizeObserver.disconnect()
    }, [anchorElement, contentElement, open, updatePosition])

    useEventListener(
      'resize',
      updatePosition,
      {
        enable: open && !!anchorElement,
        target: (): Window => getElementWindow(anchorElement),
      }
    )

    useEventListener(
      'scroll',
      updatePosition,
      {
        capture: true,
        enable: open && !!anchorElement,
        target: (): Window => getElementWindow(anchorElement),
      }
    )

    useEventListener(
      'pointerdown',
      handleInteractPointerDown,
      {
        capture: true,
        enable: open && !!anchorElement,
        target: (): Document => anchorElement?.ownerDocument ?? document,
      }
    )

    useEventListener(
      'keydown',
      handleEscapeKeyDown,
      {
        enable: open && !!anchorElement,
        target: (): Document => anchorElement?.ownerDocument ?? document,
      }
    )

    useEffect(() => {
      if (wasOpenRef.current && !open) {
        const event = new Event('popover-close-auto-focus', { cancelable: true })
        onCloseAutoFocusLatest.current?.(event)
        if (!event.defaultPrevented && !interactedOutsideRef.current) {
          // AnchoredPopover anchors a layout span; getAnchorProps marks the
          // actual control inside it with aria-expanded.
          const trigger = anchorElement?.querySelector<HTMLElement>('[aria-expanded]')
            ?? anchorElement
          trigger?.focus({ preventScroll: true })
        }
      }

      wasOpenRef.current = open
    }, [anchorElement, onCloseAutoFocusLatest, open])

    if (!open || !portalElement) return null

    return createPortal(
      <div
        ref={composedRef}
        data-slot="popover-content"
        data-velar-popover-layer-id={layerId}
        data-velar-popover-parent-layer-id={toOptional(parentPopoverLayerId)}
        data-velar-theme-scope={themeScope}
        className={cn('velar-popover-content', className)}
        style={{
          ...positionStyle,
          ...style,
        }}
        {...props}
      >
        {children}
      </div>,
      portalElement
    )
  }
)

PopoverContent.displayName = 'PopoverContent'
