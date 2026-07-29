import { type PointerEvent, type ReactElement, useEffect, useState } from 'react'
import { CaretRightIcon, ChatsCircleIcon, CheckIcon, FileCodeIcon } from '@phosphor-icons/react'

import { cn } from '@velaros-ai/ui/lib/cn'
import { Text } from '@velaros-ai/ui/primitives/display/Text'
import {
  BusinessCascadingMenuItem,
  type BusinessCascadingMenuRenderProps,
  BusinessCascadingSubmenuSection,
} from '@velaros-ai/ui/product/menus/BusinessCascadingMenu'

import type { ConversationMessageKey as MessageKey } from '../../i18n'
import type { ChatInputPromptFeatureGroupOption, ComposerSubmenuId } from '../chatInputTypes'

import type { ComposerAddMenuFeaturesProps } from './composerAddMenu.types'

import styles from '../ChatInput.module.css'

import { isEmpty } from '#internal/runtime'

function isOfficeDetailPluginOption(option: ChatInputPromptFeatureGroupOption): boolean {
  return (
    option.id !== 'office' && option.featureIds.some((featureId) => featureId.startsWith('office-'))
  )
}

export interface ComposerAddMenuSubmenuSectionsProps {
  menu: BusinessCascadingMenuRenderProps
  disabled: boolean
  t: (key: MessageKey, params?: Record<string, string | number>) => string
  activeSubmenuId: Nullable<ComposerSubmenuId>
  features: ComposerAddMenuFeaturesProps
}

