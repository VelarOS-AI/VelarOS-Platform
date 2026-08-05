import React, { memo } from 'react'
import { SpinnerGapIcon } from '@phosphor-icons/react'

import { CompactToolRow } from '@velaros-ai/ui/product/layout/CompactToolRow'

import { useConversationI18n, useConversationTranslatorRuntime } from '../../i18n'
import { getToolStatusLabel } from '../toolCallSummary'
import { toolLeadingPhosphorIconForTool } from '../toolLeadingPhosphorIcon'

import styles from './FileChangeToolRender.module.css'

import type { ToolCallBlock } from '#contracts'
import { isArray, isBlank, isEmpty, isFalse, isNonBlankString, isPlainObject, isString, isTrue } from '#internal/runtime'
import { asRecord, readFirstString, readStringPreserveOuterWhitespace } from '#internal/unknownJsonRecord'

interface FileChangeToolRenderProps {
  block: ToolCallBlock
  compact?: boolean
  sessionId?: string
  formatPathForDisplay?: (path: string) => string
}

type CompactToolTone = NonNullable<React.ComponentProps<typeof CompactToolRow>['tone']>

function getErrorMessage(error: unknown, fallback = ''): string {
  const messageRecord = isPlainObject(error) ? error : null
  return (
    (isString(error) && !isBlank(error.trim()) ? error : null) ??
    readStringPreserveOuterWhitespace(messageRecord, 'message') ??
    fallback
  )
}

function isZhLocale(locale: string): boolean {
  return locale.toLowerCase().startsWith('zh')
}

function joinSummaryParts(parts: Array<Nullable<string>>): string {
  return parts.filter((part): part is string => isNonBlankString(part)).join(' · ')
}

function collectStringArray(value: unknown): string[] {
  return isArray(value) ? value.filter((entry): entry is string => isNonBlankString(entry)) : []
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)]
}

function collectPatchPaths(result: Nullable<Record<string, unknown>>): string[] {
  if (!isArray(result?.patches)) return []

  return result.patches.flatMap((patch) => {
    if (!patch || !isPlainObject(patch)) return []
    const path = patch.path
    return isNonBlankString(path) ? [path] : []
  })
}

function collectAdvisoryPaths(result: Nullable<Record<string, unknown>>): string[] {
  if (!isArray(result?.advisories)) return []

  return result.advisories.flatMap((advisory) => {
    if (!advisory || !isPlainObject(advisory)) return []
    return collectStringArray(advisory.paths)
  })
}

function collectRevisionPaths(result: Nullable<Record<string, unknown>>): string[] {
  const newRevisions = asRecord(result?.newRevisions)
  return newRevisions ? Object.keys(newRevisions).filter((path) => isNonBlankString(path)) : []
}

function getTransactionId(
  result: Nullable<Record<string, unknown>>,
  args: Nullable<Record<string, unknown>>
): Nullable<string> {
  return readFirstString(result?.transactionId, args?.transactionId)
}

function isProjectApplyPreflight(result: Nullable<Record<string, unknown>>): boolean {
  return (
    isTrue(result?.blocked) ||
    (isString(result?.status) &&
      (result?.status === 'needs_model_review' || result?.status === 'needs_model_confirmation'))
  )
}

function isProjectApplyRejected(result: Nullable<Record<string, unknown>>): boolean {
  return isTrue(result?.skipped) || isFalse(result?.approved)
}

function getProjectApplyStatusText(
  block: ToolCallBlock,
  result: Nullable<Record<string, unknown>>,
  locale: string
): string {
  const zh = isZhLocale(locale)
  if (block.error) return zh ? '应用失败' : 'Failed'
  if (block.isRunning) return zh ? '正在应用' : 'Applying'
  if (isProjectApplyRejected(result)) return zh ? '已拒绝' : 'Rejected'
  if (isProjectApplyPreflight(result)) return zh ? '待确认' : 'Pending confirmation'
  switch (result?.status) {
    case 'needs_model_review': {
      return zh ? '待模型审核' : 'Needs review'
    }
    case 'validation_failed': {
      return zh ? '校验失败' : 'Validation failed'
    }
    case 'validated': {
      return zh ? '已校验' : 'Validated'
    }
  }
  if (isFalse(result?.changed)) return zh ? '无变化' : 'No changes'
  return zh ? '已写入' : 'Applied'
}

