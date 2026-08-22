/**
 * 展开 / 收起披露原语（行为层，外貌由消费方给）。
 *
 * variants（封闭枚举，全仓共用一套）：`tone` = `neutral | running | success | warning | error`；`surface` = `card | muted`。
 * 样式：`.velar-disclosure` · 见 styles/components/。
 */
import React, { memo, useEffect, useRef, useState } from 'react'
import { CaretDownIcon } from '@phosphor-icons/react'
import { cva,type VariantProps } from 'class-variance-authority'

import { cn } from '../../lib/cn'
import { isBoolean, isNumber, isPresent, optionalWhenLazy } from '../../lib/runtime'
import { useDisclosurePresence } from '../../lib/useDisclosurePresence'
import { useIntersectionObserver } from '../../lib/useIntersectionObserver'
const disclosureVariants = cva('velar-disclosure', {
  variants: {
    tone: {
      neutral: 'velar-disclosure-tone-neutral',
      running: 'velar-disclosure-tone-running',
      success: 'velar-disclosure-tone-success',
      warning: 'velar-disclosure-tone-warning',
      error: 'velar-disclosure-tone-error',
    },
    /** 柔和表面匹配设置面板：无边框、浅灰底。 */
    surface: {
      card: '',
      muted: 'velar-disclosure-surface-muted',
    },
  },
  defaultVariants: {
    tone: 'neutral',
    surface: 'card',
  },
})

export interface DisclosureProps
  extends
    Omit<React.ComponentProps<'details'>, 'title' | 'open'>,
    VariantProps<typeof disclosureVariants> {
  title: React.ReactNode
  meta?: React.ReactNode
  description?: React.ReactNode
  defaultOpen?: boolean
  showDot?: boolean
  showCaret?: boolean
  disabled?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  contentMaxHeight?: number | string
  lazyContent?: boolean
  lazyRootMargin?: string
}

function toCssSize(value: Optional<number | string>): Optional<string> {
  if (!isPresent(value)) return undefined

  return isNumber(value) ? `${value}px` : value
}

export const Disclosure = memo(
  ({
    className,
    tone,
    surface,
    title,
    meta,
    description,
    defaultOpen = false,
    showDot = true,
    showCaret = true,
    disabled = false,
    children,
    open,
    onOpenChange,
    contentMaxHeight,
    lazyContent = false,
    lazyRootMargin = '720px 0px',
    style,
    ...props
  }: DisclosureProps): React.ReactElement => {
    const { ref: rootRef, isIntersecting } = useIntersectionObserver<HTMLDetailsElement>({
      rootMargin: lazyRootMargin,
      initialIsIntersecting: !lazyContent,
    })
    const isControlled = isBoolean(open)
    const [internalOpen, setInternalOpen] = useState(defaultOpen)
    const expanded = isControlled ? open : internalOpen
    const { mounted: isMounted, visible: isVisible } = useDisclosurePresence(expanded)
    const [contentHeight, setContentHeight] = useState(0)
    const contentInnerRef = useRef<HTMLDivElement>(null)
    const shouldRenderContent = isMounted && (!lazyContent || isIntersecting)

    useEffect(() => {
      if (!lazyContent || !shouldRenderContent) return undefined

      const content = contentInnerRef.current
      if (!content) return undefined

      const updateContentHeight = (): void => {
        setContentHeight(content.offsetHeight)
      }

      updateContentHeight()

      const win = globalThis.window
      if (!win?.ResizeObserver) return undefined

      const observer = new win.ResizeObserver(updateContentHeight)
      observer.observe(content)

      return () => observer.disconnect()
    }, [lazyContent, shouldRenderContent, children])

    const handleToggle = (): void => {
      if (disabled) return

      const nextOpen = !expanded
      if (!isControlled) {
        setInternalOpen(nextOpen)
      }
      onOpenChange?.(nextOpen)
    }

    const contentMaxHeightValue = toCssSize(contentMaxHeight)
    const rootStyle = contentMaxHeightValue
      ? ({
          ...style,
          '--disclosure-content-max-height': contentMaxHeightValue,
        } as React.CSSProperties)
      : style

    return (
      <details
        ref={rootRef}
        data-slot="disclosure"
        data-state={isVisible ? 'open' : 'closed'}
        data-tone={tone ?? 'neutral'}
className={cn(disclosureVariants({ tone, surface }), className)}
        open={isMounted}
        style={rootStyle}
        {...props}
      >
        <summary
          className={cn('velar-disclosure-summary', disabled && 'velar-disclosure-summary-disabled')}
          aria-disabled={disabled || undefined}
          tabIndex={optionalWhenLazy(disabled, () => -1)}
          onClick={(event) => {
            event.preventDefault()
            if (disabled) return
            handleToggle()
          }}
        >
          <div className={cn('velar-disclosure-summary-main', !showDot && 'velar-disclosure-summary-main-no-dot')}>
            {!!showDot && <span className={'velar-disclosure-dot'} />}
            <div className={'velar-disclosure-copy'}>
              <div className={'velar-disclosure-title-row'}>
                <div className={'velar-disclosure-title'}>{title}</div>
                {!!meta && <div className={'velar-disclosure-meta'}>{meta}</div>}
              </div>
              {!!description && <div className={'velar-disclosure-description'}>{description}</div>}
            </div>
          </div>
          {showCaret && (
            <span className={'velar-disclosure-caret-wrap'}>
              <CaretDownIcon size={14} className={'velar-disclosure-caret'} />
            </span>
          )}
        </summary>
        {isMounted && (
          <div className={'velar-disclosure-content-shell'}>
            <div className={'velar-disclosure-content'}>
              {shouldRenderContent ? (
                <div
                  ref={contentInnerRef}
                  className={cn(
                    'velar-disclosure-content-inner',
                    contentMaxHeightValue && 'velar-disclosure-content-inner-scrollable'
                  )}
                >
                  {children}
                </div>
              ) : (
                <div
                  className={'velar-disclosure-content-placeholder'}
                  style={optionalWhenLazy(contentHeight > 0, () => ({ height: contentHeight }))}
                />
              )}
            </div>
          </div>
        )}
      </details>
    )
  }
)

Disclosure.displayName = 'Disclosure'
