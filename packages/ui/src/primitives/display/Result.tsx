/**
 * 结果态大块反馈（成功 / 失败 / 信息），含图标、标题与动作。
 *
 * variants（封闭枚举，全仓共用一套）：`tone` = `info | success | warning | error`。
 * 样式：`.velar-result` · 见 styles/components/。
 */
import React, { memo } from 'react'
import {
  CheckCircleIcon,
  InfoIcon,
  WarningCircleIcon,
  XCircleIcon,
} from '@phosphor-icons/react'
import { cva,type VariantProps } from 'class-variance-authority'

import { cn } from '../../lib/cn'
import { isPresent } from '../../lib/runtime'
const resultVariants = cva('velar-result', {
  variants: {
    tone: {
      info: 'velar-result-tone-info',
      success: 'velar-result-tone-success',
      warning: 'velar-result-tone-warning',
      error: 'velar-result-tone-error',
    },
  },
  defaultVariants: {
    tone: 'info',
  },
})

function DefaultResultIcon({ tone }: { tone: NonNullable<VariantProps<typeof resultVariants>['tone']> }): React.ReactElement {
  const cls = 'shrink-0'
  const size = 36
  switch (tone) {
    case 'success':
      return <CheckCircleIcon className={cls} size={size} weight="duotone" aria-hidden />
    case 'warning':
      return <WarningCircleIcon className={cls} size={size} weight="duotone" aria-hidden />
    case 'error':
      return <XCircleIcon className={cls} size={size} weight="duotone" aria-hidden />
    default:
      return <InfoIcon className={cls} size={size} weight="duotone" aria-hidden />
  }
}

export interface ResultProps
  extends Omit<React.ComponentProps<'div'>, 'title'>,
    VariantProps<typeof resultVariants> {
  icon?: React.ReactNode
  title: React.ReactNode
  subTitle?: React.ReactNode
  extra?: React.ReactNode
  showIcon?: boolean
}

export const Result = memo(
  ({
    className,
    tone,
    icon,
    title,
    subTitle,
    extra,
    showIcon = true,
    children,
    ...props
  }: ResultProps): React.ReactElement => {
    const t = tone ?? 'info'
    const leading = icon ?? (showIcon && <DefaultResultIcon tone={t} />)

    return (
      <div data-slot="result" className={cn(resultVariants({ tone }), className)} {...props}>
        {isPresent(leading) && <div className={'velar-result-icon-wrap'}>{leading}</div>}
        <div className={'velar-result-title'}>{title}</div>
        {isPresent(subTitle) && <div className={'velar-result-subtitle'}>{subTitle}</div>}
        {children}
        {isPresent(extra) && <div className={'velar-result-extra'}>{extra}</div>}
      </div>
    )
  }
)

Result.displayName = 'Result'
