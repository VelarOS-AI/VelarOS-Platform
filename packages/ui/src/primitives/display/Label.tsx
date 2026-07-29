/**
 * 表单字段标签，绑定控件语义。
 *
 * 样式：`.velar-label` · 见 styles/components/。
 */
import React, { memo } from 'react'
import * as LabelPrimitive from '@radix-ui/react-label'

import { cn } from '../../lib/cn'
export type LabelProps = React.ComponentProps<typeof LabelPrimitive.Root>

export const Label = memo(({ className, ...props }: LabelProps): React.ReactElement => (
  <LabelPrimitive.Root
    data-slot="label"
    className={cn('velar-label', className)}
    {...props}
  />
))

Label.displayName = 'Label'
