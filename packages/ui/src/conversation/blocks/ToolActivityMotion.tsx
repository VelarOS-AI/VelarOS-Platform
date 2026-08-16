import { memo, type ReactElement, type ReactNode, useLayoutEffect } from 'react'

import { StyleUtils } from '@velaros-ai/ui'

import styles from './MessageBubble.module.css'

import type { ToolCallBlock as ToolCallBlockType } from '#contracts'
import { isBlank, isPresent, isString } from '#internal/runtime'

const cx = StyleUtils.bindCx(styles)
const MaxRememberedToolActivityMotions = 1_200
const ToolActivityMotionRevisionByKey = new Map<string, string>()

function rememberToolActivityMotionRevision(key: string, revision: string): void {
  if (ToolActivityMotionRevisionByKey.has(key)) {
    ToolActivityMotionRevisionByKey.delete(key)
  } else if (ToolActivityMotionRevisionByKey.size >= MaxRememberedToolActivityMotions) {
    const oldestKey = ToolActivityMotionRevisionByKey.keys().next().value
    if (isString(oldestKey)) ToolActivityMotionRevisionByKey.delete(oldestKey)
  }

  ToolActivityMotionRevisionByKey.set(key, revision)
}

function getToolActivityMotionPhase(block: ToolCallBlockType): string {
  if (block.isRunning) {
    if (isPresent(block.progress) && !isBlank(block.progress)) return 'running-progress'
    if (isPresent(block.metadata)) return 'running-metadata'
    return 'running'
  }

  if (isPresent(block.error) && !isBlank(block.error)) return 'error'
  if (isPresent(block.result)) return 'complete'
  return 'settled'
}

/**
 * 只描述会改变卡片视觉语义的阶段，不把每条 progress 文本都变成一次动画。
 * 同工具组新增成员会改变 revision，但沿用稳定 activityKey，因此表现为“更新”而不是整卡重新入场。
 */
export function getToolActivityMotionRevision(blocks: readonly ToolCallBlockType[]): string {
  return blocks.map((block) => `${block.toolCallId}:${getToolActivityMotionPhase(block)}`).join('|')
}

export function resolveToolActivityMotionKind({
  isStreaming,
  previousRevision,
  revision,
}: {
  isStreaming: boolean
  previousRevision?: string
  revision: string
}): 'enter' | 'none' | 'update' {
  if (!isStreaming) return 'none'
  if (!isPresent(previousRevision)) return 'enter'
  return previousRevision === revision ? 'none' : 'update'
}

function ToolActivityMotionInner({
  activityKey,
  blocks,
  children,
  isStreaming,
  messageId,
  sessionId,
}: {
  activityKey: string
  blocks: readonly ToolCallBlockType[]
  children: ReactNode
  isStreaming: boolean
  messageId: string
  sessionId: string
}): ReactElement {
  const registryKey = `${sessionId}:${messageId}:${activityKey}`
  const revision = getToolActivityMotionRevision(blocks)
  const previousRevision = ToolActivityMotionRevisionByKey.get(registryKey)
  const motionKind = resolveToolActivityMotionKind({
    isStreaming,
    previousRevision,
    revision,
  })

  useLayoutEffect(() => {
    rememberToolActivityMotionRevision(registryKey, revision)
  }, [registryKey, revision])

  return (
    <div
      className={cx('toolActivityMotion', motionKind === 'enter' && 'toolActivityMotionEnter')}
      data-tool-activity-motion={motionKind}
    >
      {children}
      {motionKind === 'update' && (
        <span key={revision} className={styles.toolActivityMotionUpdatePulse} aria-hidden="true" />
      )}
    </div>
  )
}

export const ToolActivityMotion = memo(ToolActivityMotionInner)
ToolActivityMotion.displayName = 'ToolActivityMotion'
