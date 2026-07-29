/**
 * 描边删除图标按钮（破坏性动作）。
 */
import { memo, type ReactElement, type ReactNode } from 'react'
import { TrashIcon } from '@phosphor-icons/react'

import { IconButton, type IconButtonProps } from '@velaros-ai/ui/primitives/buttons/IconButton'

export type DeleteOutlineIconButtonProps = Omit<IconButtonProps, 'variant' | 'children'> & {
  children?: ReactNode
  /**
   * 为真时使用红色描边；为假时使用默认的无边框红色删除样式。
   */
  bordered?: boolean
}

/**
 * 工具栏和停靠区使用的删除控件。
 * 默认是无边框红色样式；设置描边后使用红色描边样式。
 */
export const DeleteOutlineIconButton = memo(function DeleteOutlineIconButton({
  children,
  bordered = false,
  ...rest
}: DeleteOutlineIconButtonProps): ReactElement {
  return (
    <IconButton variant={bordered ? 'destructiveOutline' : 'destructiveGhost'} size="icon-sm" {...rest}>
      {children ?? <TrashIcon size={18} />}
    </IconButton>
  )
})

DeleteOutlineIconButton.displayName = 'DeleteOutlineIconButton'
