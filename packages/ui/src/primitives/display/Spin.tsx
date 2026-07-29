/**
 * 旋转加载指示器。
 *
 * variants（封闭枚举，全仓共用一套）：`size` = `sm | md`。
 * 样式：`.velar-spin-icon-sm-root` · 见 styles/components/。
 */
import React, { memo } from 'react'
import { SpinnerGapIcon } from '@phosphor-icons/react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '../../lib/cn'
import { isPresent, optionalWhenLazy } from '../../lib/runtime'
const spinVariants = cva('', {
  variants: {
    size: {
      sm: 'velar-spin-icon-sm-root',
      md: '',
    },
  },
  defaultVariants: {
    size: 'md',
  },
})

export interface SpinProps extends React.ComponentProps<'div'>, VariantProps<typeof spinVariants> {
  spinning?: boolean
  tip?: React.ReactNode
}

export const Spin = memo(
  ({
    className,
    size,
    spinning = true,
    tip,
    children,
    ...props
  }: SpinProps): React.ReactElement => {
    const iconClass = cn('velar-spin-icon', size === 'sm' && 'velar-spin-icon-sm')

    if (!isPresent(children))
      return (
        <div
          data-slot="spin"
          role="status"
          className={cn('velar-spin-spin-only', spinVariants({ size }), className)}
          {...props}
        >
          {spinning && <SpinnerGapIcon className={iconClass} aria-hidden />}
          {isPresent(tip) && <span className={'velar-spin-tip'}>{tip}</span>}
        </div>
      )

    return (
      <div data-slot="spin" className={cn('velar-spin-wrapper', className)} {...props}>
        {spinning && (
          <div className={'velar-spin-mask'} aria-live="polite">
            <SpinnerGapIcon className={iconClass} aria-hidden />
            {isPresent(tip) && <span className={'velar-spin-tip'}>{tip}</span>}
          </div>
        )}
        <div className={optionalWhenLazy(spinning, () => 'velar-spin-content-dim')}>{children}</div>
      </div>
    )
  }
)

Spin.displayName = 'Spin'
