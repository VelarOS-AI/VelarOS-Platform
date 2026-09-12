import React, { memo, useCallback, useEffect, useState } from 'react'
import { SpinnerGapIcon, StopIcon, TerminalWindowIcon } from '@phosphor-icons/react'

import { StyleUtils } from '@velaros-ai/ui'
import { Paragraph } from '@velaros-ai/ui/primitives/display/Paragraph'
import { Text } from '@velaros-ai/ui/primitives/display/Text'
import { Stack } from '@velaros-ai/ui/primitives/layout/Stack'
import { CopyButton } from '@velaros-ai/ui/product/buttons/CopyButton'
import { CompactToolRow } from '@velaros-ai/ui/product/layout/CompactToolRow'
import { ToolDisclosureCard } from '@velaros-ai/ui/product/layout/ToolDisclosureCard'

import { useConversationI18n, useConversationTranslatorRuntime } from '../../i18n'
import { useChatToolRenderCapabilities } from '../chatToolRenderCapabilitiesContext'
import { ToolCallHoverDetails } from '../ToolCallHoverDetails'
import { getToolStatusLabel } from '../toolCallSummary'
import { truncateLocalizedCommandOutput } from '../toolDisplay'

import {
  getStatusIcon,
  getStatusLabel,
  getStatusTone,
  inferCommandPurpose,
  normalizeArgs,
  summarizeOutput,
} from './commandToolRender.shared'
import { CommandToolRenderDetails } from './CommandToolRenderDetails'

import styles from './CommandToolRender.module.css'

import type { ProjectCommandResult,ToolCallBlock } from '#contracts'
import { AppError } from '#internal/result'
import { Result } from '#internal/result'
import { isBoolean, isNonBlankString, isNumber, isPresent, isString, optionalWhen,toNullable, toOptional } from '#internal/runtime'
import { isRecord } from '#internal/unknownJsonRecord'

const cx = StyleUtils.bindCx(styles)

function isProjectCommandResult(value: unknown): value is ProjectCommandResult {
  if (!isRecord(value)) return false

  return (
    isString(value.command) &&
    isString(value.cwd) &&
    (isNumber(value.exitCode) || !isPresent(value.exitCode)) &&
    (isString(value.signal) || !isPresent(value.signal)) &&
    isString(value.stdout) &&
    isString(value.stderr) &&
    isNumber(value.durationMs) &&
    isBoolean(value.timedOut) &&
    isBoolean(value.truncated) &&
    isBoolean(value.success) &&
    isRecord(value.verification)
  )
}

