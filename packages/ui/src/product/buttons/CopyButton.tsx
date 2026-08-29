/**
 * 复制到剪贴板按钮，含复制成功反馈。
 *
 * 样式：`.velar-copy-button` · 见 styles/components/。
 */
import { memo, type ReactElement,useEffect, useState } from 'react'
import { CheckIcon, CopyIcon } from '@phosphor-icons/react'
import { useDebounceFn, useLockFn } from 'ahooks'

import { cn } from '@velaros-ai/ui/lib/cn'
import { IconButton, type IconButtonProps } from '@velaros-ai/ui/primitives/buttons/IconButton'

export interface CopyButtonProps extends Omit<
  IconButtonProps,
  'children' | 'label' | 'onClick' | 'title'
> {
  value: string
  label: string
  copiedLabel?: string
  iconSize?: number
  onCopy?: () => Promise<void>
}

export const CopyButton = memo(
  ({
    value,
    label,
    copiedLabel = 'Copied',
    iconSize = 14,
    onCopy,
    className,
    variant = 'ghost',
    size = 'icon-sm',
    shape = 'round',
    ...props
  }: CopyButtonProps): Nullable<ReactElement> => {
    const [copied, setCopied] = useState(false)
    const { run: scheduleResetCopied, cancel: cancelResetCopied } = useDebounceFn(
      () => {
        setCopied(false)
      },
      { wait: 1600 }
    )

    useEffect(
      () => () => {
        cancelResetCopied()
      },
      [cancelResetCopied]
    )

    const handleCopy = useLockFn(async (): Promise<void> => {
      if (onCopy) await onCopy()
      else await navigator.clipboard.writeText(value)
      setCopied(true)
      scheduleResetCopied()
    })

    if (!value) return null

    const buttonLabel = copied ? copiedLabel : label

    return (
      <IconButton
        label={buttonLabel}
        variant={variant}
        size={size}
        shape={shape}
        className={cn('velar-copy-button', copied && 'velar-copy-button-copied', className)}
        onClick={() => {
          void handleCopy()
        }}
        {...props}
      >
        {copied ? <CheckIcon size={iconSize} weight="bold" /> : <CopyIcon size={iconSize} />}
      </IconButton>
    )
  }
)

CopyButton.displayName = 'CopyButton'
