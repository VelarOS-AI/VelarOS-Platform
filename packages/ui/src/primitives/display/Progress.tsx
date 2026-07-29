/**
 * 线性进度条，表达确定性完成度。
 *
 * variants（封闭枚举，全仓共用一套）：`size` = `sm | md`；`tone` = `primary | neutral | success | warning | error`。
 * 样式：`.velar-progress-size-sm` · 见 styles/components/。
 */
import React, { memo } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { useUiLocalization } from '../../i18n/UiLocalizationProvider'
import { cn } from '../../lib/cn'
import { optionalWhen, optionalWhenLazy } from '../../lib/runtime'
const progressVariants = cva('', {
  variants: {
    size: {
      sm: 'velar-progress-size-sm',
      md: 'velar-progress-size-md',
    },
    tone: {
      primary: '',
      neutral: 'velar-progress-tone-neutral',
      success: 'velar-progress-tone-success',
      warning: 'velar-progress-tone-warning',
      error: 'velar-progress-tone-error',
    },
  },
  defaultVariants: {
    size: 'md',
    tone: 'primary',
  },
})

export interface ProgressProps
  extends React.ComponentProps<'div'>, VariantProps<typeof progressVariants> {
  /** 0–100 when not `indeterminate` */
  value?: number
  indeterminate?: boolean
}

export const Progress = memo(
  ({
    className,
    size,
    tone,
    value = 0,
    indeterminate = false,
    ...props
  }: ProgressProps): React.ReactElement => {
    const pct = Math.min(100, Math.max(0, value))
    const resolvedTone = tone ?? 'primary'
    const localization = useUiLocalization()

    return (
      <div
        data-slot="progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={optionalWhen(!indeterminate, pct)}
        aria-label={
          indeterminate ? localization.loading : localization.progressPercent(Math.round(pct))
        }
        className={cn(progressVariants({ size, tone: resolvedTone }), className)}
        {...props}
      >
        <div className={'velar-progress-track'}>
          <div
            className={cn('velar-progress-fill', indeterminate && 'velar-progress-indeterminate')}
            style={optionalWhenLazy(!indeterminate, () => ({ width: `${pct}%` }))}
          />
        </div>
      </div>
    )
  }
)

Progress.displayName = 'Progress'
