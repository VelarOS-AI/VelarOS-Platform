import React, { memo } from 'react'
import { TargetIcon } from '@phosphor-icons/react'

import { StyleUtils } from '@velaros-ai/ui'
import { Text } from '@velaros-ai/ui/primitives/display/Text'

import { useConversationI18n } from '../../i18n'

import { getGoalToolBlockObjective, getGoalToolBlockStatus } from './goalToolBlock'

import styles from './GoalToolRender.module.css'

import type { ToolCallBlock } from '#contracts'

type GoalToolTone = 'running' | 'success' | 'error'
type GoalToolRenderVariant = 'card' | 'plain'

const cx = StyleUtils.bindCx(styles)

function getGoalTone(block: ToolCallBlock, status: Nullable<string>): GoalToolTone {
  if (block.error || status === 'blocked') return 'error'
  if (status === 'complete') return 'success'
  return 'running'
}

function getGoalStatusLabel(status: Nullable<string>, locale: string): Nullable<string> {
  switch (status) {
    case 'active':
      return locale === 'zh-CN' ? '当前目标' : 'Active goal'
    case 'complete':
      return locale === 'zh-CN' ? '目标完成' : 'Goal complete'
    case 'blocked':
      return locale === 'zh-CN' ? '目标受阻' : 'Goal blocked'
    default:
      return null
  }
}

const GoalToolRender = memo(
  ({
    block,
    compact = false,
    variant = 'card',
  }: {
    block: ToolCallBlock
    compact?: boolean
    variant?: GoalToolRenderVariant
    sessionId?: string
    planUpdateIndex?: number
  }): React.ReactElement => {
    const { locale } = useConversationI18n()
    const displayName = block.toolName
    const status = getGoalToolBlockStatus(block)
    const tone = getGoalTone(block, status)
    const statusLabel = getGoalStatusLabel(status, locale)
    const objective = block.error ? null : getGoalToolBlockObjective(block)

    return (
      <section
        className={cx('root', variant === 'plain' && 'plainRoot', compact && 'compactRoot', tone)}
        aria-label={displayName}
      >
        <span className={styles.icon} aria-hidden="true">
          <TargetIcon size={14} weight="regular" />
        </span>
        <Text className={styles.title}>{displayName}</Text>
        {!!statusLabel && (
          <Text className={styles.status} title={statusLabel}>
            {statusLabel}
          </Text>
        )}
        {block.error ? (
          <Text className={styles.errorText} title={block.error}>
            {block.error}
          </Text>
        ) : !!objective && (
          <Text className={styles.objective} title={objective}>
            {objective}
          </Text>
        )}
      </section>
    )
  }
)

GoalToolRender.displayName = 'GoalToolRender'

export { GoalToolRender }
