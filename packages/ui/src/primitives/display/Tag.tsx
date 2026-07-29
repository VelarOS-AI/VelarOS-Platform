/**
 * 可着色标签片，用于筛选 / 属性标记。
 *
 * variants（封闭枚举，全仓共用一套）：`variant` = `default | secondary | outline | success | warning | error | info`。
 * 样式：`.velar-tag` · 见 styles/components/。
 */
import React, { memo } from 'react'
import { XIcon } from '@phosphor-icons/react'
import { cva, type VariantProps } from 'class-variance-authority'

import { useUiLocalization } from '../../i18n/UiLocalizationProvider'
import { cn } from '../../lib/cn'
import { isPresent } from '../../lib/runtime'
const tagVariants = cva('velar-tag', {
  variants: {
    variant: {
      default: 'velar-tag-variant-default',
      secondary: 'velar-tag-variant-secondary',
      outline: 'velar-tag-variant-outline',
      success: 'velar-tag-variant-success',
      warning: 'velar-tag-variant-warning',
      error: 'velar-tag-variant-error',
      info: 'velar-tag-variant-info',
    },
  },
  defaultVariants: {
    variant: 'default',
  },
})

export interface TagProps
  extends Omit<React.ComponentProps<'span'>, 'children'>, VariantProps<typeof tagVariants> {
  children?: React.ReactNode
  icon?: React.ReactNode
  closable?: boolean
  onClose?: () => void
  closeLabel?: string
}

export const Tag = memo(
  ({
    className,
    variant,
    icon,
    closable = false,
    onClose,
    closeLabel,
    children,
    ...props
  }: TagProps): React.ReactElement => {
    const localization = useUiLocalization()

    return (
      <span data-slot="tag" className={cn(tagVariants({ variant }), className)} {...props}>
        {isPresent(icon) && <span className={'velar-tag-lead-icon'}>{icon}</span>}
        <span className={'velar-tag-label'}>{children}</span>
        {!!(closable && isPresent(onClose)) && (
          <button
            type="button"
            className={'velar-tag-close'}
            aria-label={closeLabel ?? localization.remove}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onClose()
            }}
          >
            <XIcon size={10} weight="bold" aria-hidden />
          </button>
        )}
      </span>
    )
  }
)

Tag.displayName = 'Tag'
