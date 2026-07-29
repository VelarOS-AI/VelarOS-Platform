/**
 * 面包屑导航路径。
 *
 * 样式：`.velar-breadcrumb-nav` · 见 styles/components/。
 */
import React, { memo } from 'react'

import { useUiLocalization } from '../../i18n/UiLocalizationProvider'
import { cn } from '../../lib/cn'
import { optionalWhenLazy } from '../../lib/runtime'
export interface BreadcrumbProps extends React.ComponentProps<'nav'> {}

export const Breadcrumb = memo(
  ({ className, children, ...props }: BreadcrumbProps): React.ReactElement => {
    const localization = useUiLocalization()

    return (
      <nav
        data-slot="breadcrumb"
        aria-label={localization.breadcrumb}
        className={cn('velar-breadcrumb-nav', className)}
        {...props}
      >
        <ol className={'velar-breadcrumb-list'}>{children}</ol>
      </nav>
    )
  }
)

Breadcrumb.displayName = 'Breadcrumb'

export interface BreadcrumbItemProps extends React.ComponentProps<'li'> {
  /** 为辅助技术标记当前页。 */
  current?: boolean
}

export const BreadcrumbItem = memo(
  ({ className, current = false, children, ...props }: BreadcrumbItemProps): React.ReactElement => (
    <li
      data-slot="breadcrumb-item"
      className={cn('velar-breadcrumb-item', current && 'velar-breadcrumb-item-current', className)}
      aria-current={optionalWhenLazy(current, () => 'page')}
      {...props}
    >
      {children}
    </li>
  )
)

BreadcrumbItem.displayName = 'BreadcrumbItem'

export interface BreadcrumbSeparatorProps extends Omit<React.ComponentProps<'li'>, 'children'> {
  children?: React.ReactNode
}

export const BreadcrumbSeparator = memo(
  ({ className, children, ...props }: BreadcrumbSeparatorProps): React.ReactElement => (
    <li
      data-slot="breadcrumb-separator"
      className={cn('velar-breadcrumb-sep', className)}
      aria-hidden
      {...props}
    >
      {children ?? '/'}
    </li>
  )
)

BreadcrumbSeparator.displayName = 'BreadcrumbSeparator'
