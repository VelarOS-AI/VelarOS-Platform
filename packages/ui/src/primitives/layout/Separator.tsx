/**
 * 语义分隔符（基于 Radix Separator）。
 *
 * 样式：`.velar-separator` · 见 styles/components/。
 */
import { type ComponentPropsWithoutRef, type ElementRef, forwardRef, type ReactElement } from 'react'
import * as SeparatorPrimitive from '@radix-ui/react-separator'

import { cn } from '../../lib/cn'

export const Separator = forwardRef<
  ElementRef<typeof SeparatorPrimitive.Root>,
  ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>
>(({ className, decorative = true, orientation = 'horizontal', ...props }, ref): ReactElement => (
  <SeparatorPrimitive.Root
    ref={ref}
    decorative={decorative}
    orientation={orientation}
    data-slot="separator"
    className={cn(
      'velar-separator',
      orientation === 'horizontal' ? 'velar-separator-horizontal' : 'velar-separator-vertical',
      className
    )}
    {...props}
  />
))

Separator.displayName = SeparatorPrimitive.Root.displayName
