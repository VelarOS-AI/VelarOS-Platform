import { SpinnerGapIcon, StopIcon } from '@phosphor-icons/react'
import type { ReactElement } from 'react'

import { StyleUtils } from '@velaros-ai/ui'
import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { Paragraph } from '@velaros-ai/ui/primitives/display/Paragraph'
import { Stack } from '@velaros-ai/ui/primitives/layout/Stack'

import type { ConversationMessageKey } from '../../i18n'
import { useConversationTranslatorRuntime } from '../../i18n'
import { formatUnknownPayload, truncateLocalizedCommandOutput } from '../toolDisplay'

import { normalizeArgs } from './commandToolRender.shared'

import styles from './CommandToolRender.module.css'

import {
  type AppLocale,
  type ProjectBackgroundProcessInfo,
  type ProjectCommandResult,
  type ToolCallBlock,
} from '#contracts'
import { isBlank,isString } from '#internal/runtime'

const cx = StyleUtils.bindCx(styles)

interface CommandToolRenderDetailsProps {
  block: ToolCallBlock
  cwd: Nullable<string>
  result: Nullable<ProjectCommandResult>
  backgroundProcess: Nullable<ProjectBackgroundProcessInfo>
  stdout: string
  stderr: string
  locale: AppLocale
  onTerminateBackgroundTask?: () => void | Promise<void>
  isTerminatingBackgroundTask?: boolean
  backgroundTaskTerminated?: boolean
}

function resolveDisplayCommand(
  block: ToolCallBlock,
  result: Nullable<ProjectCommandResult>
): string {
  const resultCommand = result?.command
  if (isString(resultCommand) && !isBlank(resultCommand)) return resultCommand

  const argsCommand = normalizeArgs(block.args).command
  if (isString(argsCommand) && !isBlank(argsCommand)) return argsCommand

  return ''
}

export function CommandToolRenderDetails({
  block,
  cwd,
  result,
  backgroundProcess,
  stdout,
  stderr,
  locale,
  onTerminateBackgroundTask,
  isTerminatingBackgroundTask = false,
  backgroundTaskTerminated = false,
}: CommandToolRenderDetailsProps): ReactElement {
  const translatorRuntime = useConversationTranslatorRuntime()
  const t = (key: ConversationMessageKey, params?: Record<string, string | number>) =>
    translatorRuntime.translate(locale, key, params)
  const displayCommand = resolveDisplayCommand(block, result)

  return (
    <Stack className={styles.sections} gap="sm">
      <div className={styles.metaGrid}>
        {!!cwd && (
          <div className={styles.metaItem}>
            <Paragraph spacing="none" className={styles.metaLabel}>
              {t('commandTool.metaDirectory')}
            </Paragraph>
            <Paragraph spacing="none" className={styles.metaValue} title={cwd}>
              {cwd}
            </Paragraph>
          </div>
        )}
        {!!result && (
          <div className={styles.metaItem}>
            <Paragraph spacing="none" className={styles.metaLabel}>
              {t('commandTool.metaResult')}
            </Paragraph>
            <Paragraph spacing="none" className={styles.metaValue}>
              {t('commandTool.exitCodeDuration', {
                exitCode: result.exitCode ?? '—',
                duration: result.durationMs,
              })}
            </Paragraph>
          </div>
        )}
        {!!result?.verification && result.verification.kind !== 'unknown' && (
          <div className={styles.metaItem}>
            <Paragraph spacing="none" className={styles.metaLabel}>
              {t('commandTool.metaType')}
            </Paragraph>
            <Paragraph spacing="none" className={styles.metaValue}>
              {result.verification.kind}
            </Paragraph>
          </div>
        )}
      </div>

      {!!displayCommand && (
        <Stack className={styles.section} gap="xs">
          <Paragraph spacing="none" className={styles.sectionLabel}>
            {t('commandTool.sectionCommand')}
          </Paragraph>
          <pre className={styles.code}>{displayCommand}</pre>
        </Stack>
      )}

      {!!backgroundProcess && (
        <Stack className={styles.section} gap="xs">
          <Paragraph spacing="none" className={styles.sectionLabel}>
            {t('commandTool.sectionBackground')}
          </Paragraph>
          <div className={styles.backgroundInfoRow}>
            <pre className={cx('code', 'backgroundInfoCode')}>
              {truncateLocalizedCommandOutput(
                formatUnknownPayload({
                  taskId: backgroundProcess.taskId,
                  sessionId: backgroundProcess.sessionId,
                  pid: backgroundProcess.pid,
                  logPath: backgroundProcess.logPath,
                  ports: backgroundProcess.ports,
                  reason: backgroundProcess.reason,
                  terminateCommand: backgroundProcess.terminateCommand,
                  forceTerminateCommand: backgroundProcess.forceTerminateCommand,
                  fallbackTerminateCommand: backgroundProcess.fallbackTerminateCommand,
                }),
                locale,
                2400,
                translatorRuntime
              )}
            </pre>
            {!!onTerminateBackgroundTask && (
              <Button
                variant="outline"
                size="sm"
                className={styles.backgroundTerminateButton}
                disabled={isTerminatingBackgroundTask || backgroundTaskTerminated}
                onClick={() => void onTerminateBackgroundTask()}
              >
                {isTerminatingBackgroundTask ? (
                  <SpinnerGapIcon size={13} className={styles.spinIcon} />
                ) : (
                  <StopIcon size={13} />
                )}
                {backgroundTaskTerminated
                  ? t('commandTool.terminateBackgroundDone')
                  : isTerminatingBackgroundTask
                    ? t('commandTool.terminateBackgroundPending')
                    : t('commandTool.terminateBackground')}
              </Button>
            )}
          </div>
        </Stack>
      )}

      {!!block.progress?.trim() && (
        <Stack className={styles.section} gap="xs">
          <Paragraph spacing="none" className={styles.sectionLabel}>
            {t('commandTool.sectionProgress')}
          </Paragraph>
          <pre className={styles.code}>
            {truncateLocalizedCommandOutput(block.progress.trim(), locale, 2400, translatorRuntime)}
          </pre>
        </Stack>
      )}

      {!!stdout && (
        <Stack className={styles.section} gap="xs">
          <Paragraph spacing="none" className={styles.sectionLabel}>
            {t('commandTool.sectionStdout')}
          </Paragraph>
          <pre className={styles.code}>{stdout}</pre>
        </Stack>
      )}

      {!!stderr && (
        <Stack className={styles.section} gap="xs">
          <Paragraph spacing="none" className={cx('sectionLabel', 'errorLabel')}>
            {t('commandTool.sectionStderr')}
          </Paragraph>
          <pre className={cx('code', 'errorCode')}>{stderr}</pre>
        </Stack>
      )}

      {!!block.error && (
        <Stack className={styles.section} gap="xs">
          <Paragraph spacing="none" className={cx('sectionLabel', 'errorLabel')}>
            {t('commandTool.sectionError')}
          </Paragraph>
          <pre className={cx('code', 'errorCode')}>
            {truncateLocalizedCommandOutput(block.error, locale, 2400, translatorRuntime)}
          </pre>
        </Stack>
      )}
    </Stack>
  )
}
