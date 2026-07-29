/**
 * 可折叠区块外框：头部 + 可展开内容。
 *
 * 样式：`.velar-collapsible-block-frame` · 见 styles/components/。
 */
import React, { memo } from 'react'
import { CaretRightIcon } from '@phosphor-icons/react'

import { cn } from '../../lib/cn'
export interface CollapsibleBlockFrameProps
  extends Omit<React.ComponentPropsWithoutRef<'section'>, 'title'> {
  open: boolean
  title: React.ReactNode
  meta?: React.ReactNode
  actions?: React.ReactNode
  expandLabel: string
  collapseLabel: string
  titleTooltip?: string
  headerClassName?: string
  contentClassName?: string
  onOpenChange: (open: boolean) => void
}

export const CollapsibleBlockFrame = memo(
  ({
    open,
    title,
    meta,
    actions,
    expandLabel,
    collapseLabel,
    titleTooltip,
    headerClassName,
    contentClassName,
    onOpenChange,
    className,
    children,
    ...props
  }: CollapsibleBlockFrameProps): React.ReactElement => {
    const label = open ? collapseLabel : expandLabel

    return (
      <section
        data-state={open ? 'open' : 'closed'}
        data-has-actions={!!actions}
        className={cn('velar-collapsible-block-frame', className)}
        {...props}
      >
        <div className={cn('velar-collapsible-block-frame-header', headerClassName)}>
          <button
            type="button"
            className={'velar-collapsible-block-frame-header-button'}
            aria-expanded={open}
            aria-label={label}
            title={titleTooltip}
            onClick={() => onOpenChange(!open)}
          >
            <CaretRightIcon size={14} weight="bold" className={'velar-collapsible-block-frame-caret'} />
            <span className={'velar-collapsible-block-frame-title'}>{title}</span>
            {!!meta && <span className={'velar-collapsible-block-frame-meta'}>{meta}</span>}
          </button>
          {!!actions && <div className={'velar-collapsible-block-frame-actions'}>{actions}</div>}
        </div>
        {open && (
          <div className={cn('velar-collapsible-block-frame-content', contentClassName)}>{children}</div>
        )}
      </section>
    )
  }
)

CollapsibleBlockFrame.displayName = 'CollapsibleBlockFrame'