const CommandToolRender = memo(
  ({
    block,
    compact = false,
    sessionId,
    formatPathForDisplay,
  }: {
    block: ToolCallBlock
    compact?: boolean
    sessionId?: string
    formatPathForDisplay?: (path: string) => string
  }): React.ReactElement => {
    const { locale, t } = useConversationI18n()
    const translatorRuntime = useConversationTranslatorRuntime()
    const capabilities = useChatToolRenderCapabilities()
    const [isTerminatingBackgroundTask, setIsTerminatingBackgroundTask] = useState(false)
    const [backgroundTaskTerminated, setBackgroundTaskTerminated] = useState(false)
    const args = normalizeArgs(block.args)
    const result: Nullable<ProjectCommandResult> = isProjectCommandResult(block.result)
      ? block.result
      : null
    const command = result?.command ?? args.command ?? ''
    const cwd = toNullable(result?.cwd ?? args.cwd)
    const tone = getStatusTone(block, result)
    const purpose = inferCommandPurpose(
      command,
      locale,
      result?.verification,
      toNullable(result?.backgroundProcess),
      translatorRuntime
    )
    const outputSummary = summarizeOutput(result, locale, translatorRuntime)
    const summary = block.error ?? outputSummary
    const statusLabel = getToolStatusLabel(block, locale, translatorRuntime)
    // 悬停详情里失败的命令要说清退出码；成功、超时、后台启动沿用输出摘要。
    const failedExit =
      result && !result.success && !result.timedOut && !result.backgroundProcess && isNumber(result.exitCode)
        ? { exitCode: result.exitCode, duration: result.durationMs }
        : null
    const hoverSummary = failedExit
      ? t('commandTool.exitCodeDuration', failedExit)
      : toOptional(outputSummary)
    const stdout = result?.stdout
      ? truncateLocalizedCommandOutput(result.stdout, locale, undefined, translatorRuntime)
      : ''
    const stderr = result?.stderr
      ? truncateLocalizedCommandOutput(result.stderr, locale, undefined, translatorRuntime)
      : ''
    const backgroundProcess = (toNullable(result?.backgroundProcess))
    const backgroundTaskId = toNullable(backgroundProcess?.taskId)
    const displayCommand = command && formatPathForDisplay ? formatPathForDisplay(command) : command
    const displayCwd = cwd && formatPathForDisplay ? formatPathForDisplay(cwd) : cwd
    // 只有模型显式指定了 cwd 才在悬停详情里点名目录；缺省就是项目根，不必重复。
    const explicitCwd = args.cwd && formatPathForDisplay ? formatPathForDisplay(args.cwd) : args.cwd
    const hoverDetail = [
      displayCommand,
      explicitCwd ? `${t('commandTool.metaDirectory')} ${explicitCwd}` : null,
    ].filter((line): line is string => isNonBlankString(line))
    const displayBackgroundProcess =
      backgroundProcess && formatPathForDisplay
        ? {
            ...backgroundProcess,
            logPath: backgroundProcess.logPath
              ? formatPathForDisplay(backgroundProcess.logPath)
              : backgroundProcess.logPath,
          }
        : backgroundProcess
    const terminateBackgroundTask = capabilities.terminateBackgroundTask
    const canTerminateBackgroundTask = !!(
      sessionId &&
      backgroundProcess?.taskId &&
      terminateBackgroundTask
    )
    const handleTerminateBackgroundTask = useCallback(async (): Promise<void> => {
      if (!sessionId || !backgroundProcess?.taskId || !terminateBackgroundTask) return

      setIsTerminatingBackgroundTask(true)

      try {
        const termination = Result.unwrap(
          await terminateBackgroundTask(sessionId, backgroundProcess.taskId)
        )
        setBackgroundTaskTerminated(true)
        capabilities.showNotice?.({
          title: t('commandTool.terminateBackgroundSuccess'),
          description: termination.message,
          tone: 'success',
        })
      } catch (error) {
        const appError = AppError.from(error)
        capabilities.showNotice?.({
          title: t('commandTool.terminateBackgroundErrorTitle'),
          description:
            appError.message.trim() ||
            t('commandTool.terminateBackgroundErrorFallback'),
          tone: 'error',
        })
      } finally {
        setIsTerminatingBackgroundTask(false)
      }
    }, [
      backgroundProcess?.taskId,
      capabilities,
      sessionId,
      t,
      terminateBackgroundTask,
    ])
    const compactLine = [purpose.trim().replace(/[。.]$/, ''), displayCommand, summary]
      .filter((value): value is string => isNonBlankString(value))
      .join(' · ')
    const terminateBackgroundButtonLabel = backgroundTaskTerminated
      ? t('commandTool.terminateBackgroundDone')
      : isTerminatingBackgroundTask
        ? t('commandTool.terminateBackgroundPending')
        : t('commandTool.terminateBackground')
    const cardMeta = (
      <span className={styles.cardHeaderMeta}>
        {canTerminateBackgroundTask && (
          <button
            type="button"
            className={styles.headerTerminateButton}
            disabled={isTerminatingBackgroundTask || backgroundTaskTerminated}
            aria-label={terminateBackgroundButtonLabel}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              void handleTerminateBackgroundTask()
            }}
          >
            {isTerminatingBackgroundTask ? (
              <SpinnerGapIcon size={13} className={styles.spinIcon} />
            ) : (
              <StopIcon size={13} />
            )}
            <span>{terminateBackgroundButtonLabel}</span>
          </button>
        )}
        <Text className={cx('statusBadge', tone)}>
          {getStatusLabel(block, result, locale, translatorRuntime)}
        </Text>
      </span>
    )

    useEffect(() => {
      setBackgroundTaskTerminated(false)
    }, [backgroundTaskId])

    if (compact) return (
        <CompactToolRow
          tone={tone}
          icon={<TerminalWindowIcon size={12} />}
          label={block.toolName}
          detail={compactLine}
          detailTitle={compactLine}
          count={statusLabel}
          hoverContent={
            <ToolCallHoverDetails
              blocks={[block]}
              formatPathForDisplay={formatPathForDisplay}
              detail={hoverDetail}
              summary={hoverSummary}
            />
          }
          actionLayout="overlay"
          action={
            optionalWhen(command, ((
              <CopyButton
                value={command}
                label={t('chat.commandCopy')}
                copiedLabel={t('chat.codeBlockCopied')}
              />
            )))
          }
        />
      )

    return (
      <ToolDisclosureCard
        statusTone={tone}
        defaultOpen={false}
        statusIcon={getStatusIcon(block, result)}
        leadingIcon={<TerminalWindowIcon size={12} className={styles.terminalIcon} />}
        title={block.toolName}
        meta={cardMeta}
        subtitle={
          <Stack gap="xs">
            <Paragraph spacing="none" className={styles.purpose}>
              {purpose}
            </Paragraph>
            {!!displayCommand && <code className={styles.commandLine}>{displayCommand}</code>}
          </Stack>
        }
      >
        <CommandToolRenderDetails
          block={block}
          cwd={displayCwd}
          result={result}
          backgroundProcess={displayBackgroundProcess}
          stdout={stdout}
          stderr={stderr}
          locale={locale}
          onTerminateBackgroundTask={optionalWhen(canTerminateBackgroundTask, handleTerminateBackgroundTask)}
          isTerminatingBackgroundTask={isTerminatingBackgroundTask}
          backgroundTaskTerminated={backgroundTaskTerminated}
        />
      </ToolDisclosureCard>
    )
  }
)

CommandToolRender.displayName = 'CommandToolRender'

export { CommandToolRender }
