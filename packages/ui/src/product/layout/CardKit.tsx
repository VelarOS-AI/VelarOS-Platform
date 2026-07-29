/**
 * CardKit — 交互卡的可组合视觉零件。
 *
 * 配合 {@link ActionCard} 的 `layout="stack"` 使用：新卡=纯 JSX 组合，零新
 * module.css。所有 tone 着色统一走 ActionCard 的 `--action-card-accent` /
 * `--action-card-accent-soft` 变量机制（product.css），不再各卡硬编码 `--status-*`。
 */
import React, { memo } from 'react'
import { CaretRightIcon } from '@phosphor-icons/react'

import { cn } from '@velaros-ai/ui/lib/cn'
import { Button, type ButtonProps } from '@velaros-ai/ui/primitives/buttons/Button'

export type CardPillTone = 'neutral' | 'info' | 'success' | 'warning' | 'error'

const pillToneClass: Record<CardPillTone, string> = {
  neutral: 'velar-card-pill-neutral',
  info: 'velar-card-pill-info',
  success: 'velar-card-pill-success',
  warning: 'velar-card-pill-warning',
  error: 'velar-card-pill-error',
}

/** 状态胶囊：tone 着色的小圆角标签（状态、推荐等）。 */
export const CardStatusPill = memo(
  ({
    tone = 'neutral',
    size = 'default',
    className,
    children,
  }: {
    tone?: CardPillTone
    size?: 'default' | 'mini'
    className?: string
    children: React.ReactNode
  }): React.ReactElement => (
    <span
      className={cn(
        'velar-card-pill',
        size === 'mini' && 'velar-card-pill-mini',
        pillToneClass[tone],
        className
      )}
    >
      {children}
    </span>
  )
)
CardStatusPill.displayName = 'CardStatusPill'

/** 元信息行：图标 + 灰度小字（如「涉及 N 个文件」）。 */
export const CardMeta = memo(
  ({
    icon,
    className,
    children,
  }: {
    icon?: React.ReactNode
    className?: string
    children: React.ReactNode
  }): React.ReactElement => (
    <span className={cn('velar-card-meta', className)}>
      {!!icon && <span className="velar-card-meta-icon">{icon}</span>}
      {children}
    </span>
  )
)
CardMeta.displayName = 'CardMeta'

/** 展开器：带自动 caret 的 details/summary，隐藏原生 marker。 */
export const CardDisclosure = memo(
  ({
    summary,
    defaultOpen = false,
    className,
    summaryClassName,
    children,
  }: {
    summary: React.ReactNode
    defaultOpen?: boolean
    className?: string
    summaryClassName?: string
    children: React.ReactNode
  }): React.ReactElement => (
    <details className={cn('velar-card-disclosure', className)} open={defaultOpen}>
      <summary className={cn('velar-card-disclosure-summary', summaryClassName)}>
        <CaretRightIcon size={11} weight="bold" className="velar-card-disclosure-caret" />
        <span>{summary}</span>
      </summary>
      {children}
    </details>
  )
)
CardDisclosure.displayName = 'CardDisclosure'

/** 底部动作行：right（默认，靠右）或 between（两端）。 */
export const CardFooter = memo(
  ({
    align = 'right',
    className,
    children,
  }: {
    align?: 'right' | 'between'
    className?: string
    children: React.ReactNode
  }): React.ReactElement => (
    <div
      className={cn(
        'velar-card-footer',
        align === 'between' ? 'velar-card-footer-between' : 'velar-card-footer-right',
        className
      )}
    >
      {children}
    </div>
  )
)
CardFooter.displayName = 'CardFooter'

export type CardTextButtonTone = 'approve' | 'reject' | 'neutral'

const textButtonToneClass: Record<CardTextButtonTone, string> = {
  approve: 'velar-card-text-button-approve',
  reject: 'velar-card-text-button-reject',
  neutral: 'velar-card-text-button-neutral',
}

/** 卡内文字动作按钮：approve（绿）/reject（红）/neutral（次要灰）三态 ghost 钮。 */
export const CardTextButton = memo(
  ({
    tone = 'neutral',
    icon,
    className,
    children,
    ...props
  }: {
    tone?: CardTextButtonTone
    icon?: React.ReactNode
  } & Omit<ButtonProps, 'variant' | 'size'>): React.ReactElement => (
    <Button
      size="sm"
      variant="ghost"
      className={cn('velar-card-text-button', textButtonToneClass[tone], className)}
      {...props}
    >
      {!!icon && <span className="velar-card-text-button-icon">{icon}</span>}
      {children}
    </Button>
  )
)
CardTextButton.displayName = 'CardTextButton'

/** 结论/摘要块：tone 着色的整块文本（执行结果、错误摘要等）。 */
export const CardResultBlock = memo(
  ({
    tone = 'neutral',
    className,
    children,
    ...props
  }: {
    tone?: CardPillTone
    className?: string
    children: React.ReactNode
  } & Omit<React.ComponentProps<'div'>, 'children'>): React.ReactElement => (
    <div className={cn('velar-card-result', pillToneClass[tone], className)} {...props}>
      {children}
    </div>
  )
)
CardResultBlock.displayName = 'CardResultBlock'