function getProjectApplyTone(
  block: ToolCallBlock,
  result: Nullable<Record<string, unknown>>
): CompactToolTone {
  if (block.error) return 'error'
  switch (result?.status) {
    case 'validation_failed': {
      return 'error'
    }
    case 'needs_model_review': {
      return 'neutral'
    }
  }
  if (isProjectApplyRejected(result) || isFalse(result?.changed)) return 'neutral'
  if (block.isRunning || isProjectApplyPreflight(result)) return 'running'
  return 'success'
}

export function collectProjectApplyPaths(
  result: Nullable<Record<string, unknown>>,
  args: Nullable<Record<string, unknown>>
): string[] {
  return uniqueStrings([
    ...collectStringArray([result?.path, result?.fromPath, result?.toPath]),
    ...collectStringArray(result?.changedFiles),
    ...collectRevisionPaths(result),
    ...collectPatchPaths(result),
    ...collectAdvisoryPaths(result),
    // 系统 write/edit 在执行前只有 args.path；执行结果也可能来自旧会话或流式快照，
    // 因此参数路径是显示层必要的兜底，不能只认工作区事务字段。
    ...collectStringArray([args?.path, args?.fromPath, args?.toPath]),
  ])
}

function buildTargetLabel(
  paths: string[],
  fallback: string,
  formatPathForDisplay?: (path: string) => string
): { label: string; title: string } {
  if (isEmpty(paths)) return { label: fallback, title: fallback }

  const displayPaths = paths.map((path) =>
    formatPathForDisplay ? formatPathForDisplay(path) : path
  )
  const firstPath = displayPaths[0] ?? ''
  const label = displayPaths.length === 1 ? firstPath : `${firstPath} +${displayPaths.length - 1}`
  return {
    label,
    title: displayPaths.join('\n'),
  }
}

const ProjectApplyEditRow = memo(
  ({ block, formatPathForDisplay }: FileChangeToolRenderProps): React.ReactElement => {
    const { locale, t } = useConversationI18n()
    const translatorRuntime = useConversationTranslatorRuntime()
    const result = asRecord(block.result)
    const args = asRecord(block.args)
    const displayName = block.toolName
    const transactionId = getTransactionId(result, args)
    const changedFiles = collectProjectApplyPaths(result, args)
    const fallbackTarget = transactionId ? `tx: ${transactionId}` : t('chat.fileChangeUnknownFile')
    const target = buildTargetLabel(changedFiles, fallbackTarget, formatPathForDisplay)
    const statusText = getProjectApplyStatusText(block, result, locale)
    const statusLabel = getToolStatusLabel(block, locale, translatorRuntime)
    const errorMessage = block.error
      ? getErrorMessage(block.error, t('chat.fileChangeErrorFallback'))
      : null
    const tone = getProjectApplyTone(block, result)

    return (
      <CompactToolRow
        tone={tone}
        icon={
          block.isRunning ? (
            <SpinnerGapIcon size={12} className={styles.spinIcon} />
          ) : (
            // 每个编辑族工具使用各自的语义图标：edit=铅笔，rollback=回退。
            toolLeadingPhosphorIconForTool(block.toolName, 12)
          )
        }
        label={displayName}
        detail={target.label}
        detailTitle={errorMessage ? joinSummaryParts([errorMessage, target.title]) : target.title}
        count={statusLabel ?? statusText}
        countTitle={joinSummaryParts([
          errorMessage,
          statusText,
          statusLabel,
          transactionId ? `tx: ${transactionId}` : null,
        ])}
      />
    )
  }
)

ProjectApplyEditRow.displayName = 'ProjectApplyEditRow'

const FileChangeToolRender = memo(
  (props: FileChangeToolRenderProps): React.ReactElement => (
    // 所有写盘的 Project 编辑工具都渲染成
    // 紧凑的「工具调用」行：工具名 + 变更文件 + 状态。不再逐工具单独渲染差异卡——每条改动的 +/-
    // 差异统一由消息末尾那张汇总卡展示（见 MessageFileChangeSummary），避免中途一堆 +0-0 小卡。
    <ProjectApplyEditRow {...props} />
  )
)

FileChangeToolRender.displayName = 'FileChangeToolRender'

export { FileChangeToolRender }
