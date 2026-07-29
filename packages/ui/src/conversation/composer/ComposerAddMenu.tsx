import { type ReactElement, useCallback } from 'react'
import { CaretRightIcon, PlusIcon } from '@phosphor-icons/react'

import { cn } from '@velaros-ai/ui/lib/cn'
import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'
import { BusinessCascadingMenu } from '@velaros-ai/ui/product/menus/BusinessCascadingMenu'

import type { ComposerAddMenuProps } from './addMenu/composerAddMenu.types'
import { ComposerAddMenuPrimaryPanel } from './addMenu/ComposerAddMenuPrimaryPanel'
import { ComposerAddMenuSubmenuSections } from './addMenu/ComposerAddMenuSubmenuSections'
import { dispatchOnboardingComposerAddMenuOpened } from './composerHostEvents'

export type {
  ComposerAddMenuAttachmentsProps,
  ComposerAddMenuChromeProps,
  ComposerAddMenuFeaturesProps,
  ComposerAddMenuMenuProps,
  ComposerAddMenuProps,
} from './addMenu/composerAddMenu.types'

import styles from './ChatInput.module.css'

export function ComposerAddMenu({
  density = 'default',
  chrome: { disabled, t, anchorMenuLabel },
  menu: {
    menuOpen,
    onMenuOpenChange,
    activeSubmenuId,
    onActiveSubmenuChangeFromCascading,
    onCloseSubmenus,
  },
  attachments,
  features,
  capabilityControls = [],
}: ComposerAddMenuProps): ReactElement {
  const SubmenuDisclosureIcon = CaretRightIcon
  const isCompact = density === 'compact'
  const handleMenuOpenChange = useCallback(
    (nextOpen: boolean): void => {
      onMenuOpenChange(nextOpen)
      if (nextOpen) dispatchOnboardingComposerAddMenuOpened()
    },
    [onMenuOpenChange]
  )

  return (
    <BusinessCascadingMenu
      open={menuOpen}
      keyboardNavigation
      onOpenChange={handleMenuOpenChange}
      activeSubmenuId={activeSubmenuId}
      onActiveSubmenuChange={onActiveSubmenuChangeFromCascading}
      onCloseSubmenus={onCloseSubmenus}
      anchorClassName={styles.composerMenuAnchor}
      className={cn(styles.composerMenuContent, isCompact && styles.composerMenuContentCompact)}
      side="top"
      align="start"
      sideOffset={8}
      anchor={({ getAnchorProps }) => (
        <IconButton
          {...getAnchorProps<HTMLButtonElement>({
            disabled,
          })}
          label={anchorMenuLabel}
          size="icon"
          disabled={disabled}
          className={styles.attachButton}
          data-tour-id="chat-add-menu-trigger"
        >
          <PlusIcon size={14} weight="bold" />
        </IconButton>
      )}
    >
      {(menu) => (
        <>
          <ComposerAddMenuPrimaryPanel
            menu={menu}
            disabled={disabled}
            t={t}
            SubmenuDisclosureIcon={SubmenuDisclosureIcon}
            attachments={attachments}
            features={features}
            capabilityControls={capabilityControls}
          />
          <ComposerAddMenuSubmenuSections
            menu={menu}
            disabled={disabled}
            t={t}
            activeSubmenuId={activeSubmenuId}
            features={features}
          />
        </>
      )}
    </BusinessCascadingMenu>
  )
}
