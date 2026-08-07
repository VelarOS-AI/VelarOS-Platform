import type { ConversationMessageKey as MessageKey } from '../../i18n'
import type { ChatInputPromptFeatureGroupOption } from '../chatInputTypes'
import { type ComposerAddMenuProps } from '../ComposerAddMenu'
import type { ChatComposerCapabilityControl } from '../ComposerCapabilityControls'

import { isEmpty } from '#internal/runtime'

/**
 * 「渲染」那两格（`widget` / `html-artifact`）**不进「+」菜单**（2026-08-07 产品裁决）。
 *
 * 它们曾是菜单里一层独立子菜单（用户先勾开关，模型才被告知能出制品）。判决：制品该由**技能
 * 自动触发**——模型判断这一轮该出一张图/一个小组件时就出，不该先要用户翻两层菜单打勾。宿主那边
 * 因此把这两格常开（见 Desktop 的 `resolveAlwaysOnPromptFeatures`），这里只负责**不再渲染开关**。
 *
 * 过滤而不是把它们并进「插件」子菜单：并进去等于换个地方还要用户勾，判决就没落地。
 */
export function filterComposerMenuPluginOptions(
  options: readonly ChatInputPromptFeatureGroupOption[]
): ChatInputPromptFeatureGroupOption[] {
  return options.filter((option) => option.id !== 'widget' && option.id !== 'html-artifact')
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
    'showSkillsSubmenu' | 'showQuickPromptsSubmenu' | 'showPluginsSubmenu'
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
  const menuPluginOptions = filterComposerMenuPluginOptions(pluginOptions)

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
      showPluginsSubmenu: canTogglePlugins && !isEmpty(menuPluginOptions),
      quickPrompts,
      pluginOptions: menuPluginOptions,
    },
  }
}
