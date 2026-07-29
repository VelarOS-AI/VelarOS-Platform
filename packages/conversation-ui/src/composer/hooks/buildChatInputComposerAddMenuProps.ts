import type { ConversationMessageKey as MessageKey } from '../../i18n'
import type { ChatInputPromptFeatureGroupOption } from '../chatInputTypes'
import { type ComposerAddMenuProps } from '../ComposerAddMenu'
import type { ChatComposerCapabilityControl } from '../ComposerCapabilityControls'

import { isEmpty } from '#internal/runtime'

export function partitionComposerCapabilityOptions(
  options: readonly ChatInputPromptFeatureGroupOption[]
): {
  renderingOptions: ChatInputPromptFeatureGroupOption[]
  pluginOptions: ChatInputPromptFeatureGroupOption[]
} {
  return {
    renderingOptions: options.filter(
      (option) => option.id === 'widget' || option.id === 'html-artifact'
    ),
    pluginOptions: options.filter(
      (option) => option.id !== 'widget' && option.id !== 'html-artifact'
    ),
  }
}

export interface ChatInputComposerAddMenuBridgeInput {
  chrome: {
    disabled: boolean
    t: (key: MessageKey, params?: Record<string, string | number>) => string
  }
  menu: ComposerAddMenuProps['menu']
  attachments: {
    onSelectFilesClick: () => void
    canAttachFiles: boolean
  }
  features: Omit<
    ComposerAddMenuProps['features'],
    | 'showSkillsSubmenu'
    | 'showQuickPromptsSubmenu'
    | 'showRenderingSubmenu'
    | 'showPluginsSubmenu'
    | 'renderingOptions'
  > & {
    canTogglePlugins: boolean
    canToggleSkills: boolean
  }
  capabilityControls?: readonly ChatComposerCapabilityControl[]
}

export function buildChatInputComposerAddMenuProps(
  canShowComposerMenu: boolean,
  input: ChatInputComposerAddMenuBridgeInput
): Nullable<ComposerAddMenuProps> {
  if (!canShowComposerMenu) return null
  const { chrome, menu, attachments, features, capabilityControls = [] } = input
  const { canTogglePlugins, canToggleSkills, pluginOptions, quickPrompts, ...featureControls } =
    features
  const { renderingOptions, pluginOptions: regularPluginOptions } =
    partitionComposerCapabilityOptions(pluginOptions)

  return {
    chrome: {
      ...chrome,
      anchorMenuLabel: chrome.t('chat.composerAddMenu'),
    },
    menu,
    capabilityControls,
    attachments: {
      showAddFilesItem: attachments.canAttachFiles,
      onSelectFilesClick: attachments.onSelectFilesClick,
    },
    features: {
      ...featureControls,
      showSkillsSubmenu: canToggleSkills,
      showQuickPromptsSubmenu: !isEmpty(quickPrompts),
      showRenderingSubmenu: canTogglePlugins && !isEmpty(renderingOptions),
      showPluginsSubmenu: canTogglePlugins && !isEmpty(regularPluginOptions),
      quickPrompts,
      renderingOptions,
      pluginOptions: regularPluginOptions,
    },
  }
}