export function ComposerAddMenuSubmenuSections({
  menu,
  disabled,
  t,
  activeSubmenuId,
  features: {
    showSkillsSubmenu,
    showQuickPromptsSubmenu,
    showRenderingSubmenu,
    showPluginsSubmenu,
    availableSkills,
    quickPrompts,
    renderingOptions,
    pluginOptions,
    selectedPromptFeatures,
    updatePromptFeatureGroup,
    selectedSkillIdSet,
    updateSelectedSkill,
    handleSelectQuickPrompt,
  },
}: ComposerAddMenuSubmenuSectionsProps): ReactElement {
  const [activePluginDetailId, setActivePluginDetailId] = useState<Nullable<string>>(null)
  const topLevelPluginOptions = pluginOptions.filter(
    (option) => option.id === 'office' || !isOfficeDetailPluginOption(option)
  )
  const officeDetailOptions = pluginOptions.filter(isOfficeDetailPluginOption)
  const showOfficeDetailMenu = activePluginDetailId === 'office' && !isEmpty(officeDetailOptions)

  useEffect(() => {
    if (activeSubmenuId !== 'plugins') setActivePluginDetailId(null)
  }, [activeSubmenuId])

  function isPluginOptionSelected(option: ChatInputPromptFeatureGroupOption): boolean {
    return option.featureIds.every((featureId) => selectedPromptFeatures.has(featureId))
  }

  function handlePluginPanelPointerMove(event: PointerEvent<HTMLDivElement>): void {
    const target = event.target
    if (!(target instanceof Element)) return
    if (target.closest('[data-plugin-detail-menu="true"]')) return

    const pluginItem = target.closest('[data-plugin-item="true"]') as Nullable<HTMLElement>
    if (!pluginItem && activePluginDetailId === 'office') return

    const pluginId = pluginItem?.dataset.pluginId
    setActivePluginDetailId(pluginId === 'office' ? 'office' : null)
  }

  return (
    <>
      {showQuickPromptsSubmenu && activeSubmenuId === 'quick-prompts' && (
        <BusinessCascadingSubmenuSection
          menu={menu}
          submenuWidth="18rem"
          header={t('chat.composerQuickPromptCount', { count: quickPrompts.length })}
        >
          {quickPrompts.map((option) => (
            <BusinessCascadingMenuItem
              menu={menu}
              key={option.id}
              title={option.description || option.title}
              onClick={() => handleSelectQuickPrompt(option)}
              disabled={disabled}
            >
              <span className={menu.classes.icon}>
                <ChatsCircleIcon size={13} weight="fill" />
              </span>
              <Text className={menu.classes.itemLabel}>{option.title}</Text>
            </BusinessCascadingMenuItem>
          ))}
        </BusinessCascadingSubmenuSection>
      )}

      {showPluginsSubmenu && activeSubmenuId === 'plugins' && (
        <BusinessCascadingSubmenuSection
          menu={menu}
          className={cn(styles.composerPluginMenu, menu.classes.allowOverflowPanel)}
          data-plugin-layout="three-column"
          onPointerMove={handlePluginPanelPointerMove}
          submenuWidth="var(--chat-input-menu-plugin-width)"
          header={t('chat.composerPluginCount', { count: topLevelPluginOptions.length })}
        >
          {topLevelPluginOptions.map((option) => {
            const selected = isPluginOptionSelected(option)
            const Icon = option.icon

            return (
              <button
                type="button"
                key={option.id}
                className={styles.composerPluginItem}
                data-plugin-id={option.id}
                data-plugin-item="true"
                data-tour-id={option.id === 'office' ? 'chat-plugin-office' : undefined}
                data-selected={selected}
                aria-pressed={selected}
                title={t(option.labelKey)}
                onClick={() => updatePromptFeatureGroup(option, !selected)}
                disabled={disabled}
              >
                <span className={styles.composerPluginIcon}>
                  <Icon size={13} weight="fill" />
                </span>
                <span>{t(option.labelKey)}</span>
                {selected && (
                  <CheckIcon size={11} weight="bold" className={styles.composerPluginCheck} />
                )}
                {option.id === 'office' && !isEmpty(officeDetailOptions) && (
                  <CaretRightIcon size={11} className={styles.composerPluginDisclosure} />
                )}
              </button>
            )
          })}
          {showOfficeDetailMenu && (
            <BusinessCascadingSubmenuSection
              menu={menu}
              className={cn(styles.composerOfficeDetailMenu, menu.classes.nestedSubmenuPanel)}
              data-plugin-detail-menu="true"
              hideHeader
              onPointerEnter={() => setActivePluginDetailId('office')}
              placementLevel={2}
              submenuWidth="var(--chat-input-menu-office-detail-width)"
            >
              {officeDetailOptions.map((option) => {
                const selected = isPluginOptionSelected(option)
                const Icon = option.icon

                return (
                  <BusinessCascadingMenuItem
                    menu={menu}
                    key={option.id}
                    className={styles.composerOfficeDetailItem}
                    data-plugin-id={option.id}
                    data-plugin-detail-item="true"
                    selected={selected}
                    selectedIndicator={
                      <CheckIcon
                        size={11}
                        weight="bold"
                        className={styles.composerOfficeDetailCheck}
                      />
                    }
                    aria-pressed={selected}
                    title={t(option.labelKey)}
                    onClick={() => updatePromptFeatureGroup(option, !selected)}
                    disabled={disabled}
                  >
                    <span className={styles.composerOfficeDetailIcon}>
                      <Icon size={13} weight="fill" />
                    </span>
                    <Text className={cn(menu.classes.itemLabel, styles.composerOfficeDetailLabel)}>
                      {t(option.labelKey)}
                    </Text>
                  </BusinessCascadingMenuItem>
                )
              })}
            </BusinessCascadingSubmenuSection>
          )}
        </BusinessCascadingSubmenuSection>
      )}

      {showRenderingSubmenu && activeSubmenuId === 'rendering' && (
        <BusinessCascadingSubmenuSection
          menu={menu}
          className={styles.composerPluginMenu}
          submenuWidth="var(--chat-input-menu-plugin-width)"
          header={t('chat.composerRenderingCount', { count: renderingOptions.length })}
        >
          {renderingOptions.map((option) => {
            const selected = isPluginOptionSelected(option)
            const Icon = option.icon

            return (
              <button
                type="button"
                key={option.id}
                className={styles.composerPluginItem}
                data-rendering-id={option.id}
                data-tour-id={
                  option.id === 'widget'
                    ? 'chat-rendering-widget'
                    : option.id === 'html-artifact'
                      ? 'chat-rendering-html-artifact'
                      : undefined
                }
                data-selected={selected}
                aria-pressed={selected}
                title={t(option.labelKey)}
                onClick={() => updatePromptFeatureGroup(option, !selected)}
                disabled={disabled}
              >
                <span className={styles.composerPluginIcon}>
                  <Icon size={13} weight="fill" />
                </span>
                <span>{t(option.labelKey)}</span>
                {selected && (
                  <CheckIcon size={11} weight="bold" className={styles.composerPluginCheck} />
                )}
              </button>
            )
          })}
        </BusinessCascadingSubmenuSection>
      )}

      {showSkillsSubmenu && activeSubmenuId === 'skills' && (
        <BusinessCascadingSubmenuSection
          menu={menu}
          className={styles.composerSkillList}
          submenuWidth="var(--chat-input-menu-skill-width)"
          header={t('chat.composerSkillCount', { count: availableSkills.length })}
        >
          {availableSkills.map((skill) => {
            const selected = selectedSkillIdSet.has(skill.id)

            return (
              <BusinessCascadingMenuItem
                menu={menu}
                key={skill.id}
                className={styles.composerSkillItem}
                data-skill-item="true"
                selected={selected}
                selectedIndicator={
                  <CheckIcon size={11} weight="bold" className={styles.composerSkillCheck} />
                }
                title={skill.description || skill.label}
                onClick={() => updateSelectedSkill(skill.id, !selected)}
                disabled={disabled}
              >
                <span className={styles.composerSkillIcon}>
                  <FileCodeIcon size={13} weight="fill" />
                </span>
                <span className={styles.composerSkillTitleRow}>
                  <Text className={menu.classes.itemLabel}>{skill.label}</Text>
                  {!!skill.builtIn && (
                    <span className={styles.composerSkillBuiltInBadge}>
                      {t('chat.composerSkillBuiltInBadge')}
                    </span>
                  )}
                </span>
              </BusinessCascadingMenuItem>
            )
          })}
        </BusinessCascadingSubmenuSection>
      )}
    </>
  )
}
