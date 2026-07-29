/**
 * 分隔线（含可选标题）。
 *
 * 样式：`.velar-divider-vertical-dashed` · 见 styles/components/。
 */
import React, { memo } from 'react'

import { cn } from '../../lib/cn'
import { isPresent } from '../../lib/runtime'
export interface DividerProps extends Omit<React.ComponentProps<'div'>, 'children'> {
  type?: 'solid' | 'dashed'
  orientation?: 'horizontal' | 'vertical'
  children?: React.ReactNode
}

export const Divider = memo(
  ({
    className,
    type = 'solid',
    orientation = 'horizontal',
    children,
    role = 'separator',
    'aria-orientation': ariaOrientation,
    ...props
  }: DividerProps): React.ReactElement => {
    if (orientation === 'vertical') return (
        <div
          data-slot="divider"
          role={role}
          aria-orientation={ariaOrientation ?? 'vertical'}
          className={cn(
            type === 'dashed' ? 'velar-divider-vertical-dashed' : 'velar-divider-vertical',
            className
          )}
          {...props}
        />
      )

    if (!isPresent(children)) return (
        <div
          data-slot="divider"
          role={role}
          aria-orientation={ariaOrientation ?? 'horizontal'}
          className={cn(
            'velar-divider',
            'velar-divider-horizontal',
            type === 'dashed' ? 'velar-divider-horizontal-dashed' : 'velar-divider-horizontal-plain',
            className
          )}
          {...props}
        />
      )

    return (
      <div
        data-slot="divider"
        role={role}
        aria-orientation={ariaOrientation ?? 'horizontal'}
        className={cn('velar-divider', 'velar-divider-horizontal', 'velar-divider-with-label', className)}
        {...props}
      >
        <span
          className={cn('velar-divider-line', type === 'dashed' && 'velar-divider-line-dashed')}
          aria-hidden
        />
        <span className={'velar-divider-label'}>{children}</span>
        <span
          className={cn('velar-divider-line', type === 'dashed' && 'velar-divider-line-dashed')}
          aria-hidden
        />
      </div>
    )
  }
)

Divider.displayName = 'Divider'
