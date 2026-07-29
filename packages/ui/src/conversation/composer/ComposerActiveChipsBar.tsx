import { memo, type ReactElement, type ReactNode, useMemo } from 'react'
import {
  ChatCircleDotsIcon,
  CursorClickIcon,
  FileCodeIcon,
  ListChecksIcon,
  NotePencilIcon,
  PulseIcon,
  TargetIcon,
} from '@phosphor-icons/react'

import { StyleUtils } from '@velaros-ai/ui'
import { Inline } from '@velaros-ai/ui/primitives/layout/Inline'

import type { ConversationMessageKey as MessageKey } from '../i18n'

import { groupTurnContextChips } from './utils/turnContextChipGroups.utils'
import type {
  ChatInputCommentMentionOption,
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
  proposalModeActive: boolean
  goalModeActive: boolean
  capabilityControls?: readonly ChatComposerCapabilityControl[]
  onClearPlanMode: () => void
  onClearProposalMode: () => void
  onClearGoalMode: () => void
  browserElementSelections: BrowserElementSelection[]
  onRemoveBrowserElementSelection?: (id: string) => void
  /** 环境回合上下文待附加 delta（已减去 dismissed）；发送时冻结进消息。 */
  turnContextDeltas?: TurnContextDelta[]
  /** Workbench 当前可见文件；稳定状态只显示一枚，不参与历史 delta 分组。 */
  workbenchCurrentFilePath?: string
  onDismissTurnContextDelta?: (id: string) => void
  activePluginOptions: ChatInputPromptFeatureGroupOption[]
  activeSkillOptions: ChatInputSkillOption[]
  activeCommentOptions?: ChatInputCommentMentionOption[]
  onRemoveCommentSelection?: (id: string) => void
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
  proposalModeActive,
  goalModeActive,
  capabilityControls = [],
  onClearPlanMode,
  onClearProposalMode,
  onClearGoalMode,
  browserElementSelections,
  onRemoveBrowserElementSelection,
  turnContextDeltas,
  workbenchCurrentFilePath,
  onDismissTurnContextDelta,
  activePluginOptions,
  activeSkillOptions,
  activeCommentOptions,
  onRemoveCommentSelection,
  onOpenSkillDetail,
  lockedPromptFeatures = EmptyLockedPromptFeatures,
  updatePromptFeatureGroup,
  updateSelectedSkill,
}: ComposerActiveChipsBarProps): Nullable<ReactElement> {
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
      case 'proposal':
        return [
          ...(proposalModeActive
            ? [
                <ComposerActiveChip
                  key="proposal-mode"
                  className={resolveComposerFunctionBarChipClassName(slot)}
                  chipDataPluginId="proposal"
                  title={t('chat.composerProposalMode')}
                  label={t('chat.composerProposalMode')}
                  icon={<NotePencilIcon size={12} weight="bold" />}
                  disabled={disabled}
                  onRemove={onClearProposalMode}
                  removeAriaLabel={t('chat.composerProposalMode')}
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
                  title={t('chat.composerGoalMode')}
                  label={t('chat.composerGoalMode')}
                  icon={<TargetIcon size={12} weight="bold" />}
                  disabled={disabled}
                  onRemove={onClearGoalMode}
                  removeAriaLabel={t('chat.composerGoalMode')}
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
                />,
              ]
            : []),
          ...groupTurnContextChips(
            (turnContextDeltas ?? []).filter(
              (delta) =>
                delta.sourceId !== 'workspace.editor-focus' &&
                delta.sourceId !== 'workspace.editor-selection'
            )
          ).map((group) => (
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
              removeAriaLabel={group.label}
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
      case 'comments':
        return (activeCommentOptions ?? []).map((comment) => (
          <ComposerActiveChip
            key={`${slot}-${comment.id}`}
            className={resolveComposerFunctionBarChipClassName(slot)}
            chipDataPluginId="workbench-comment"
            title={comment.body ? `${comment.label} · ${comment.body}` : comment.label}
            label={comment.label}
            icon={<ChatCircleDotsIcon size={12} weight="fill" />}
            disabled={disabled}
            onRemove={optionalWhenLazy(
              onRemoveCommentSelection,
              () => () => onRemoveCommentSelection!(comment.id)
            )}
            removeAriaLabel={comment.label}
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
      className={placement === 'persistent' ? styles.executionModeBar : styles.activePluginBar}
      gap="sm"
      wrap="wrap"
    >
      {leading}
      {chipNodes}
    </Inline>
  )
}

export const ComposerActiveChipsBar = memo(ComposerActiveChipsBarInner)
ComposerActiveChipsBar.displayName = 'ComposerActiveChipsBar'
