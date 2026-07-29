/**
 * 悬停提示气泡（基于 Radix Tooltip）。
 *
 * 样式：`.velar-tooltip-content` · 见 styles/components/。
 */
import {
  cloneElement,
  type ComponentPropsWithoutRef,
  type ElementRef,
  forwardRef,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type Ref,
  useCallback,
  useMemo,
  useState,
} from 'react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'

import { cn } from '../../lib/cn'
import { isFunction, optionalWhenLazy,toOptional } from '../../lib/runtime'
const TooltipProvider = TooltipPrimitive.Provider
const Tooltip = TooltipPrimitive.Root
const TooltipTrigger = TooltipPrimitive.Trigger

export interface TooltipContentProps
  extends ComponentPropsWithoutRef<typeof TooltipPrimitive.Content> {
  arrowClassName?: string
  arrowWidth?: number
  arrowHeight?: number
  hideArrow?: boolean
  portalContainer?: LooseOptional<HTMLElement>
}

export const TooltipContent = forwardRef<
  ElementRef<typeof TooltipPrimitive.Content>,
  TooltipContentProps
>(
  (
    {
      className,
      sideOffset = 8,
      children,
      arrowClassName,
      arrowWidth = 10,
      arrowHeight = 6,
      hideArrow = false,
      portalContainer,
      ...props
    },
    ref
  ): ReactElement => (
    <TooltipPrimitive.Portal container={toOptional(portalContainer)}>
      <TooltipPrimitive.Content
        ref={ref}
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn('velar-tooltip-content', className)}
        {...props}
      >
        {children}
        {!hideArrow && (
          <TooltipPrimitive.Arrow
            className={cn('velar-tooltip-arrow', arrowClassName)}
            width={arrowWidth}
            height={arrowHeight}
          />
        )}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
)

TooltipContent.displayName = TooltipPrimitive.Content.displayName

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

type TooltipTriggerRefProp = {
  ref?: Ref<HTMLElement>
}

export interface BubbleTooltipProps {
  children: ReactElement
  content: ReactNode
  ariaLabel?: string
  delayDuration?: number
  disableHoverableContent?: boolean
  /** 触发器保持挂载但不弹内容——供按条件启用的气泡使用，避免包裹层增减导致子树重挂载。 */
  disabled?: boolean
  side?: TooltipContentProps['side']
  align?: TooltipContentProps['align']
  sideOffset?: number
  contentClassName?: string
  arrowClassName?: string
  arrowWidth?: number
  arrowHeight?: number
}

export function BubbleTooltip({
  children,
  content,
  ariaLabel,
  delayDuration = 120,
  disableHoverableContent = true,
  disabled = false,
  side = 'top',
  align = 'center',
  sideOffset = 8,
  contentClassName,
  arrowClassName,
  arrowWidth = 10,
  arrowHeight = 6,
}: BubbleTooltipProps): ReactElement {
  const [portalContainer, setPortalContainer] = useState<Nullable<HTMLElement>>(null)
  const handleTriggerRef = useCallback((node: Nullable<HTMLElement>): void => {
    if (!node) return

    const nextContainer = node.ownerDocument.body
    setPortalContainer((currentContainer) =>
      currentContainer === nextContainer ? currentContainer : nextContainer
    )
  }, [])
  const childRef = optionalWhenLazy(isValidElement<TooltipTriggerRefProp>(children), () =>
    (children.props as TooltipTriggerRefProp).ref
  )
  const composedTriggerRef = useMemo(
    () => composeRefs(childRef, handleTriggerRef),
    [childRef, handleTriggerRef]
  )
  const trigger = isValidElement<TooltipTriggerRefProp>(children)
    ? cloneElement(children, {
        ref: composedTriggerRef,
      })
    : children

  return (
    <TooltipProvider
      delayDuration={delayDuration}
      disableHoverableContent={disableHoverableContent}
    >
      <Tooltip disableHoverableContent={disableHoverableContent}>
        <TooltipTrigger asChild>{trigger}</TooltipTrigger>
        {!disabled && (
          <TooltipContent
            side={side}
            align={align}
            sideOffset={sideOffset}
            portalContainer={portalContainer}
            className={cn('velar-tooltip-bubble', contentClassName)}
            arrowClassName={cn('velar-tooltip-bubble-arrow', arrowClassName)}
            arrowWidth={arrowWidth}
            arrowHeight={arrowHeight}
            aria-label={ariaLabel}
          >
            {content}
          </TooltipContent>
        )}
      </Tooltip>
    </TooltipProvider>
  )
}

export {
  Tooltip,
  TooltipProvider,
  TooltipTrigger,
}
