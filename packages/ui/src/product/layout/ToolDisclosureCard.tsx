/**
 * 工具披露卡（可展开工具详情）。
 *
 * 样式：`.velar-tool-disclosure-card` · 见 styles/components/。
 */
import React, { memo } from 'react'

import { cn } from '@velaros-ai/ui/lib/cn'
import type { DisclosureProps } from '@velaros-ai/ui/primitives/layout/Disclosure'
import { Disclosure } from '@velaros-ai/ui/primitives/layout/Disclosure'
type ToolDisclosureTone = 'neutral' | 'running' | 'success' | 'warning' | 'error'
const DEFAULT_TOOL_DISCLOSURE_CONTENT_MAX_HEIGHT = 420

interface ToolDisclosureCardProps extends Pick<
  DisclosureProps,
  | 'children'
  | 'className'
  | 'defaultOpen'
  | 'open'
  | 'onOpenChange'
  | 'contentMaxHeight'
  | 'lazyContent'
  | 'lazyRootMargin'
  | 'showCaret'
  | 'disabled'
  | 'onClick'
> {
  statusTone?: ToolDisclosureTone
  statusIcon?: React.ReactNode
  leadingIcon?: React.ReactNode
  title: React.ReactNode
  meta?: React.ReactNode
  subtitle?: React.ReactNode
}

export const ToolDisclosureCard = memo(
  ({
    className,
    statusTone = 'neutral',
    statusIcon,
    leadingIcon,
    title,
    meta,
    subtitle,
    children,
    defaultOpen = false,
    open,
    onOpenChange,
    contentMaxHeight = DEFAULT_TOOL_DISCLOSURE_CONTENT_MAX_HEIGHT,
    lazyContent = true,
    lazyRootMargin,
    showCaret,
    disabled,
    onClick,
  }: ToolDisclosureCardProps): React.ReactElement => (
      <Disclosure
        className={cn('velar-tool-disclosure-card', className)}
        tone={statusTone}
        defaultOpen={defaultOpen}
        open={open}
        onOpenChange={onOpenChange}
        contentMaxHeight={contentMaxHeight}
        lazyContent={lazyContent}
        lazyRootMargin={lazyRootMargin}
        showDot={false}
        showCaret={showCaret}
        disabled={disabled}
        onClick={onClick}
        title={
          <div className={'velar-tool-disclosure-card-header-layout'}>
            <div className={'velar-tool-disclosure-card-header-main'}>
              <div className={'velar-tool-disclosure-card-title-row'}>
                {!!statusIcon && (
                  <span
                    className={cn(
                      'velar-tool-disclosure-card-status-icon',
                      statusTone === 'running' && 'velar-tool-disclosure-card-status-icon-running',
                      statusTone === 'success' && 'velar-tool-disclosure-card-status-icon-success',
                      statusTone === 'warning' && 'velar-tool-disclosure-card-status-icon-warning',
                      statusTone === 'error' && 'velar-tool-disclosure-card-status-icon-error'
                    )}
                  >
                    {statusIcon}
                  </span>
                )}
                {!!leadingIcon && <span className={'velar-tool-disclosure-card-leading-icon'}>{leadingIcon}</span>}
                <div className={'velar-tool-disclosure-card-title-label'}>{title}</div>
                {!!meta && <div className={'velar-tool-disclosure-card-meta'}>{meta}</div>}
              </div>
              {!!subtitle && <div className={'velar-tool-disclosure-card-subtitle'}>{subtitle}</div>}
            </div>
          </div>
        }
        description={undefined}
      >
        {children}
      </Disclosure>
    )
)

ToolDisclosureCard.displayName = 'ToolDisclosureCard'
