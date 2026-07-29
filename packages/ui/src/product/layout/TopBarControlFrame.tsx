/**
 * 顶栏控制视觉框架，两款产品各自组合动作与状态。
 *
 * 样式：`.velar-topbar-control-frame` · 见 styles/components/。
 */
import type { HTMLAttributes, ReactElement, ReactNode } from 'react'

import { cn } from '../../lib/cn'

export interface TopBarControlFrameProps extends Omit<HTMLAttributes<HTMLDivElement>, 'className'> {
  accent?: boolean
  busy?: boolean
  children: ReactNode
  className?: string
  plain?: boolean
  tone?: 'default' | 'muted'
}

export interface TopBarControlSlotProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'className'> {
  children: ReactNode
  className?: string
}

/** Desktop 与 Workbench 可独立组合的无状态顶栏控制框架。 */
export function TopBarControlFrame({
  accent = true,
  busy = false,
  children,
  className,
  plain = false,
  tone = 'default',
  ...props
}: TopBarControlFrameProps): ReactElement {
  return (
    <div
      {...props}
      className={cn(
        'velar-topbar-control-frame',
        accent && !plain && 'velar-topbar-control-frame-accent',
        busy && 'velar-topbar-control-frame-busy',
        plain && 'velar-topbar-control-frame-plain',
        tone === 'muted' && 'velar-topbar-control-frame-muted',
        className
      )}
    >
      {children}
    </div>
  )
}

export function TopBarControlMain({
  children,
  className,
  ...props
}: TopBarControlSlotProps): ReactElement {
  return (
    <span {...props} className={cn('velar-topbar-control-main', className)}>
      {children}
    </span>
  )
}

export function TopBarControlActionGroup({
  children,
  className,
  ...props
}: TopBarControlSlotProps): ReactElement {
  return (
    <span {...props} className={cn('velar-topbar-control-action-group', className)}>
      {children}
    </span>
  )
}

export function TopBarControlDivider({
  className,
  ...props
}: Omit<HTMLAttributes<HTMLSpanElement>, 'className'> & {
  className?: string
}): ReactElement {
  return (
    <span {...props} className={cn('velar-topbar-control-divider', className)} aria-hidden="true" />
  )
}

export function getTopBarControlActionButtonClassName(className?: string): string {
  return cn('velar-topbar-control-action-button', className)
}

export function getTopBarControlMainButtonClassName(className?: string): string {
  return cn('velar-topbar-control-main-button', className)
}

export function getTopBarControlMainClassName(className?: string): string {
  return cn('velar-topbar-control-main', className)
}

export function getTopBarControlPanelClassName(className?: string): string {
  return cn('velar-topbar-control-panel', className)
}
