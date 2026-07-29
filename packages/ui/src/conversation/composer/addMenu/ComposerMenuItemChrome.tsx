import { QuestionMarkIcon } from '@phosphor-icons/react'
import type { ComponentType, ReactElement, ReactNode } from 'react'

import { cn } from '@velaros-ai/ui/lib/cn'
import { Text } from '@velaros-ai/ui/primitives/display/Text'
import { BubbleTooltip } from '@velaros-ai/ui/primitives/overlays/Tooltip'

import styles from '../ChatInput.module.css'

export function formatComposerMenuItemHelp(
  help: string,
  options: { experimental?: boolean; experimentalLabel?: string } = {}
): string {
  const { experimental = false, experimentalLabel } = options
  if (!experimental || !experimentalLabel) return help

  const prefix = `${experimentalLabel}: `
  return help.startsWith(prefix) ? help : `${prefix}${help}`
}

export function ComposerMenuItemIcon({
  icon: Icon,
  size = 14,
  experimental = false,
}: {
  icon: ComponentType<{ size?: number; className?: string }>
  size?: number
  experimental?: boolean
}): ReactElement {
  return (
    <Icon
      size={size}
      className={experimental ? styles.composerMenuItemExperimentalIcon : undefined}
    />
  )
}

export function ComposerMenuHelpIcon({
  content,
}: {
  content: string
}): ReactElement {
  return (
    <BubbleTooltip
      content={content}
      ariaLabel={content}
      side="top"
      align="center"
      sideOffset={8}
    >
      <span
        className={styles.composerMenuHelpButton}
        tabIndex={0}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <QuestionMarkIcon size={10} weight="bold" />
      </span>
    </BubbleTooltip>
  )
}

export function ComposerMenuItemBody({
  label,
  help,
  experimental = false,
  experimentalLabel,
}: {
  label: ReactNode
  help?: string
  experimental?: boolean
  experimentalLabel?: string
}): ReactElement {
  const helpContent = help
    ? formatComposerMenuItemHelp(help, { experimental, experimentalLabel })
    : undefined

  return (
    <span className={styles.composerMenuItemBody}>
      <Text className={styles.composerMenuItemBodyLabel}>{label}</Text>
      {!!helpContent && <ComposerMenuHelpIcon content={helpContent} />}
    </span>
  )
}

export function ComposerMenuSwitchIndicator({ checked }: { checked: boolean }): ReactElement {
  return (
    <span
      aria-hidden="true"
      data-slot="switch"
      data-state={checked ? 'checked' : 'unchecked'}
      className={cn(
        'velar-switch',
        'velar-switch-tone-default',
        'velar-switch-size-xs',
        styles.composerMenuSwitch
      )}
    >
      <span className="velar-switch-thumb" />
    </span>
  )
}
