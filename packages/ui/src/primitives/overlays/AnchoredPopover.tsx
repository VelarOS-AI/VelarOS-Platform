/**
 * 锚定浮层，相对触发元素定位。
 */
import {
  type ComponentPropsWithoutRef,
  type MouseEventHandler,
  type PointerEventHandler,
  type ReactElement,
  type ReactNode,
  type Ref,
  useCallback,
  useRef,
} from 'react'

import { Popover, PopoverAnchor, PopoverContent } from '@velaros-ai/ui/primitives/overlays/Popover'

import { isFunction } from '../../lib/runtime'

type PopoverContentProps = ComponentPropsWithoutRef<typeof PopoverContent>
type AnchorState = 'open' | 'closed'

interface AnchorControlOptions<T extends HTMLElement> {
  disabled?: boolean
  onClick?: MouseEventHandler<T>
  onPointerDown?: PointerEventHandler<T>
  onPointerEnter?: PointerEventHandler<T>
  onPointerLeave?: PointerEventHandler<T>
  ref?: Ref<T>
}

interface AnchorControlProps<T extends HTMLElement> {
  'aria-expanded': boolean
  'data-state': AnchorState
  onClick: MouseEventHandler<T>
  onPointerDown: PointerEventHandler<T>
  onPointerEnter: PointerEventHandler<T>
  onPointerLeave: PointerEventHandler<T>
  ref: (node: Nullable<T>) => void
}

export interface AnchoredPopoverAnchorProps {
  close: () => void
  getAnchorProps: <T extends HTMLElement>(
    options?: AnchorControlOptions<T>
  ) => AnchorControlProps<T>
  isAnchorTarget: (target: Nullable<EventTarget>) => boolean
  open: boolean
  setOpen: (open: boolean) => void
  toggleOpen: () => void
}

export interface AnchoredPopoverProps extends Omit<PopoverContentProps, 'children'> {
  anchor: (props: AnchoredPopoverAnchorProps) => ReactElement
  anchorClassName?: string
  children: ReactNode
  onOpenChange: (open: boolean) => void
  open: boolean
  preventAnchorOutsideClose?: boolean
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

export function AnchoredPopover({
  anchor,
  anchorClassName,
  children,
  onInteractOutside,
  onOpenChange,
  open,
  preventAnchorOutsideClose = true,
  ...contentProps
}: AnchoredPopoverProps): ReactElement {
  const anchorRef = useRef<HTMLElement>(null)

  const setOpen = useCallback((nextOpen: boolean): void => {
    onOpenChange(nextOpen)
  }, [onOpenChange])

  const close = useCallback((): void => {
    setOpen(false)
  }, [setOpen])

  const toggleOpen = useCallback((): void => {
    setOpen(!open)
  }, [open, setOpen])

  const isAnchorTarget = useCallback((target: Nullable<EventTarget>): boolean => target instanceof Node && !!anchorRef.current?.contains(target), [])

  const handleAnchorElement = useCallback((node: Nullable<HTMLElement>): void => {
    anchorRef.current = node
  }, [])

  const getAnchorProps = useCallback(
    <T extends HTMLElement>({
      disabled = false,
      onClick,
      onPointerDown,
      onPointerEnter,
      onPointerLeave,
      ref,
    }: AnchorControlOptions<T> = {}): AnchorControlProps<T> => ({
      'aria-expanded': open,
      'data-state': open ? 'open' : 'closed',
      onClick: (event) => {
        onClick?.(event)
        if (event.defaultPrevented || disabled) return

        event.preventDefault()
        if (event.detail === 0) {
          setOpen(!open)
        }
      },
      onPointerDown: (event) => {
        onPointerDown?.(event)
        if (event.defaultPrevented || disabled || event.button !== 0) return

        event.preventDefault()
        setOpen(!open)
      },
      onPointerEnter: (event) => {
        onPointerEnter?.(event)
      },
      onPointerLeave: (event) => {
        onPointerLeave?.(event)
      },
      ref: composeRefs<T>(ref),
    }),
    [open, setOpen]
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <span ref={handleAnchorElement} className={anchorClassName}>
          {anchor({
            close,
            getAnchorProps,
            isAnchorTarget,
            open,
            setOpen,
            toggleOpen,
          })}
        </span>
      </PopoverAnchor>
      <PopoverContent
        {...contentProps}
        onInteractOutside={(event) => {
          if (preventAnchorOutsideClose && isAnchorTarget(event.target)) {
            event.preventDefault()
            return
          }

          onInteractOutside?.(event)
        }}
      >
        {children}
      </PopoverContent>
    </Popover>
  )
}
