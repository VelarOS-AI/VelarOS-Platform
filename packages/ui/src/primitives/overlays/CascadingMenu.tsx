/**
 * 级联菜单（多级子菜单）。
 *
 * 样式：`.velar-cascading-menu-item` · 见 styles/components/。
 */
import React, {
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { useLatest, useUnmount } from 'ahooks'

import {
  AnchoredPopover,
  type AnchoredPopoverAnchorProps,
} from '@velaros-ai/ui/primitives/overlays/AnchoredPopover'

import { cn } from '../../lib/cn'
import { isEmpty,isFunction, optionalWhenLazy, toNullable } from '../../lib/runtime'
import { type TimerLease, TimerScope } from '../../lib/timerScope'

const cascadingMenuClasses = {
  item: 'velar-cascading-menu-item',
  itemLabel: 'velar-cascading-menu-item-label',
  check: 'velar-cascading-menu-check',
  count: 'velar-cascading-menu-count',
  disclosure: 'velar-cascading-menu-disclosure',
  header: 'velar-cascading-menu-header',
  sectionList: 'velar-cascading-menu-section-list',
  icon: 'velar-cascading-menu-icon',
  allowOverflowPanel: 'velar-cascading-menu-allow-overflow-panel',
  nestedSubmenuPanel: 'velar-cascading-menu-nested-submenu-panel',
} as const

const ViewportPadding = 8
const SubmenuViewportPadding = 16
const CascadingMenuPanelSelector =
  '.velar-cascading-menu-primary-panel, .velar-cascading-menu-submenu-panel'

type CascadingMenuSide = ComponentPropsWithoutRef<typeof AnchoredPopover>['side']
type CascadingMenuAlign = ComponentPropsWithoutRef<typeof AnchoredPopover>['align']
type CascadingMenuWidthStrategy = ComponentPropsWithoutRef<typeof AnchoredPopover>['widthStrategy']
type CascadingMenuAnchor = ComponentPropsWithoutRef<typeof AnchoredPopover>['anchor']

interface CascadingMenuPanelProps extends React.ComponentPropsWithoutRef<'div'> {
  [key: `data-${string}`]: string | undefined
  placementLevel?: number
  ref?: Ref<HTMLDivElement>
}
type CascadingMenuItemProps<T extends HTMLElement> = React.HTMLAttributes<T> & {
  [key: `data-${string}`]: string | undefined
}

export interface CascadingMenuRenderProps {
  activeSubmenuId: Nullable<string>
  classes: typeof cascadingMenuClasses
  close: () => void
  closeSubmenus: () => void
  getLeafItemProps: <T extends HTMLElement>(
    options?: CascadingMenuItemProps<T>
  ) => CascadingMenuItemProps<T>
  getPrimaryPanelProps: (options?: CascadingMenuPanelProps) => CascadingMenuPanelProps
  getSubmenuPanelProps: (options?: CascadingMenuPanelProps) => CascadingMenuPanelProps
  getSubmenuTriggerProps: <T extends HTMLElement>(
    submenuId: string,
    options?: CascadingMenuItemProps<T>
  ) => CascadingMenuItemProps<T>
  openSubmenu: (submenuId: Nullable<string>) => void
}

export interface CascadingMenuProps {
  activeSubmenuId: Nullable<string>
  align?: CascadingMenuAlign
  anchor: CascadingMenuAnchor
  anchorClassName?: string
  autoCloseOnPointerLeave?: boolean
  children: (props: CascadingMenuRenderProps) => ReactNode
  className?: string
  closeDelayMs?: number
  keyboardNavigation?: boolean
  onActiveSubmenuChange: (submenuId: Nullable<string>) => void
  onCloseSubmenus?: () => void
  onOpenChange: (open: boolean) => void
  open: boolean
  side?: CascadingMenuSide
  sideOffset?: number
  style?: CSSProperties
  submenuAlign?: 'top' | 'bottom' | 'trigger'
  viewportPadding?: number
  widthStrategy?: CascadingMenuWidthStrategy
}

const DefaultCloseDelayMs = 220

function composeHandler<EventType>(
  userHandler: Optional<((event: EventType) => void)>,
  menuHandler: (event: EventType) => void
): (event: EventType) => void {
  return (event) => {
    userHandler?.(event)
    menuHandler(event)
  }
}

function assignRef<T>(ref: LooseOptional<Ref<T>>, value: Nullable<T>): void {
  if (!ref) return

  if (isFunction(ref)) {
    ref(value)
    return
  }

  ;(ref as { current: Nullable<T> }).current = value
}

function getElementWindow(element: HTMLElement): Window {
  return element.ownerDocument.defaultView ?? window
}

function readCssNumber(element: HTMLElement, name: string, fallback: number): number {
  const raw = getElementWindow(element).getComputedStyle(element).getPropertyValue(name).trim()
  const value = Number.parseFloat(raw)

  return Number.isFinite(value) ? value : fallback
}

export function CascadingMenu({
  activeSubmenuId,
  align = 'start',
  anchor,
  anchorClassName,
  autoCloseOnPointerLeave = false,
  children,
  className,
  closeDelayMs = DefaultCloseDelayMs,
  keyboardNavigation = false,
  onActiveSubmenuChange,
  onCloseSubmenus,
  onOpenChange,
  open,
  side = 'bottom',
  sideOffset = 8,
  style,
  submenuAlign = 'bottom',
  viewportPadding,
  widthStrategy = 'content',
}: CascadingMenuProps): ReactElement {
  const closeTimerRef = useRef<TimerLease>(null)
  const menuGridRef = useRef<HTMLDivElement>(null)
  const timersRef = useRef<TimerScope>(null)
  const submenuPanelsRef = useRef(new Set<HTMLDivElement>())
  const [submenuAnchorTop, setSubmenuAnchorTop] = useState(0)
  const onActiveSubmenuChangeLatest = useLatest(onActiveSubmenuChange)
  const onCloseSubmenusLatest = useLatest(onCloseSubmenus)
  const onOpenChangeLatest = useLatest(onOpenChange)
  if (!timersRef.current) {
    timersRef.current = new TimerScope({ name: 'CascadingMenu' })
  }

  const clearSubmenuCloseTimer = useCallback((): void => {
    closeTimerRef.current?.cancel()
    closeTimerRef.current = null
  }, [])

  const closeSubmenus = useCallback((): void => {
    clearSubmenuCloseTimer()
    onActiveSubmenuChangeLatest.current(null)
    onCloseSubmenusLatest.current?.()
  }, [clearSubmenuCloseTimer])

  const scheduleSubmenuClose = useCallback((): void => {
    clearSubmenuCloseTimer()
    closeTimerRef.current =
      toNullable(timersRef.current?.after(closeDelayMs, () => {
        onActiveSubmenuChangeLatest.current(null)
        onCloseSubmenusLatest.current?.()
        closeTimerRef.current = null
      }))
  }, [clearSubmenuCloseTimer, closeDelayMs])

  const openSubmenu = useCallback(
    (submenuId: Nullable<string>): void => {
      clearSubmenuCloseTimer()
      onActiveSubmenuChangeLatest.current(submenuId)
    },
    [clearSubmenuCloseTimer]
  )

  const openSubmenuFromTrigger = useCallback(
    (submenuId: string, triggerElement: HTMLElement): void => {
      setSubmenuAnchorTop(triggerElement.offsetTop)
      openSubmenu(submenuId)
    },
    [openSubmenu]
  )

  const updateSubmenuPanelPlacement = useCallback((panel: HTMLDivElement): void => {
    const parent = panel.offsetParent

    if (!(parent instanceof HTMLElement)) {
      panel.dataset.submenuSide = 'right'
      return
    }

    const ownerWindow = getElementWindow(panel)
    const gap = readCssNumber(panel, '--cascading-menu-flyout-gap', 2)
    const panelWidth = panel.getBoundingClientRect().width
    const parentRect = parent.getBoundingClientRect()
    const rightEnd = parentRect.right + gap + panelWidth
    const leftStart = parentRect.left - gap - panelWidth
    const canOpenRight = rightEnd <= ownerWindow.innerWidth - ViewportPadding
    const canOpenLeft = leftStart >= ViewportPadding
    let submenuSide: 'right' | 'left'

    if (canOpenRight) {
      submenuSide = 'right'
    } else if (canOpenLeft) {
      submenuSide = 'left'
    } else {
      const rightSpace = ownerWindow.innerWidth - ViewportPadding - parentRect.right
      const leftSpace = parentRect.left - ViewportPadding
      submenuSide = rightSpace >= leftSpace ? 'right' : 'left'
    }

    panel.dataset.submenuSide = submenuSide

    const placementLevel = Number.parseInt(panel.dataset.cascadingMenuSubmenuLevel ?? '1', 10)
    const panelHeight = panel.getBoundingClientRect().height
    const minTop = SubmenuViewportPadding - parentRect.top
    const maxTop = Math.max(
      minTop,
      ownerWindow.innerHeight - SubmenuViewportPadding - parentRect.top - panelHeight
    )
    const requestedTop =
      placementLevel > 1
        ? 0
        : submenuAlign === 'trigger'
          ? submenuAnchorTop
          : submenuAlign === 'bottom'
            ? parent.clientHeight - panelHeight
            : 0
    const nextTop = Math.min(Math.max(requestedTop, minTop), maxTop)
    panel.style.setProperty('--cascading-menu-submenu-panel-top', `${nextTop}px`)
  }, [submenuAlign, submenuAnchorTop])

  const updateSubmenuPanelSides = useCallback((): void => {
    submenuPanelsRef.current.forEach(updateSubmenuPanelPlacement)
  }, [updateSubmenuPanelPlacement])

  const setMenuOpen = useCallback(
    (nextOpen: boolean): void => {
      if (!nextOpen) {
        closeSubmenus()
      }

      onOpenChangeLatest.current(nextOpen)
    },
    [closeSubmenus]
  )

  const close = useCallback((): void => {
    setMenuOpen(false)
  }, [setMenuOpen])

  const scheduleMenuClose = useCallback((): void => {
    clearSubmenuCloseTimer()
    closeTimerRef.current =
      toNullable(timersRef.current?.after(closeDelayMs, () => {
        setMenuOpen(false)
        closeTimerRef.current = null
      }))
  }, [clearSubmenuCloseTimer, closeDelayMs, setMenuOpen])

  const handleContentPointerLeave = useCallback(
    (event: PointerEvent<HTMLDivElement>): void => {
      const nextTarget = event.relatedTarget

      if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
        clearSubmenuCloseTimer()
        return
      }

      if (autoCloseOnPointerLeave) {
        scheduleMenuClose()
        return
      }

      scheduleSubmenuClose()
    },
    [autoCloseOnPointerLeave, clearSubmenuCloseTimer, scheduleMenuClose, scheduleSubmenuClose]
  )

  const menuAnchor = useCallback(
    (anchorProps: AnchoredPopoverAnchorProps): ReactElement =>
      anchor({
        ...anchorProps,
        getAnchorProps: (options) =>
          anchorProps.getAnchorProps({
            ...options,
            onPointerEnter: composeHandler(options?.onPointerEnter, () => {
              clearSubmenuCloseTimer()
            }),
            onPointerLeave: composeHandler(options?.onPointerLeave, () => {
              if (autoCloseOnPointerLeave) {
                scheduleMenuClose()
              }
            }),
          }),
      }),
    [anchor, autoCloseOnPointerLeave, clearSubmenuCloseTimer, scheduleMenuClose]
  )

  const handlePrimaryPointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>): void => {
      const target = event.target

      if (
        target instanceof Element &&
        target.closest('[data-cascading-menu-submenu-trigger="true"]')
      ) {
        clearSubmenuCloseTimer()
        return
      }

      scheduleSubmenuClose()
    },
    [clearSubmenuCloseTimer, scheduleSubmenuClose]
  )

  const getPrimaryPanelProps = useCallback(
    (options: CascadingMenuPanelProps = {}): CascadingMenuPanelProps => ({
      ...options,
      className: cn('velar-cascading-menu-primary-panel', options.className),
      onPointerMove: composeHandler(options.onPointerMove, handlePrimaryPointerMove),
    }),
    [handlePrimaryPointerMove]
  )

  const getSubmenuPanelProps = useCallback(
    (options: CascadingMenuPanelProps = {}): CascadingMenuPanelProps => {
      const { placementLevel = 1, ref, ...panelOptions } = options
      let currentNode: Nullable<HTMLDivElement> = null

      return {
        ...panelOptions,
        'data-cascading-menu-submenu-level': String(placementLevel),
        'data-submenu-side': 'right',
        className: cn('velar-cascading-menu-submenu-panel', options.className),
        ref: (node) => {
          if (currentNode) {
            submenuPanelsRef.current.delete(currentNode)
          }

          assignRef(ref, node)
          currentNode = node

          if (node) {
            submenuPanelsRef.current.add(node)
            updateSubmenuPanelPlacement(node)
          }
        },
        onPointerEnter: composeHandler(options.onPointerEnter, () => clearSubmenuCloseTimer()),
      }
    },
    [clearSubmenuCloseTimer, updateSubmenuPanelPlacement]
  )

  const getSubmenuTriggerProps = useCallback(
    <T extends HTMLElement>(
      submenuId: string,
      options: CascadingMenuItemProps<T> = {} as CascadingMenuItemProps<T>
    ): CascadingMenuItemProps<T> => ({
      ...options,
      'data-cascading-menu-submenu-trigger': 'true',
      'data-active': optionalWhenLazy((activeSubmenuId === submenuId), () => 'true'),
      'aria-expanded': activeSubmenuId === submenuId,
      onFocus: composeHandler(options.onFocus, (event) =>
        openSubmenuFromTrigger(submenuId, event.currentTarget)
      ),
      onPointerEnter: composeHandler(options.onPointerEnter, (event) =>
        openSubmenuFromTrigger(submenuId, event.currentTarget)
      ),
    }),
    [activeSubmenuId, openSubmenuFromTrigger]
  )

  const getLeafItemProps = useCallback(
    <T extends HTMLElement>(
      options: CascadingMenuItemProps<T> = {} as CascadingMenuItemProps<T>
    ): CascadingMenuItemProps<T> => ({
      ...options,
      onPointerEnter: composeHandler(options.onPointerEnter, () => scheduleSubmenuClose()),
    }),
    [scheduleSubmenuClose]
  )

  useEffect(() => {
    const menuGrid = menuGridRef.current
    if (!open || !keyboardNavigation || !menuGrid) return

    const activeMenuGrid = menuGrid
    const ownerDocument = activeMenuGrid.ownerDocument

    function getPanelItems(panel: HTMLElement): HTMLButtonElement[] {
      return Array.from(panel.querySelectorAll<HTMLButtonElement>('button')).filter(
        (item) =>
          item.closest(CascadingMenuPanelSelector) === panel &&
          !item.disabled &&
          item.getAttribute('aria-disabled') !== 'true'
      )
    }

    function focusMenuItem(item: HTMLButtonElement): void {
      item.focus({ preventScroll: true })
      item.scrollIntoView({ block: 'nearest' })
    }

    function handleKeyboardNavigation(event: KeyboardEvent): void {
      if (event.defaultPrevented) return

      if (event.key === 'Escape') {
        event.preventDefault()
        close()
        return
      }

      if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return

      const activeElement = ownerDocument.activeElement
      const focusedMenuElement =
        activeElement instanceof HTMLElement && activeMenuGrid.contains(activeElement)
          ? activeElement
          : null
      const focusedPanel = focusedMenuElement?.closest<HTMLElement>(CascadingMenuPanelSelector)

      if (
        event.key === 'Enter' &&
        focusedMenuElement instanceof HTMLButtonElement &&
        focusedMenuElement.dataset.cascadingMenuSubmenuTrigger === 'true'
      ) {
        const submenuPanel = Array.from(activeMenuGrid.children).find(
          (element) =>
            element instanceof HTMLElement &&
            element.classList.contains('velar-cascading-menu-submenu-panel')
        )
        const firstSubmenuItem =
          submenuPanel instanceof HTMLElement ? getPanelItems(submenuPanel)[0] : null

        if (firstSubmenuItem) {
          event.preventDefault()
          focusMenuItem(firstSubmenuItem)
        }
        return
      }

      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return

      const primaryPanel = Array.from(activeMenuGrid.children).find(
        (element) =>
          element instanceof HTMLElement &&
          element.classList.contains('velar-cascading-menu-primary-panel')
      )
      const navigationPanel = focusedPanel ?? primaryPanel
      if (!(navigationPanel instanceof HTMLElement)) return

      const items = getPanelItems(navigationPanel)
      if (isEmpty(items)) return

      event.preventDefault()
      const currentIndex =
        focusedMenuElement instanceof HTMLButtonElement ? items.indexOf(focusedMenuElement) : -1
      const nextIndex =
        currentIndex < 0
          ? event.key === 'ArrowDown'
            ? 0
            : items.length - 1
          : event.key === 'ArrowDown'
            ? (currentIndex + 1) % items.length
            : (currentIndex - 1 + items.length) % items.length
      const nextItem = items[nextIndex]
      if (!nextItem) return

      if (
        navigationPanel === primaryPanel &&
        nextItem.dataset.cascadingMenuSubmenuTrigger !== 'true'
      ) {
        closeSubmenus()
      }
      focusMenuItem(nextItem)
    }

    ownerDocument.addEventListener('keydown', handleKeyboardNavigation)
    return () => ownerDocument.removeEventListener('keydown', handleKeyboardNavigation)
  }, [close, closeSubmenus, keyboardNavigation, open])

  useUnmount(() => {
    timersRef.current?.dispose()
  })

  useLayoutEffect(() => {
    if (open) {
      updateSubmenuPanelSides()
    }
  })

  const submenuGridStyle =
    optionalWhenLazy((submenuAlign === 'trigger'), () => ({ '--cascading-menu-submenu-trigger-top': `${submenuAnchorTop}px` } as CSSProperties))

  return (
    <AnchoredPopover
      open={open}
      onOpenChange={setMenuOpen}
      anchorClassName={anchorClassName}
      className={cn('velar-cascading-menu-content', className)}
      side={side}
      align={align}
      sideOffset={sideOffset}
      viewportPadding={viewportPadding}
      widthStrategy={widthStrategy}
      style={style}
      anchor={menuAnchor}
      onPointerEnter={clearSubmenuCloseTimer}
      onPointerLeave={handleContentPointerLeave}
    >
      <div
        ref={menuGridRef}
        className={'velar-cascading-menu-grid'}
        data-submenu-align={submenuAlign}
        style={submenuGridStyle}
        onBlur={(event) => {
          const nextFocusedElement = event.relatedTarget

          if (
            nextFocusedElement instanceof Node &&
            event.currentTarget.contains(nextFocusedElement)
          ) return

          scheduleSubmenuClose()
        }}
      >
        {children({
          activeSubmenuId,
          classes: cascadingMenuClasses,
          close,
          closeSubmenus,
          getLeafItemProps,
          getPrimaryPanelProps,
          getSubmenuPanelProps,
          getSubmenuTriggerProps,
          openSubmenu,
        })}
      </div>
    </AnchoredPopover>
  )
}
