import React, { memo } from 'react'
import { CheckCircleIcon, WarningCircleIcon } from '@phosphor-icons/react'

import { StyleUtils } from '@velaros-ai/ui'
import { Paragraph } from '@velaros-ai/ui/primitives/display/Paragraph'
import { Stack } from '@velaros-ai/ui/primitives/layout/Stack'
import { CompactToolRow } from '@velaros-ai/ui/product/layout/CompactToolRow'
import { ToolDisclosureCard } from '@velaros-ai/ui/product/layout/ToolDisclosureCard'

import { useConversationI18n, useConversationTranslatorRuntime } from '../i18n'

import { getToolDescription, getToolDetailSummary, getToolResultSummary, getToolStatusLabel, normalizeInline } from './toolCallSummary'
import { DEFAULT_TOOL_JSON_PREVIEW_MAX_CHARS, formatUnknownPayload, truncateForDisplay } from './toolDisplay'
import { toolLeadingPhosphorIconForTool } from './toolLeadingPhosphorIcon'
import { getToolDisplayName, humanizeToolName } from './toolPresentation'

import styles from './ToolCallBlock.module.css'

import type { ToolCallBlock as ToolCallBlockType } from '#contracts'
import { isEmpty,isPresent, optionalWhenLazy } from '#internal/runtime'

const cx = StyleUtils.bindCx(styles)

interface DefaultToolRenderProps {
  block: ToolCallBlockType
  compact?: boolean
  sessionId?: string
  formatPathForDisplay?: (path: string) => string
}

/**
 * 默认通用工具渲染（JSON 转储）
 * 各工具可通过 colocated tool-render registration 声明专属渲染组件来覆盖此行为。
 */
export const DefaultToolRender = memo(
  ({
    block,
    compact = false,
    formatPathForDisplay,
  }: DefaultToolRenderProps): React.ReactElement => {
    const { locale, t } = useConversationI18n()
    const translatorRuntime = useConversationTranslatorRuntime()
    const hasResult = !block.isRunning && isPresent(block.result)
    const hasError = !block.isRunning && isPresent(block.error)
    const progressText = block.progress?.trim()
    const metadata = block.metadata
    const tone = block.isRunning ? 'running' : hasError ? 'error' : 'success'
    const description = getToolDescription(
      block,
      locale,
      formatPathForDisplay,
      translatorRuntime
    )
    const detailSummary = getToolDetailSummary(
      block,
      formatPathForDisplay,
      locale,
      translatorRuntime
    )
    const statusLabel = getToolStatusLabel(block, locale, translatorRuntime)
    const displayName =
      block.title?.trim() || getToolDisplayName(block.toolName, locale, translatorRuntime)
    const argsText = formatUnknownPayload(block.args)
    const formattedArgs = truncateForDisplay(
      argsText,
      DEFAULT_TOOL_JSON_PREVIEW_MAX_CHARS,
      String(argsText.length)
    )
    const resultText = formatUnknownPayload(block.result)
    const formattedResult = truncateForDisplay(
      resultText,
      DEFAULT_TOOL_JSON_PREVIEW_MAX_CHARS,
      String(resultText.length)
    )
    const errorText = formatUnknownPayload(block.error)
    const formattedError = truncateForDisplay(
      errorText,
      DEFAULT_TOOL_JSON_PREVIEW_MAX_CHARS,
      String(errorText.length)
    )
    const metadataText = formatUnknownPayload(metadata)
    const formattedMetadata = truncateForDisplay(
      metadataText,
      DEFAULT_TOOL_JSON_PREVIEW_MAX_CHARS,
      String(metadataText.length)
    )
    const compactDescription = block.isRunning
      ? (detailSummary ?? description)
      : [
          detailSummary,
          hasError
            ? normalizeInline(formattedError)
            : getToolResultSummary(block, locale, translatorRuntime),
        ]
          .filter((value) => !!value)
          .join(' · ') || description

    if (compact) return (
        <CompactToolRow
          tone={tone === 'success' ? 'success' : tone}
          icon={toolLeadingPhosphorIconForTool(block.toolName, 12)}
          label={displayName}
          detail={compactDescription}
          detailTitle={compactDescription}
          count={statusLabel}
        />
      )

    return (
      <ToolDisclosureCard
        statusTone={tone}
        statusIcon={
          block.isRunning ? (
            <span className={styles.runningStatusDot} aria-hidden="true" />
          ) : hasError ? (
            <WarningCircleIcon size={13} weight="fill" />
          ) : (
            <CheckCircleIcon size={13} weight="fill" />
          )
        }
        leadingIcon={toolLeadingPhosphorIconForTool(block.toolName, 12, styles.toolIcon)}
        title={displayName}
        meta={
          optionalWhenLazy(!(displayName === humanizeToolName(block.toolName)), () => (
            <code className={styles.toolName}>{block.toolName}</code>
          ))
        }
        subtitle={description}
        defaultOpen={false}
      >
        <Stack className={styles.sections} gap="sm">
          {!isEmpty(Object.keys(block.args)) && (
            <Stack className={styles.section} gap="xs">
              <Paragraph spacing="none" className={styles.sectionLabel}>
                {t('debug.toolArgs')}
              </Paragraph>
              <pre className={styles.code}>{formattedArgs}</pre>
            </Stack>
          )}

          {!!progressText && (
            <Stack className={styles.section} gap="xs">
              <Paragraph spacing="none" className={styles.sectionLabel}>
                {t('debug.toolProgress')}
              </Paragraph>
              <pre className={styles.code}>{progressText}</pre>
            </Stack>
          )}

          {isPresent(metadata) && (
            <Stack className={styles.section} gap="xs">
              <Paragraph spacing="none" className={styles.sectionLabel}>
                {t('debug.toolMetadata')}
              </Paragraph>
              <pre className={styles.code}>{formattedMetadata}</pre>
            </Stack>
          )}

          {hasResult && (
            <Stack className={styles.section} gap="xs">
              <Paragraph spacing="none" className={styles.sectionLabel}>
                {t('debug.toolResult')}
              </Paragraph>
              <pre className={styles.code}>{formattedResult}</pre>
            </Stack>
          )}

          {hasError && (
            <Stack className={styles.section} gap="xs">
              <Paragraph spacing="none" className={cx('sectionLabel', 'errorLabel')}>
                {t('debug.toolError')}
              </Paragraph>
              <pre className={cx('code', 'errorCode')}>{formattedError}</pre>
            </Stack>
          )}
        </Stack>
      </ToolDisclosureCard>
    )
  }
)
DefaultToolRender.displayName = 'DefaultToolRender'
