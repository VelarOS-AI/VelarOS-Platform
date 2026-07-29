/**
 * 对话内统一动作 / 通知卡（能力层零件盒）：图标 + 标题 + 正文 + 动作 + 可选关闭。
 *
 * variants（封闭枚举，全仓共用一套）：`tone` = `neutral | info | success | warning | error`；`layout` = `row | stack`；`density` = `default | compact`。
 * 样式：`.velar-action-card` · 见 styles/components/。
 */
import React, { memo } from 'react'
import { XIcon } from '@phosphor-icons/react'
import { cva,type VariantProps } from 'class-variance-authority'

import { cn } from '@velaros-ai/ui/lib/cn'
import { IconButton, type IconButtonProps } from '@velaros-ai/ui/primitives/buttons/IconButton'
const actionCardVariants = cva('velar-action-card', {
  variants: {
    tone: {
      neutral: 'velar-action-card-tone-neutral',
      info: 'velar-action-card-tone-info',
      success: 'velar-action-card-tone-success',
      warning: 'velar-action-card-tone-warning',
      error: 'velar-action-card-tone-error',
    },
    /**
     * row（默认）：图标居中的单行卡，标题溢出省略——最简通知/确认卡。
     * stack：图标顶对齐、标题换行、正文纵向堆叠——富卡（含展开/footer/结论块）。
     * 取代各卡自写的 align-items/title-nowrap 覆盖与 grid+display:contents hack。
     */
    layout: {
      row: '',
      stack: 'velar-action-card-stack',
    },
    density: {
      default: '',
      compact: 'velar-action-card-compact',
    },
  },
  defaultVariants: {
    tone: 'neutral',
    layout: 'row',
    density: 'default',
  },
})

export interface ActionCardProps
  extends Omit<React.ComponentProps<'div'>, 'title'>, VariantProps<typeof actionCardVariants> {
  icon?: React.ReactNode
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  /** 存在时在卡右上角渲染统一的关闭按钮。 */
  onDismiss?: () => void
  dismissLabel?: string
  /** 已消费/失活态：整卡降不透明度（取代各卡自写的 .cardConsumed）。 */
  muted?: boolean
  iconClassName?: string
  bodyClassName?: string
  actionsClassName?: string
}

export const ActionCard = memo(
  ({
    className,
    tone,
    layout,
    density,
    icon,
    title,
    description,
    actions,
    onDismiss,
    dismissLabel,
    muted,
    children,
    iconClassName,
    bodyClassName,
    actionsClassName,
    ...props
  }: ActionCardProps): React.ReactElement => (
    <div
      className={cn(
        actionCardVariants({ tone, layout, density }),
        muted && 'velar-action-card-muted',
        onDismiss && 'velar-action-card-dismissable',
        className
      )}
      {...props}
    >
      {!!icon && (
        <div className={cn('velar-action-card-icon', iconClassName)} aria-hidden="true">
          {icon}
        </div>
      )}
      <div className={cn('velar-action-card-body', bodyClassName)}>
        <div className={'velar-action-card-main'}>
          <div className={'velar-action-card-title'}>{title}</div>
          {!!description && (
            <div className={'velar-action-card-description'}>{description}</div>
          )}
          {!!children && <div className={'velar-action-card-content'}>{children}</div>}
        </div>
        {!!actions && (
          <div className={cn('velar-action-card-actions', actionsClassName)}>{actions}</div>
        )}
      </div>
      {!!onDismiss && (
        <button
          type="button"
          className="velar-action-card-dismiss"
          aria-label={dismissLabel ?? 'Dismiss'}
          onClick={onDismiss}
        >
          <XIcon size={13} weight="bold" />
        </button>
      )}
    </div>
  )
)

ActionCard.displayName = 'ActionCard'

export type ActionCardCodeProps = React.ComponentProps<'code'>

export const ActionCardCode = memo(
  ({ className, ...props }: ActionCardCodeProps): React.ReactElement => (
    <code className={cn('velar-action-card-code', className)} {...props} />
  )
)

ActionCardCode.displayName = 'ActionCardCode'

export type ActionCardTextProps = React.ComponentProps<'div'>

export const ActionCardText = memo(
  ({ className, ...props }: ActionCardTextProps): React.ReactElement => (
    <div className={cn('velar-action-card-text', className)} {...props} />
  )
)

ActionCardText.displayName = 'ActionCardText'

export interface ActionCardIconButtonProps extends Omit<IconButtonProps, 'size' | 'variant'> {
  tone?: 'default' | 'danger'
}

export const ActionCardIconButton = memo(
  ({
    className,
    shape = 'round',
    tone = 'default',
    ...props
  }: ActionCardIconButtonProps): React.ReactElement => (
    <IconButton
      size="icon-sm"
      shape={shape}
      variant="ghost"
      className={cn(
        'velar-action-card-action-button',
        tone === 'danger' && 'velar-action-card-action-button-danger',
        className
      )}
      {...props}
    />
  )
)

ActionCardIconButton.displayName = 'ActionCardIconButton'
