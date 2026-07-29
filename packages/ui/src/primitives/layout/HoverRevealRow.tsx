/**
 * 悬停显隐行：行尾动作在 hover 时露出。
 *
 * 样式：`.velar-hover-reveal-row` · 见 styles/components/。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'

import { cn } from '../../lib/cn'

interface HoverRevealRowRect {
  height: number
  left: number
  top: number
  width: number
}

export interface HoverRevealRowTargetProps<TElement extends HTMLElement = HTMLElement> {
  onBlur: React.FocusEventHandler<TElement>
  onFocus: React.FocusEventHandler<TElement>
  onMouseEnter: React.MouseEventHandler<TElement>
  onMouseLeave: React.MouseEventHandler<TElement>
}

export interface HoverRevealRowProps<TElement extends HTMLElement = HTMLElement> {
  children: (targetProps: HoverRevealRowTargetProps<TElement>) => React.ReactNode
  disabled?: boolean
  reveal: React.ReactNode
  revealClassName?: string
  revealPaddingLeft?: number | string
  revealStyle?: React.CSSProperties
  viewportPadding?: number
}

export function HoverRevealRow<TElement extends HTMLElement = HTMLElement>({
  children,
  disabled = false,
  reveal,
  revealClassName,
  revealPaddingLeft,
  revealStyle,
  viewportPadding = 12,
}: HoverRevealRowProps<TElement>): React.ReactElement {
  const [rect, setRect] = useState<Nullable<HoverRevealRowRect>>(null)

  useEffect(() => {
    if (disabled) {
      setRect(null)
    }
  }, [disabled])

  const showFromTarget = useCallback(
    (target: TElement): void => {
      if (disabled) return

      const nextRect = target.getBoundingClientRect()
      setRect({
        height: nextRect.height,
        left: nextRect.left,
        top: nextRect.top,
        width: nextRect.width,
      })
    },
    [disabled]
  )

  const targetProps = useMemo<HoverRevealRowTargetProps<TElement>>(
    () => ({
      onBlur: () => setRect(null),
      onFocus: (event) => showFromTarget(event.currentTarget),
      onMouseEnter: (event) => showFromTarget(event.currentTarget),
      onMouseLeave: () => setRect(null),
    }),
    [showFromTarget]
  )

  return (
    <>
      {children(targetProps)}
      {!!rect && (
        <div
          className={cn('velar-hover-reveal-row', revealClassName)}
          style={{
            ...revealStyle,
            height: rect.height,
            left: rect.left,
            maxWidth: `calc(100vw - ${rect.left}px - ${viewportPadding}px)`,
            minWidth: rect.width,
            paddingLeft: revealPaddingLeft,
            top: rect.top,
          }}
          aria-hidden="true"
        >
          {reveal}
        </div>
      )}
    </>
  )
}
