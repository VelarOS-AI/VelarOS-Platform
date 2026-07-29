import React, { memo } from 'react'
import { CheckCircleIcon, WarningCircleIcon, WrenchIcon, XCircleIcon } from '@phosphor-icons/react'

import { StyleUtils } from '@velaros-ai/ui'
import { Paragraph } from '@velaros-ai/ui/primitives/display/Paragraph'
import { Text } from '@velaros-ai/ui/primitives/display/Text'
import { Stack } from '@velaros-ai/ui/primitives/layout/Stack'
import { CompactToolRow } from '@velaros-ai/ui/product/layout/CompactToolRow'
import { ToolDisclosureCard } from '@velaros-ai/ui/product/layout/ToolDisclosureCard'

import type { ConversationMessageKey } from '../../i18n'
import { useConversationI18n, useConversationTranslatorRuntime } from '../../i18n'
import { getToolStatusLabel } from '../toolCallSummary'
import { formatUnknownPayload, truncateLocalizedCommandOutput } from '../toolDisplay'

import { buildSystemToolInstallCompactLine } from './systemToolInstallRenderModel'

import styles from '../command/CommandToolRender.module.css'

import type { ToolCallBlock, WorkspaceCommandResult } from '#contracts'
import { isFalse,isPresent, isString, toNullable } from '#internal/runtime'
import { peekLooseBoolean, peekLooseString, readRecord } from '#internal/unknownJsonRecord'

const cx = StyleUtils.bindCx(styles)
type Translate = (key: ConversationMessageKey, params?: Record<string, string | number>) => string

interface InstallToolResult {
  suggested?: LooseOptional<boolean>
  available?: LooseOptional<boolean>
  approved?: LooseOptional<boolean>
  installed?: LooseOptional<boolean>
  command?: LooseOptional<string>
  label?: LooseOptional<string>
  installCommand?: LooseOptional<string>
  reason?: LooseOptional<string>
  rejectionMessage?: LooseOptional<string>
  path?: LooseOptional<string>
  message?: LooseOptional<string>
  error?: LooseOptional<string>
  commandResult?: LooseOptional<WorkspaceCommandResult>
}

function isWorkspaceCommandResult(value: any): value is WorkspaceCommandResult {
  const record = readRecord(value)
  return !!record && isString(record.command) && isString(record.stdout) && isString(record.stderr)
}

function readInstallResult(value: any): Nullable<InstallToolResult> {
  const record = readRecord(value)
  if (!record) return null

  const commandResult = isWorkspaceCommandResult(record.commandResult) ? record.commandResult : null

  return {
    suggested: peekLooseBoolean(record, 'suggested'),
    available: peekLooseBoolean(record, 'available'),
    approved: peekLooseBoolean(record, 'approved'),
    installed: peekLooseBoolean(record, 'installed'),
    command: peekLooseString(record, 'command'),
    label: peekLooseString(record, 'label'),
    installCommand: peekLooseString(record, 'installCommand'),
    reason: peekLooseString(record, 'reason'),
    rejectionMessage: toNullable(peekLooseString(record, 'rejectionMessage')),
    path: toNullable(peekLooseString(record, 'path')),
    message: peekLooseString(record, 'message'),
    error: peekLooseString(record, 'error'),
    commandResult,
  }
}

function getStatus(
  block: ToolCallBlock,
  result: Nullable<InstallToolResult>,
  t: Translate
): { tone: 'running' | 'success' | 'warning' | 'error'; label: string; summary: string } {
  const toolLabel = result?.label ?? result?.command ?? t('systemToolInstall.defaultTool')

  if (block.isRunning)
    return {
      tone: 'running',
      label: t('systemToolInstall.awaitingOrInstalling'),
      summary: t('systemToolInstall.awaitingOrInstallingSummary'),
    }

  if (block.error || result?.error)
    return {
      tone: 'error',
      label: t('systemToolInstall.installFailed'),
      summary: block.error ?? result?.error ?? '',
    }

  if (result?.available)
    return {
      tone: 'success',
      label: t('systemToolInstall.alreadyAvailable'),
      summary: t('systemToolInstall.availableSummary', {
        command: result.command ?? toolLabel,
      }),
    }

  if (isPresent(result) && isFalse(result.approved)) {
    const rejectionMessage = result.rejectionMessage?.trim()

    return {
      tone: 'warning',
      label: t('systemToolInstall.rejected'),
      summary: rejectionMessage
        ? t('systemToolInstall.rejectedWithReason', { reason: rejectionMessage })
        : t('systemToolInstall.rejectedFallback'),
    }
  }

  if (result?.installed)
    return {
      tone: 'success',
      label: t('systemToolInstall.installed'),
      summary: t('systemToolInstall.installedSummary', { label: toolLabel }),
    }

  if (result?.approved)
    return {
      tone: 'error',
      label: t('systemToolInstall.notCompleted'),
      summary: t('systemToolInstall.commandStillMissingDescription', { label: toolLabel }),
    }

  if (isPresent(result) && isFalse(result.suggested) && isFalse(result.available))
    return {
      tone: 'warning',
      label: t('systemToolInstall.notCompleted'),
      summary: result.label
        ? t('systemToolInstall.noInstallCommandSummary', { label: result.label })
        : t('systemToolInstall.noAutomaticSuggestionSummary', {
            command: result.command ?? toolLabel,
          }),
    }

  return {
    tone: 'warning',
    label: t('systemToolInstall.notCompleted'),
    summary: result?.message ?? '',
  }
}

