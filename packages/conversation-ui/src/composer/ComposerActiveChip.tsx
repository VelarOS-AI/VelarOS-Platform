import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  useMemo,
} from 'react'
import { XIcon } from '@phosphor-icons/react'

import { Text } from '@velaros-ai/ui/primitives/display/Text'

import { useIsDarkMode } from '../react-hooks/useIsDarkMode'

import { resolveComposerChipTintedForegroundStyle } from './utils/tintedSurfacePresets'

import styles from './ChatInput.module.css'

export interface ComposerActiveChipProps {
  /** Defaults to `activePluginChip` */
  className?: string
  chipDataPluginId?: string
  chipDataSkillId?: string
  tone?: 'default' | 'experimental'
  title: string
  label: ReactNode
  icon: ReactNode
  disabled?: boolean
  onActivate?: () => void
  onRemove?: () => void
  activateAriaLabel?: string
  removeAriaLabel?: string
  showRemoveButton?: boolean
}

export function ComposerActiveChip({
  className,
  chipDataPluginId,
  chipDataSkillId,
  tone = 'default',
  title,
  label,
  icon,
  disabled,
  onActivate,
  onRemove,
  activateAriaLabel,
  removeAriaLabel,
  showRemoveButton,
}: ComposerActiveChipProps): ReactElement {
  const canShowRemoveButton = (showRemoveButton ?? !!onRemove) && !!onRemove
  const canActivate = !!onActivate && !disabled
  const canUseRootButtonSemantics = canActivate && !canShowRemoveButton
  const variantClassName = className ?? styles.activePluginChip
  const isDarkMode = useIsDarkMode()
  const foregroundStyle = useMemo(
    () =>
      resolveComposerChipTintedForegroundStyle(
        { chipDataPluginId, chipDataSkillId, tone },
        isDarkMode
      ),
    [chipDataPluginId, chipDataSkillId, isDarkMode, tone]
  )

  return (
    <div
      className={`${styles.composerActiveChip} ${variantClassName}`}
      data-plugin-id={chipDataPluginId}
      data-skill-id={chipDataSkillId}
      data-tone={tone}
      data-removable={canShowRemoveButton}
      data-activatable={canActivate}
      title={title}
      style={foregroundStyle}
      role={canUseRootButtonSemantics ? 'button' : undefined}
      tabIndex={canUseRootButtonSemantics ? 0 : undefined}
      aria-label={canUseRootButtonSemantics ? (activateAriaLabel ?? title) : undefined}
      onClick={canActivate ? onActivate : undefined}
      onKeyDown={
        canUseRootButtonSemantics
          ? (event: KeyboardEvent<HTMLDivElement>) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              onActivate()
            }
          : undefined
      }
    >
      {canShowRemoveButton ? (
        <button
          type="button"
          className={styles.activePluginLeadingRemoveButton}
          title={removeAriaLabel ?? title}
          onClick={(event: MouseEvent<HTMLButtonElement>) => {
            event.stopPropagation()
            onRemove?.()
          }}
          disabled={disabled}
          aria-label={removeAriaLabel ?? title}
        >
          <span className={styles.activePluginIconDefault}>{icon}</span>
          <span className={styles.activePluginIconRemove}>
            <XIcon size={10} />
          </span>
        </button>
      ) : (
        <span className={styles.activePluginIcon}>{icon}</span>
      )}
      <Text className={styles.activePluginLabel}>{label}</Text>
    </div>
  )
}
