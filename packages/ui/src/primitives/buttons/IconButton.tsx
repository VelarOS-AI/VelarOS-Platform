/**
 * 纯图标动作按钮，用于工具条、行内锚点与标题附加动作。
 *
 * 样式：`.velar-icon-button-shape-round` · 见 styles/components/。
 */
import { type CSSProperties, forwardRef, memo, type ReactElement } from 'react'

import { Button, type ButtonProps } from '@velaros-ai/ui/primitives/buttons/Button'

import { cn } from '../../lib/cn'
import { isString, optionalWhenLazy } from '../../lib/runtime'

export type IconButtonPresetSize = 'icon' | 'icon-sm' | 'icon-lg'
export type IconButtonCustomSize = number | (string & {})
export type IconButtonSize = IconButtonPresetSize | IconButtonCustomSize
export type IconButtonShape = 'default' | 'round'

const IconButtonPresetSizes = new Set<IconButtonPresetSize>(['icon', 'icon-sm', 'icon-lg'])

function isIconButtonPresetSize(size: IconButtonSize): size is IconButtonPresetSize {
  return isString(size) && IconButtonPresetSizes.has(size as IconButtonPresetSize)
}

export interface IconButtonProps extends Omit<
  ButtonProps,
  'aria-label' | 'size' | 'title' | 'variant'
> {
  label: string
  shape?: IconButtonShape
  size?: IconButtonSize
  title?: LooseOptional<string>
  variant?: ButtonProps['variant']
}

export const IconButton = memo(
  forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
    {
      className,
      label,
      shape = 'default',
      size = 'icon',
      title,
      variant = 'ghost',
      style,
      ...props
    },
    ref
  ): ReactElement {
    const nativeTitle = title || label

    const hasCustomSize = !isIconButtonPresetSize(size)
    const buttonSize: ButtonProps['size'] = hasCustomSize ? 'icon-sm' : size
    const customSizeStyle: CSSProperties | undefined = optionalWhenLazy(hasCustomSize, () => ({
          width: size,
          minWidth: size,
          height: size,
          minHeight: size,
        }))

    return (
      <Button
        ref={ref}
        variant={variant}
        size={buttonSize}
        title={nativeTitle}
        aria-label={label}
        className={cn(shape === 'round' && 'velar-icon-button-shape-round', className)}
        style={customSizeStyle ? { ...style, ...customSizeStyle } : style}
        {...props}
      />
    )
  })
)

IconButton.displayName = 'IconButton'
