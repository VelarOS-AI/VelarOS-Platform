/**
 * 键值描述列表。
 *
 * 样式：`.velar-description-list` · 见 styles/components/。
 */
import React, { memo } from 'react'

import { cn } from '../../lib/cn'
export interface DescriptionListProps extends React.ComponentProps<'div'> {
  bordered?: boolean
  /** 单列时标签堆叠在值上方；双列时宽屏使用标签和值分列。 */
  columns?: 1 | 2
}

export const DescriptionList = memo(
  ({
    className,
    bordered = false,
    columns = 1,
    children,
    ...props
  }: DescriptionListProps): React.ReactElement => (
    <div
      data-slot="description-list"
      className={cn(
        'velar-description-list',
        bordered && 'velar-description-list-bordered',
        columns === 2 ? 'velar-description-list-cols2' : 'velar-description-list-cols1',
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
)

DescriptionList.displayName = 'DescriptionList'

export interface DescriptionItemProps extends React.ComponentProps<'div'> {
  label: React.ReactNode
  /** 全宽堆叠行，类似表单项跨列。 */
  spanFull?: boolean
}

export const DescriptionItem = memo(
  ({
    className,
    label,
    spanFull = false,
    children,
    ...props
  }: DescriptionItemProps): React.ReactElement => (
    <div
      data-slot="description-item"
      className={cn('velar-description-list-row', spanFull && 'velar-description-list-span-full', className)}
      {...props}
    >
      <div className={'velar-description-list-term'}>{label}</div>
      <div className={'velar-description-list-detail'}>{children}</div>
    </div>
  )
)

DescriptionItem.displayName = 'DescriptionItem'
