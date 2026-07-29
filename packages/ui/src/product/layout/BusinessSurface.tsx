/**
 * 业务浅色表面容器，统一分区背景。
 *
 * 样式：`.velar-business-surface-variant-default` · 见 styles/components/。
 */
import { type ComponentPropsWithoutRef, memo, type ReactElement } from 'react'

import { cn } from '@velaros-ai/ui/lib/cn'
export type BusinessSurfaceVariant = 'default' | 'code' | 'danger'

export interface BusinessSurfaceProps extends ComponentPropsWithoutRef<'div'> {
  /** 语义色调：默认块、代码滚动块或危险提示色。 */
  variant?: BusinessSurfaceVariant
  /** 添加舒适内边距；贴边组合时可关闭。 */
  padded?: boolean
}

const variantClass: Record<BusinessSurfaceVariant, string> = {
  default: 'velar-business-surface-variant-default',
  code: 'velar-business-surface-variant-code',
  danger: 'velar-business-surface-variant-danger',
}

/**
 * 无描边业务块：浅底容器，用于设置和检查面板。
 * 在设置面板正文与检查面板内使用它，避免各处手写边框盒子。
 */
export const BusinessSurface = memo(function BusinessSurface({
  variant = 'default',
  padded = true,
  className,
  children,
  ...rest
}: BusinessSurfaceProps): ReactElement {
  return (
    <div
      data-slot="business-surface"
      className={cn(
        'velar-business-surface-surface-base',
        variantClass[variant],
        padded && 'velar-business-surface-padded',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  )
})

BusinessSurface.displayName = 'BusinessSurface'