function getStatusIcon(
  block: ToolCallBlock,
  result: Nullable<InstallToolResult>
): React.ReactElement {
  if (block.isRunning) return <span className={styles.runningStatusDot} aria-hidden="true" />

  if (block.error || result?.error || (!!result?.approved && !result.installed))
    return <XCircleIcon size={13} weight="fill" />

  if (isPresent(result) && isFalse(result.approved))
    return <WarningCircleIcon size={13} weight="fill" />

  return <CheckCircleIcon size={13} weight="fill" />
}

const SystemToolInstallToolRender = memo(
  ({ block, compact = false }: { block: ToolCallBlock; compact?: boolean }): React.ReactElement => {
    const { locale, t } = useConversationI18n()
    const translatorRuntime = useConversationTranslatorRuntime()
    const result = readInstallResult(block.result)
    const args = readRecord(block.args)
    const label =
      result?.label ?? peekLooseString(args, 'command') ?? t('systemToolInstall.defaultTool')
    const command = result?.command ?? peekLooseString(args, 'command') ?? ''
    const reason = result?.reason ?? peekLooseString(args, 'reason') ?? ''
    const installCommand = result?.installCommand ?? ''
    const commandResult = toNullable(result?.commandResult)
    const status = getStatus(block, result, t)
    const compactLine = buildSystemToolInstallCompactLine([
      label,
      installCommand || command,
      status.summary,
    ])

    if (compact)
      return (
        <CompactToolRow
          tone={status.tone}
          icon={<WrenchIcon size={12} />}
          label={t('systemToolInstall.compactLabel')}
          detail={compactLine}
          detailTitle={compactLine}
          count={getToolStatusLabel(block, locale, translatorRuntime)}
        />
      )

    return (
      <ToolDisclosureCard
        statusTone={status.tone}
        defaultOpen={false}
        statusIcon={getStatusIcon(block, result)}
        leadingIcon={<WrenchIcon size={12} className={styles.terminalIcon} />}
        title={t('systemToolInstall.requestTitle')}
        meta={<Text className={cx('statusBadge', status.tone)}>{status.label}</Text>}
        subtitle={
          <Stack gap="xs">
            <Paragraph spacing="none" className={styles.purpose}>
              {label}
              {reason ? ` · ${reason}` : ''}
            </Paragraph>
            {!!installCommand && <code className={styles.commandLine}>{installCommand}</code>}
          </Stack>
        }
      >
        <Stack className={styles.sections} gap="sm">
          <div className={styles.metaGrid}>
            {!!command && (
              <div className={styles.metaItem}>
                <Paragraph spacing="none" className={styles.metaLabel}>
                  {t('systemToolInstall.command')}
                </Paragraph>
                <Paragraph spacing="none" className={styles.metaValue}>
                  {command}
                </Paragraph>
              </div>
            )}
            {!!result?.path && (
              <div className={styles.metaItem}>
                <Paragraph spacing="none" className={styles.metaLabel}>
                  {t('systemToolInstall.path')}
                </Paragraph>
                <Paragraph spacing="none" className={styles.metaValue} title={result.path}>
                  {result.path}
                </Paragraph>
              </div>
            )}
            {!!commandResult && (
              <div className={styles.metaItem}>
                <Paragraph spacing="none" className={styles.metaLabel}>
                  {t('systemToolInstall.installResult')}
                </Paragraph>
                <Paragraph spacing="none" className={styles.metaValue}>
                  {t('systemToolInstall.installResultSummary', {
                    exitCode: commandResult.exitCode ?? '-',
                    durationMs: commandResult.durationMs,
                  })}
                </Paragraph>
              </div>
            )}
          </div>

          {!!status.summary && (
            <Stack className={styles.section} gap="xs">
              <Paragraph spacing="none" className={styles.sectionLabel}>
                {t('systemToolInstall.result')}
              </Paragraph>
              <pre className={styles.code}>{status.summary}</pre>
            </Stack>
          )}

          {!!commandResult?.stdout && (
            <Stack className={styles.section} gap="xs">
              <Paragraph spacing="none" className={styles.sectionLabel}>
                stdout
              </Paragraph>
              <pre className={styles.code}>
                {truncateLocalizedCommandOutput(commandResult.stdout, locale)}
              </pre>
            </Stack>
          )}

          {!!commandResult?.stderr && (
            <Stack className={styles.section} gap="xs">
              <Paragraph spacing="none" className={cx('sectionLabel', 'errorLabel')}>
                stderr
              </Paragraph>
              <pre className={cx('code', 'errorCode')}>
                {truncateLocalizedCommandOutput(commandResult.stderr, locale)}
              </pre>
            </Stack>
          )}

          {!!block.error && (
            <Stack className={styles.section} gap="xs">
              <Paragraph spacing="none" className={cx('sectionLabel', 'errorLabel')}>
                {t('systemToolInstall.error')}
              </Paragraph>
              <pre className={cx('code', 'errorCode')}>
                {truncateLocalizedCommandOutput(block.error, locale, 2400)}
              </pre>
            </Stack>
          )}

          {!!commandResult && !commandResult.stdout && !commandResult.stderr && (
            <Stack className={styles.section} gap="xs">
              <Paragraph spacing="none" className={styles.sectionLabel}>
                {t('systemToolInstall.commandDetails')}
              </Paragraph>
              <pre className={styles.code}>
                {truncateLocalizedCommandOutput(formatUnknownPayload(commandResult), locale, 2400)}
              </pre>
            </Stack>
          )}
        </Stack>
      </ToolDisclosureCard>
    )
  }
)

SystemToolInstallToolRender.displayName = 'SystemToolInstallToolRender'

export { SystemToolInstallToolRender }
