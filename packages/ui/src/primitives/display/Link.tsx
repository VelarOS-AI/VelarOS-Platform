/**
 * 行内文本链接，统一下划线与色态。
 *
 * variants（封闭枚举，全仓共用一套）：`variant` = `default | muted | danger`；`display` = `inline | block`。
 * 样式：`.velar-link-link` · 见 styles/components/。
 */
import React, { forwardRef, memo } from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva,type VariantProps } from 'class-variance-authority'

import { cn } from '../../lib/cn'
const linkVariants = cva('velar-link-link', {
  variants: {
    variant: {
      default: 'velar-link-variant-default',
      muted: 'velar-link-variant-muted',
      danger: 'velar-link-variant-danger',
    },
    display: {
      inline: 'velar-link-inline',
      block: 'velar-link-block',
    },
  },
  defaultVariants: {
    variant: 'default',
    display: 'inline',
  },
})

export interface LinkProps
  extends Omit<React.ComponentPropsWithRef<'a'>, 'children'>,
    VariantProps<typeof linkVariants> {
  asChild?: boolean
  children?: React.ReactNode
  /** Sets `target="_blank"` and `rel="noopener noreferrer"` */
  external?: boolean
}

export const Link = memo(
  forwardRef<HTMLAnchorElement, LinkProps>(
    ({ className, variant, display, asChild = false, external, children, rel, target, ...props }, ref) => {
      const Comp = asChild ? Slot : 'a'
      const resolvedRel =
        external ? [rel, 'noopener', 'noreferrer'].filter((value) => !!value).join(' ').trim() || 'noopener noreferrer' : rel

      return (
        <Comp
          ref={ref}
          data-slot="link"
          className={cn(linkVariants({ variant, display }), className)}
          rel={resolvedRel}
          target={external ? '_blank' : target}
          {...props}
        >
          {children}
        </Comp>
      )
    }
  )
)

Link.displayName = 'Link'
