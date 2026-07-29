import {
  type ComponentType,
  Fragment,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react'
import {
  ChartBarIcon,
  ChatsCircleIcon,
  FileCodeIcon,
  ListChecksIcon,
  NotePencilIcon,
  PaperclipIcon,
  PuzzlePieceIcon,
  TargetIcon,
  TerminalWindowIcon,
} from '@phosphor-icons/react'

import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { Text } from '@velaros-ai/ui/primitives/display/Text'
import type { BusinessCascadingMenuRenderProps } from '@velaros-ai/ui/product/menus/BusinessCascadingMenu'

import type { ConversationMessageKey as MessageKey } from '../../i18n'
import type { ChatComposerCapabilityControl } from '../ComposerCapabilityControls'
import { ComposerCapabilityMenuItems } from '../ComposerCapabilityControls'
import {
  COMPOSER_PRIMARY_PANEL_SLOT_ORDER,
  type ComposerPrimaryPanelSlotId,
} from '../composerPrimaryPanelOrder'

import type {
  ComposerAddMenuAttachmentsProps,
  ComposerAddMenuFeaturesProps,
} from './composerAddMenu.types'
import { ComposerMenuItemBody, ComposerMenuSwitchIndicator } from './ComposerMenuItemChrome'

import { isPresent } from '#internal/runtime'

export interface ComposerAddMenuPrimaryPanelProps {
  menu: BusinessCascadingMenuRenderProps
  disabled: boolean
  t: (key: MessageKey, params?: Record<string, string | number>) => string
  SubmenuDisclosureIcon: ComponentType<{ size?: number; className?: string }>
  attachments: ComposerAddMenuAttachmentsProps
  features: ComposerAddMenuFeaturesProps
  capabilityControls: readonly ChatComposerCapabilityControl[]
}

export function ComposerAddMenuPrimaryPanel({
  menu,
  disabled,
  t,
  SubmenuDisclosureIcon,
  attachments: { showAddFilesItem, onSelectFilesClick },
  capabilityControls,
  features: {
    showSkillsSubmenu,
    showQuickPromptsSubmenu,
    showRenderingSubmenu,
    showPluginsSubmenu,
    canTogglePlanFeature,
    planModeActive,
    updatePlanMode,
    canToggleProposalFeature,
    proposalModeActive,
    updateProposalMode,
    canToggleWorkbenchEditorControl = false,
    workbenchEditorControlActive = false,
    updateWorkbenchEditorControl,
    canToggleGoalMode,
    goalModeActive,
    updateGoalMode,
  },
}: ComposerAddMenuPrimaryPanelProps): ReactElement {
  function primaryPanelSlotNode(slot: ComposerPrimaryPanelSlotId): ReactNode {
    switch (slot) {
      case 'quick-prompts':
        return (
          showQuickPromptsSubmenu && (
            <Button
              variant="ghost"
              size="block"
              {...menu.getSubmenuTriggerProps<HTMLButtonElement>('quick-prompts', {
                className: menu.classes.item,
              })}
              disabled={disabled}
            >
              <ChatsCircleIcon size={14} />
              <Text className={menu.classes.itemLabel}>{t('chat.composerQuickPrompts')}</Text>
              <SubmenuDisclosureIcon size={12} className={menu.classes.disclosure} />
            </Button>
          )
        )
      case 'attachments':
        return (
          showAddFilesItem && (
            <Button
              variant="ghost"
              size="block"
              {...menu.getLeafItemProps<HTMLButtonElement>({
                className: menu.classes.item,
              })}
              onClick={onSelectFilesClick}
              disabled={disabled}
            >
              <PaperclipIcon size={14} />
              <Text className={menu.classes.itemLabel}>{t('chat.composerAddFiles')}</Text>
            </Button>
          )
        )
      case 'capabilities':
        return (
          <ComposerCapabilityMenuItems
            controls={capabilityControls}
            menu={menu}
            disabled={disabled}
          />
        )
      case 'plan':
        return (
          canTogglePlanFeature && (
            <Button
              variant="ghost"
              size="block"
              {...menu.getLeafItemProps<HTMLButtonElement>({
                className: menu.classes.item,
              })}
              aria-pressed={planModeActive}
              data-active={planModeActive}
              onClick={() => updatePlanMode(!planModeActive)}
              disabled={disabled}
            >
              <ListChecksIcon size={14} />
              <ComposerMenuItemBody
                label={t('chat.composerPlanMode')}
                help={t('chat.composerPlanModeHint')}
              />
              <ComposerMenuSwitchIndicator checked={planModeActive} />
            </Button>
          )
        )
      case 'proposal':
        return (
          canToggleProposalFeature && (
            <Button
              variant="ghost"
              size="block"
              {...menu.getLeafItemProps<HTMLButtonElement>({
                className: menu.classes.item,
              })}
              aria-pressed={proposalModeActive}
              data-active={proposalModeActive}
              onClick={() => updateProposalMode(!proposalModeActive)}
              disabled={disabled}
            >
              <NotePencilIcon size={14} />
              <ComposerMenuItemBody
                label={t('chat.composerProposalMode')}
                help={t('chat.composerProposalModeHint')}
              />
              <ComposerMenuSwitchIndicator checked={proposalModeActive} />
            </Button>
          )
        )
      case 'workbench-editor':
        return (
          canToggleWorkbenchEditorControl && (
            <Button
              variant="ghost"
              size="block"
              {...menu.getLeafItemProps<HTMLButtonElement>({
                className: menu.classes.item,
              })}
              aria-pressed={workbenchEditorControlActive}
              data-active={workbenchEditorControlActive}
              onClick={() => updateWorkbenchEditorControl?.(!workbenchEditorControlActive)}
              disabled={disabled}
            >
              <TerminalWindowIcon size={14} />
              <ComposerMenuItemBody
                label={t('chat.composerWorkbenchEditorControl')}
                help={t('chat.composerWorkbenchEditorControlHint')}
              />
              <ComposerMenuSwitchIndicator checked={workbenchEditorControlActive} />
            </Button>
          )
        )
      case 'goal':
        return (
          canToggleGoalMode && (
            <Button
              variant="ghost"
              size="block"
              {...menu.getLeafItemProps<HTMLButtonElement>({
                className: menu.classes.item,
              })}
              aria-pressed={goalModeActive}
              data-active={goalModeActive}
              onClick={() => updateGoalMode(!goalModeActive)}
              disabled={disabled}
            >
              <TargetIcon size={14} />
              <ComposerMenuItemBody
                label={t('chat.composerGoalMode')}
                help={t('chat.composerGoalModeHint')}
              />
              <ComposerMenuSwitchIndicator checked={goalModeActive} />
            </Button>
          )
        )
      case 'plugins':
        return (
          showPluginsSubmenu && (
            <Button
              variant="ghost"
              size="block"
              data-tour-id="chat-add-menu-plugins"
              {...menu.getSubmenuTriggerProps<HTMLButtonElement>('plugins', {
                className: menu.classes.item,
              })}
              disabled={disabled}
            >
              <PuzzlePieceIcon size={14} />
              <Text className={menu.classes.itemLabel}>{t('chat.composerPlugins')}</Text>
              <SubmenuDisclosureIcon size={12} className={menu.classes.disclosure} />
            </Button>
          )
        )
      case 'rendering':
        return (
          showRenderingSubmenu && (
            <Button
              variant="ghost"
              size="block"
              data-tour-id="chat-add-menu-rendering"
              {...menu.getSubmenuTriggerProps<HTMLButtonElement>('rendering', {
                className: menu.classes.item,
              })}
              disabled={disabled}
            >
              <ChartBarIcon size={14} />
              <Text className={menu.classes.itemLabel}>{t('chat.composerRendering')}</Text>
              <SubmenuDisclosureIcon size={12} className={menu.classes.disclosure} />
            </Button>
          )
        )
      case 'skills':
        return (
          showSkillsSubmenu && (
            <Button
              variant="ghost"
              size="block"
              {...menu.getSubmenuTriggerProps<HTMLButtonElement>('skills', {
                className: menu.classes.item,
              })}
              disabled={disabled}
            >
              <FileCodeIcon size={14} />
              <Text className={menu.classes.itemLabel}>{t('chat.composerSkills')}</Text>
              <SubmenuDisclosureIcon size={12} className={menu.classes.disclosure} />
            </Button>
          )
        )
      default:
        return null
    }
  }

  return (
    <div
      {...(menu.getPrimaryPanelProps() as HTMLAttributes<HTMLDivElement>)}
      data-tour-id="chat-add-menu"
      data-tour-include-menu-panels="true"
    >
      {COMPOSER_PRIMARY_PANEL_SLOT_ORDER.map((slot) => {
        const node = primaryPanelSlotNode(slot)
        return isPresent(node) && <Fragment key={slot}>{node}</Fragment>
      })}
    </div>
  )
}
