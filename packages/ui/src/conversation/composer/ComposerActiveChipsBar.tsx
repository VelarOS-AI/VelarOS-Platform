import { memo, type ReactElement, type ReactNode, useMemo } from 'react'
import {
  AtIcon,
  CursorClickIcon,
  FileCodeIcon,
  ListChecksIcon,
  PulseIcon,
  TargetIcon,
} from '@phosphor-icons/react'

import { StyleUtils } from '@velaros-ai/ui'
import { Inline } from '@velaros-ai/ui/primitives/layout/Inline'

import type { ConversationMessageKey as MessageKey } from '../i18n'

import { useComposerToolbarChipCollapse } from './hooks/useComposerToolbarChipCollapse'
import { groupTurnContextChips } from './utils/turnContextChipGroups.utils'
import type {
  ChatInputMentionableOption,
  ChatInputPromptFeatureGroupOption,
  ChatInputSkillDetailHandler,
  ChatInputSkillOption,
} from './chatInputTypes'
import { ComposerActiveChip } from './ComposerActiveChip'
import {
  type ChatComposerCapabilityControl,
  ComposerCapabilityIcon,
} from './ComposerCapabilityControls'
import {
  COMPOSER_FUNCTION_BAR_CHIP_CONFIG,
  COMPOSER_FUNCTION_BAR_CHIP_ORDER,
  type ComposerFunctionBarChipPlacement,
  type ComposerFunctionBarChipSlotId,
} from './composerPrimaryPanelOrder'

import styles from './ChatInput.module.css'

import type {
  BrowserElementSelection,
  ChatPromptFeatureId,
  TurnContextDelta,
} from '#contracts'
import { isEmpty,isTrue, optionalWhenLazy } from '#internal/runtime'

const cx = StyleUtils.bindCx(styles)
const EmptyLockedPromptFeatures: ChatPromptFeatureId[] = []

function resolveComposerFunctionBarChipClassName(
  slot: ComposerFunctionBarChipSlotId,
  fallbackClassName?: string
): string | undefined {
  return COMPOSER_FUNCTION_BAR_CHIP_CONFIG[slot].chipStyle === 'execution'
    ? styles.executionModeChip
    : fallbackClassName
}

function formatBrowserElementSelectionTitle(
  selection: BrowserElementSelection,
  stepLabel: string
): string {
  let title = ''
  const appendPart = (value: LooseOptional<string>): void => {
    if (!value) return

    title = title ? `${title} · ${value}` : value
  }

  appendPart(selection.label)
  appendPart(
    selection.interactionSteps?.length ? `${selection.interactionSteps.length} ${stepLabel}` : null
  )
  appendPart(`${selection.rect.centerX},${selection.rect.centerY}`)

  return title
}

function resolveCurrentFileLabel(path: string): string {
  const segments = path.replace(/\\/gu, '/').split('/').filter(Boolean)
  return segments[segments.length - 1] ?? path
}

export function selectActiveComposerCapabilityControls(
  controls: readonly ChatComposerCapabilityControl[]
): ChatComposerCapabilityControl[] {
  return controls.filter(
    (control) =>
      control.placement === 'add-menu' &&
      control.kind === 'toggle' &&
      isTrue(control.value)
  )
}

export interface ComposerActiveChipsBarProps {
  leading?: ReactNode
  placement: ComposerFunctionBarChipPlacement
  t: (key: MessageKey) => string
  disabled: boolean
  planModeActive: boolean
  goalModeActive: boolean
  /** 目标模式 chip 的文案覆盖（外部执行体自报）；不传时用包内的「目标模式」。 */
  goalModeLabel?: string
  capabilityControls?: readonly ChatComposerCapabilityControl[]
  onClearPlanMode: () => void
  onClearGoalMode: () => void
  browserElementSelections: BrowserElementSelection[]
  onRemoveBrowserElementSelection?: (id: string) => void
  /** 环境回合上下文待附加 delta（已减去 dismissed）；发送时冻结进消息。 */
  turnContextDeltas?: TurnContextDelta[]
  /** Workbench 当前可见文件；稳定状态只显示一枚，不参与历史 delta 分组。 */
  workbenchCurrentFilePath?: string
  onDismissWorkbenchCurrentFile?: () => void
  onDismissTurnContextDelta?: (id: string) => void
  activePluginOptions: ChatInputPromptFeatureGroupOption[]
  activeSkillOptions: ChatInputSkillOption[]
  activeMentionOptions?: ChatInputMentionableOption[]
  onRemoveMentionSelection?: (id: string) => void
  onOpenSkillDetail?: ChatInputSkillDetailHandler
  lockedPromptFeatures?: ChatPromptFeatureId[]
  updatePromptFeatureGroup: (option: ChatInputPromptFeatureGroupOption, enabled: boolean) => void
  updateSelectedSkill: (skillId: string, selected: boolean) => void
}

