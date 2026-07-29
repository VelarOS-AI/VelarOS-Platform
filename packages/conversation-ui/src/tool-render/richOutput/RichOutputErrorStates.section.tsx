import React from 'react'
import { SpinnerGapIcon, WarningCircleIcon } from '@phosphor-icons/react'

import { Text } from '@velaros-ai/ui/primitives/display/Text'

import { RichToolOutputCard } from './RichToolOutputCard.section'

import styles from './RichOutputToolRender.module.css'

import type { ToolCallBlock } from '#contracts'

export function RichOutputRunningPlaceholder({ label }: { label: string }): React.ReactElement {
  return (
    <div className={styles.emptyState}>
      <SpinnerGapIcon size={14} className={styles.spinIcon} />
      <Text>{label}</Text>
    </div>
  )
}

export function RichOutputToolErrorCard({
  block,
  compact,
  title,
}: {
  block: ToolCallBlock
  compact?: boolean
  title: string
}): Nullable<React.ReactElement> {
  if (!block.error) return null

  return (
    <RichToolOutputCard
      icon={<WarningCircleIcon size={14} weight="fill" />}
      title={title}
      subtitle={block.error}
      toolBlock={block}
      tone="error"
      compact={compact}
    />
  )
}
