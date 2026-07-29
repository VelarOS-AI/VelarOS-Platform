/**
 * 标题文本，按层级统一字号与字重。
 *
 * variants（封闭枚举，全仓共用一套）：`level` = `1 | 2 | 3 | 4 | 5`。
 * 样式：`.velar-title` · 见 styles/components/。
 */
import React, { memo } from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva,type VariantProps } from 'class-variance-authority'

import { cn } from '../../lib/cn'
const titleVariants = cva('velar-title', {
  variants: {
    level: {
      1: 'velar-title-level1',
      2: 'velar-title-level2',
      3: 'velar-title-level3',
      4: 'velar-title-level4',
      5: 'velar-title-level5',
    },
  },
  defaultVariants: {
    level: 4,
  },
})

const headingTags = {
  1: 'h1',
  2: 'h2',
  3: 'h3',
  4: 'h4',
  5: 'h5',
} as const

export type TitleLevel = keyof typeof headingTags

export interface TitleProps
  extends Omit<React.ComponentPropsWithoutRef<'h1'>, 'children'>,
    VariantProps<typeof titleVariants> {
  asChild?: boolean
  children?: React.ReactNode
}

export const Title = memo(
  ({ className, level = 4, asChild = false, children, ...props }: TitleProps): React.ReactElement => {
    const safeLevel = level ?? 4

    if (asChild) return (
        <Slot
          data-slot="title"
          className={cn(titleVariants({ level: safeLevel }), className)}
          {...props}
        >
          {children}
        </Slot>
      )

    const H = headingTags[safeLevel]

    return (
      <H data-slot="title" className={cn(titleVariants({ level: safeLevel }), className)} {...props}>
        {children}
      </H>
    )
  }
)

Title.displayName = 'Title'