function ComposerActiveChipsBarInner({
  leading,
  placement,
  t,
  disabled,
  planModeActive,
  goalModeActive,
  goalModeLabel,
  capabilityControls = [],
  onClearPlanMode,
  onClearGoalMode,
  browserElementSelections,
  onRemoveBrowserElementSelection,
  turnContextDeltas,
  workbenchCurrentFilePath,
  onDismissWorkbenchCurrentFile,
  onDismissTurnContextDelta,
  activePluginOptions,
  activeSkillOptions,
  activeMentionOptions,
  onRemoveMentionSelection,
  onOpenSkillDetail,
  lockedPromptFeatures = EmptyLockedPromptFeatures,
  updatePromptFeatureGroup,
  updateSelectedSkill,
}: ComposerActiveChipsBarProps): Nullable<ReactElement> {
  const isPersistent = placement === 'persistent'
  // 常驻档才需要单行收起：add-menu 上方那条活动芯片区是可以换行的多行区，不参与本机制。
  const { barRef, collapsed: chipsCollapsed } = useComposerToolbarChipCollapse()
  const lockedPromptFeatureSet = useMemo(
    () => new Set<ChatPromptFeatureId>(lockedPromptFeatures),
    [lockedPromptFeatures]
  )

  function slotChips(slot: ComposerFunctionBarChipSlotId): ReactNode[] {
    if (COMPOSER_FUNCTION_BAR_CHIP_CONFIG[slot].placement !== placement) return []

    switch (slot) {
      case 'plan':
        return [
          ...(planModeActive
            ? [
                <ComposerActiveChip
                  key="plan-mode"
                  className={resolveComposerFunctionBarChipClassName(slot)}
                  chipDataPluginId="plan"
                  title={t('chat.composerPlanMode')}
                  label={t('chat.composerPlanMode')}
                  icon={<ListChecksIcon size={12} weight="bold" />}
                  disabled={disabled}
                  onRemove={onClearPlanMode}
                  removeAriaLabel={t('chat.composerPlanMode')}
                />,
              ]
            : []),
        ]
      case 'goal':
        return [
          ...(goalModeActive
            ? [
                <ComposerActiveChip
                  key="goal-mode"
                  className={resolveComposerFunctionBarChipClassName(slot)}
                  chipDataPluginId="goal-mode"
                  title={goalModeLabel ?? t('chat.composerGoalMode')}
                  label={goalModeLabel ?? t('chat.composerGoalMode')}
                  icon={<TargetIcon size={12} weight="bold" />}
                  disabled={disabled}
                  onRemove={onClearGoalMode}
                  removeAriaLabel={goalModeLabel ?? t('chat.composerGoalMode')}
                />,
              ]
            : []),
        ]
      case 'capabilities':
        return selectActiveComposerCapabilityControls(capabilityControls).map((control) => (
            <ComposerActiveChip
              key={`${slot}-${control.id}`}
              className={resolveComposerFunctionBarChipClassName(slot)}
              chipDataPluginId={control.id}
              title={control.description || control.label}
              label={control.label}
              icon={<ComposerCapabilityIcon name={control.icon} size={12} />}
              disabled={disabled || control.disabled}
              onRemove={() => control.onChange?.(false)}
              removeAriaLabel={control.label}
            />
          ))
      case 'browser-elements':
        return browserElementSelections.map((selection) => {
          const title = formatBrowserElementSelectionTitle(
            selection,
            t('browser.elementPickerSteps')
          )

          return (
            <ComposerActiveChip
              key={`${slot}-${selection.id}`}
              className={resolveComposerFunctionBarChipClassName(slot)}
              chipDataPluginId="browser-element"
              title={title}
              label={selection.label}
              icon={<CursorClickIcon size={12} weight="bold" />}
              disabled={disabled}
              onRemove={optionalWhenLazy(
                onRemoveBrowserElementSelection,
                () => () => onRemoveBrowserElementSelection!(selection.id)
              )}
              removeAriaLabel={selection.label}
            />
          )
        })
      case 'turn-context':
        return [
          ...(workbenchCurrentFilePath?.trim()
            ? [
                <ComposerActiveChip
                  key={`${slot}-workbench-current-file`}
                  className={resolveComposerFunctionBarChipClassName(slot)}
                  chipDataPluginId="workbench-current-file"
                  title={workbenchCurrentFilePath}
                  label={resolveCurrentFileLabel(workbenchCurrentFilePath)}
                  icon={<FileCodeIcon size={12} weight="bold" />}
                  disabled={disabled}
                  onRemove={onDismissWorkbenchCurrentFile}
                  removeAriaLabel={resolveCurrentFileLabel(workbenchCurrentFilePath)}
                />,
              ]
            : []),
          ...groupTurnContextChips(turnContextDeltas ?? []).map((group) => (
            <ComposerActiveChip
              key={`${slot}-${group.id}`}
              className={resolveComposerFunctionBarChipClassName(slot)}
              chipDataPluginId="turn-context"
              title={group.title}
              label={group.label}
              icon={<PulseIcon size={12} weight="bold" />}
              disabled={disabled}
              onRemove={optionalWhenLazy(onDismissTurnContextDelta, () => () => {
                for (const delta of group.deltas) onDismissTurnContextDelta!(delta.id)
              })}
              removeAriaLabel={`${t('chat.contextIgnoreOnce')}: ${group.label}`}
            />
          )),
        ]
      case 'plugins':
        return [
          ...activePluginOptions.map((option) => {
            const Icon = option.icon
            const isLocked = option.featureIds.some((feature) =>
              lockedPromptFeatureSet.has(feature)
            )

            return (
              <ComposerActiveChip
                key={`${slot}-${option.id}`}
                className={resolveComposerFunctionBarChipClassName(slot)}
                chipDataPluginId={option.id}
                title={t(option.labelKey)}
                label={t(option.labelKey)}
                icon={<Icon size={12} weight="fill" />}
                disabled={disabled}
                onRemove={optionalWhenLazy(
                  !isLocked,
                  () => () => updatePromptFeatureGroup(option, false)
                )}
                removeAriaLabel={optionalWhenLazy(!isLocked, () => t(option.labelKey))}
                showRemoveButton={!isLocked}
              />
            )
          }),
        ]
      case 'skills':
        return activeSkillOptions.map((skill) => (
          <ComposerActiveChip
            key={`${slot}-${skill.id}`}
            className={resolveComposerFunctionBarChipClassName(
              slot,
              cx('activePluginChip', 'activeSkillChip')
            )}
            chipDataSkillId={skill.id}
            title={skill.description || skill.label}
            label={skill.label}
            icon={<FileCodeIcon size={12} weight="fill" />}
            disabled={disabled}
            onActivate={optionalWhenLazy(onOpenSkillDetail, () => () => onOpenSkillDetail!(skill))}
            activateAriaLabel={skill.label}
            onRemove={() => updateSelectedSkill(skill.id, false)}
            removeAriaLabel={skill.label}
          />
        ))
      case 'mentions':
        return (activeMentionOptions ?? []).map((option) => (
          <ComposerActiveChip
            key={`${slot}-${option.id}`}
            className={resolveComposerFunctionBarChipClassName(slot)}
            chipDataPluginId="composer-mention"
            title={option.body ? `${option.label} · ${option.body}` : option.label}
            label={option.label}
            icon={<AtIcon size={12} weight="bold" />}
            disabled={disabled}
            onRemove={optionalWhenLazy(
              onRemoveMentionSelection,
              () => () => onRemoveMentionSelection!(option.id)
            )}
            removeAriaLabel={option.label}
          />
        ))
      default:
        return []
    }
  }

  const chipNodes: ReactNode[] = []
  for (const slot of COMPOSER_FUNCTION_BAR_CHIP_ORDER) {
    chipNodes.push(...slotChips(slot))
  }

  if (!leading && isEmpty(chipNodes)) return null

  return (
    <Inline
      ref={isPersistent ? barRef : undefined}
      className={isPersistent ? styles.executionModeBar : styles.activePluginBar}
      gap="sm"
      // 执行模式芯片恒定单行：宽度不够时由 useComposerToolbarChipCollapse 把标签塌成图标，
      // 而不是换行——工具条一变两层，模型选择器和发送键就被整体顶走。
      // 这里必须走 `wrap` prop 而不是在模块 CSS 里写 `flex-wrap: nowrap`：Inline 的
      // `velar-inline-wrap-wrap` 是同优先级的全局类，谁赢取决于样式表加载顺序。
      wrap={isPersistent ? 'nowrap' : 'wrap'}
      data-chips-collapsed={isPersistent ? chipsCollapsed : undefined}
    >
      {leading}
      {chipNodes}
    </Inline>
  )
}

export const ComposerActiveChipsBar = memo(ComposerActiveChipsBarInner)
ComposerActiveChipsBar.displayName = 'ComposerActiveChipsBar'
