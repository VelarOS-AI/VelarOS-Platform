import { memo, type ReactElement } from 'react'
import { ListMagnifyingGlassIcon } from '@phosphor-icons/react'

import {
  IconButton,
  type IconButtonProps,
} from '../../primitives/buttons/IconButton'

export interface ChatScrollNavigatorVisibilityToggleProps extends Omit<
  IconButtonProps,
  'aria-pressed' | 'children' | 'label' | 'onClick'
> {
  /** true 时整组楼层导航不渲染、不占位。 */
  hidden: boolean
  label: string
  iconSize?: number
  onHiddenChange: (hidden: boolean) => void
}

/**
 * 侧栏聊天楼层导航的受控开关。宿主只持有显隐状态和摆放位置；图标、按钮与 aria 语义统一归 UI。
 */
export const ChatScrollNavigatorVisibilityToggle = memo(
  function ChatScrollNavigatorVisibilityToggle({
    hidden,
    label,
    iconSize = 15,
    onHiddenChange,
    size = 'icon-sm',
    title = label,
    variant = 'ghost',
    ...buttonProps
  }: ChatScrollNavigatorVisibilityToggleProps): ReactElement {
    return (
      <IconButton
        {...buttonProps}
        variant={variant}
        size={size}
        label={label}
        title={title}
        aria-pressed={!hidden}
        data-active={!hidden}
        onClick={() => onHiddenChange(!hidden)}
      >
        <ListMagnifyingGlassIcon size={iconSize} aria-hidden="true" />
      </IconButton>
    )
  }
)

ChatScrollNavigatorVisibilityToggle.displayName = 'ChatScrollNavigatorVisibilityToggle'
