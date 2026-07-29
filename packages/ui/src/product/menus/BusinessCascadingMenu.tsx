/**
 * 无状态业务级级联菜单组合（Desktop 与 Workbench 共用）。
 */
import { CheckIcon } from '@phosphor-icons/react'
import type { CSSProperties, ReactElement, ReactNode } from 'react'

import { cn } from '../../lib/cn'
import { optionalWhen, toOptional } from '../../lib/runtime'
import { Button, type ButtonProps } from '../../primitives/buttons/Button'
import { Text } from '../../primitives/display/Text'
import {
  CascadingMenu,
  type CascadingMenuProps,
  type CascadingMenuRenderProps,
} from '../../primitives/overlays/CascadingMenu'

export type BusinessCascadingMenuProps = CascadingMenuProps
export type BusinessCascadingMenuRenderProps = CascadingMenuRenderProps

/** 带 VelarOS 产品默认值的级联菜单；不持有任何 Desktop 或 Workbench 业务状态。 */
export function BusinessCascadingMenu({
  submenuAlign = 'trigger',
  viewportPadding = 16,
  ...props
}: BusinessCascadingMenuProps): ReactElement {
  return <CascadingMenu submenuAlign={submenuAlign} viewportPadding={viewportPadding} {...props} />
}

export interface BusinessCascadingMenuSelectedIndicatorProps {
  menu: CascadingMenuRenderProps
  className?: string
  size?: number
}

export function BusinessCascadingMenuSelectedIndicator({
  menu,
  className,
  size = 10,
}: BusinessCascadingMenuSelectedIndicatorProps): ReactElement {
  return <CheckIcon size={size} weight="bold" className={cn(menu.classes.check, className)} />
}

export interface BusinessCascadingMenuItemProps extends Omit<
  ButtonProps,
  'children' | 'className'
> {
  [key: `data-${string}`]: string | undefined
  children?: ReactNode
  className?: string
  icon?: ReactNode
  interaction?: 'item' | 'leaf'
  label?: ReactNode
  labelClassName?: string
  menu: CascadingMenuRenderProps
  selected?: boolean
  selectedIndicator?: ReactNode
  showSelectedIndicator?: boolean
  submenuId?: string
  trailing?: ReactNode
}

export function BusinessCascadingMenuItem({
  children,
  className,
  icon,
  interaction = 'item',
  label,
  labelClassName,
  menu,
  selected = false,
  selectedIndicator,
  showSelectedIndicator = true,
  size = 'block',
  submenuId,
  trailing,
  variant = 'ghost',
  ...buttonProps
}: BusinessCascadingMenuItemProps): ReactElement {
  const baseItemProps = {
    ...buttonProps,
    className: cn(menu.classes.item, className),
  } as React.HTMLAttributes<HTMLButtonElement> & { [key: `data-${string}`]: string | undefined }
  const itemProps = submenuId
    ? menu.getSubmenuTriggerProps<HTMLButtonElement>(submenuId, baseItemProps)
    : interaction === 'leaf'
      ? menu.getLeafItemProps<HTMLButtonElement>(baseItemProps)
      : baseItemProps

  const selectedNode =
    selected && showSelectedIndicator
      ? (selectedIndicator ?? <BusinessCascadingMenuSelectedIndicator menu={menu} />)
      : null

  return (
    <Button {...(itemProps as ButtonProps)} variant={variant} size={size} data-selected={selected}>
      {icon}
      {children ?? <Text className={cn(menu.classes.itemLabel, labelClassName)}>{label}</Text>}
      {selectedNode}
      {trailing}
    </Button>
  )
}

export interface BusinessCascadingSubmenuSectionProps extends Omit<
  React.ComponentPropsWithoutRef<'div'>,
  'children'
> {
  children: ReactNode
  header?: ReactNode
  hideHeader?: boolean
  menu: CascadingMenuRenderProps
  placementLevel?: number
  submenuWidth?: string
}

export function BusinessCascadingSubmenuSection({
  children,
  className,
  header,
  hideHeader = false,
  menu,
  placementLevel,
  style,
  submenuWidth,
  ...props
}: BusinessCascadingSubmenuSectionProps): ReactElement {
  const panelStyle = optionalWhen(submenuWidth || style, {
    ...style,
    '--cascading-menu-submenu-width': toOptional(submenuWidth),
  } as CSSProperties)

  return (
    <div
      {...menu.getSubmenuPanelProps({
        ...props,
        className,
        placementLevel,
        style: panelStyle,
      })}
    >
      {!!(!hideHeader && header) && <div className={menu.classes.header}>{header}</div>}
      <div className={menu.classes.sectionList}>{children}</div>
    </div>
  )
}
