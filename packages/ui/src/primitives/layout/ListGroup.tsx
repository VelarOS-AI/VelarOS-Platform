/**
 * 分组列表：分节 + 行。
 *
 * 样式：`.velar-list-group` · 见 styles/components/。
 */
import React, { memo } from 'react'

import { cn } from '../../lib/cn'
import { isPresent } from '../../lib/runtime'
export interface ListGroupProps extends React.ComponentProps<'div'> {
  header?: React.ReactNode
  footer?: React.ReactNode
}

export const ListGroup = memo(
  ({ className, header, footer, children, ...props }: ListGroupProps): React.ReactElement => (
    <div data-slot="list-group" className={cn('velar-list-group', className)} {...props}>
      {isPresent(header) && <div className={'velar-list-group-header'}>{header}</div>}
      <div className={'velar-list-group-body'} role="list">
        {children}
      </div>
      {isPresent(footer) && <div className={'velar-list-group-footer'}>{footer}</div>}
    </div>
  )
)

ListGroup.displayName = 'ListGroup'

export interface ListGroupItemProps extends React.ComponentProps<'div'> {
  interactive?: boolean
}

export const ListGroupItem = memo(
  ({ className, interactive = false, role, ...props }: ListGroupItemProps): React.ReactElement => (
    <div
      data-slot="list-group-item"
      role={role ?? 'listitem'}
      className={cn('velar-list-group-item', interactive && 'velar-list-group-item-interactive', className)}
      {...props}
    />
  )
)

ListGroupItem.displayName = 'ListGroupItem'
