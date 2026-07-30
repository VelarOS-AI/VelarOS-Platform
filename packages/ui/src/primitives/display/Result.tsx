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
import { isPresent, optionalWhenLazy } from '../../lib/runtime'
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
  const size = 36
  switch (tone) {
    case 'success':
      return <CheckCircleIcon size={size} weight="duotone" aria-hidden />
    case 'warning':
      return <WarningCircleIcon size={size} weight="duotone" aria-hidden />
    case 'error':
      return <XCircleIcon size={size} weight="duotone" aria-hidden />
    default:
      return <InfoIcon size={size} weight="duotone" aria-hidden />
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
    // 不能写 `icon ?? (showIcon && <Icon/>)`：`showIcon=false` 时该式求得 `false`，
    // 而 `isPresent(false)` 为真（`false != null`），于是渲染出一个空的图标容器——
    // 它的尺寸与间距还在，版式塌不掉。用 optionalWhenLazy 让「不显示」真的表达为缺席。
    const leading = icon ?? optionalWhenLazy(showIcon, () => <DefaultResultIcon tone={t} />)

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
