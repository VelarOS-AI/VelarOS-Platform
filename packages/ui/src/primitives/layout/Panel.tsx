/**
 * 面板容器，弱化背景的分区块。
 *
 * variants（封闭枚举，全仓共用一套）：`variant` = `default | muted | strong | inset`。
 * 样式：`.velar-panel` · 见 styles/components/。
 */
import React, { memo } from 'react'
import { cva,type VariantProps } from 'class-variance-authority'

import { cn } from '../../lib/cn'
const panelVariants = cva('velar-panel', {
  variants: {
    variant: {
      default: 'velar-panel-variant-default',
      muted: 'velar-panel-variant-muted',
      strong: 'velar-panel-variant-strong',
      inset: 'velar-panel-variant-inset',
    },
  },
  defaultVariants: {
    variant: 'default',
  },
})

export interface PanelProps
  extends React.ComponentProps<'div'>,
    VariantProps<typeof panelVariants> {}

export const Panel = memo(({
  className,
  variant,
  ...props
}: PanelProps): React.ReactElement => (
  <div
    data-slot="panel"
    className={cn(panelVariants({ variant }), className)}
    {...props}
  />
))

Panel.displayName = 'Panel'
