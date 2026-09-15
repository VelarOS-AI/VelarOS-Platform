/**
 * 控制台卡片：交互式命令（system:run 的 interactive）在聊天里的样子。
 * 输出流自动跟到底，输入框回车发送、Ctrl+C 发中断，右上角可以终止任务；
 * 宿主没注入控制台能力时自动降级成只读，只显示已经读到的输出。
 */
import React, { memo, useCallback, useEffect, useRef, useState } from 'react'
import { SpinnerGapIcon, StopIcon, TerminalWindowIcon } from '@phosphor-icons/react'

import { StyleUtils } from '@velaros-ai/ui'
import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { Paragraph } from '@velaros-ai/ui/primitives/display/Paragraph'
import { Text } from '@velaros-ai/ui/primitives/display/Text'
import { Input } from '@velaros-ai/ui/primitives/forms/Input'
import { Stack } from '@velaros-ai/ui/primitives/layout/Stack'
import { CompactToolRow } from '@velaros-ai/ui/product/layout/CompactToolRow'
import { ToolDisclosureCard } from '@velaros-ai/ui/product/layout/ToolDisclosureCard'

import type { ConversationMessageKey } from '../../i18n'
import { useConversationI18n } from '../../i18n'
import { useTimerScope } from '../../react-hooks/useTimerScope'
import { useChatToolRenderCapabilities } from '../chatToolRenderCapabilitiesContext'

import type { ConsoleRenderStatus } from './consoleToolRenderModel'
import {
  appendConsoleChunk,
  interruptConsoleSession,
  readConsoleOutputSince,
  resolveConsoleKeyAction,
  resolveConsoleStatus,
  resolveConsoleView,
  shouldEchoLocally,
  submitConsoleInput,
} from './consoleToolRenderModel'

import styles from './ConsoleToolRender.module.css'

import type { ToolCallBlock } from '#contracts'
import { AppError, Result } from '#internal/result'
import { isNonBlankString, toNullable } from '#internal/runtime'

const cx = StyleUtils.bindCx(styles)

/** 隔多久去宿主那里取一次新输出。 */
const ConsolePollIntervalMs = 500

/** 三种状态各用哪句文案。 */
const ConsoleStatusMessageKeys = {
  'awaiting-input': 'consoleTool.statusAwaitingInput',
  running: 'consoleTool.statusRunning',
  ended: 'consoleTool.statusEnded',
} as const satisfies Record<ConsoleRenderStatus, ConversationMessageKey>

/** 三种状态各用哪个徽章样式；样式名不带连字符，免得受 CSS Modules 的命名转换影响。 */
const ConsoleStatusBadgeClasses = {
  'awaiting-input': 'statusAwaitingInput',
  running: 'statusRunning',
  ended: 'statusEnded',
} as const satisfies Record<ConsoleRenderStatus, string>

const ConsoleToolRender = memo(
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
    const { t } = useConversationI18n()
    const capabilities = useChatToolRenderCapabilities()
    const timers = useTimerScope('ConsoleToolRender')
    const view = resolveConsoleView(block)
    const taskId = view?.session.taskId ?? ''
    const [output, setOutput] = useState('')
    const [acceptsInput, setAcceptsInput] = useState(!!view?.session.acceptsInput)
    const [draft, setDraft] = useState('')
    const [isSending, setIsSending] = useState(false)
    const [isTerminating, setIsTerminating] = useState(false)
    const cursorRef = useRef(0)
    const outputRef = useRef<Nullable<HTMLPreElement>>(null)
    const canRead = !!capabilities.readConsoleOutput && isNonBlankString(sessionId)
    const canWrite = !!capabilities.writeConsoleInput && isNonBlankString(sessionId)
    const canInterrupt = !!capabilities.interruptConsole && isNonBlankString(sessionId)
    const canTerminate = !!capabilities.terminateBackgroundTask && isNonBlankString(sessionId)
    const status = resolveConsoleStatus(acceptsInput, canWrite)
    const statusLabel = t(ConsoleStatusMessageKeys[status])
    const displayCommand = view && formatPathForDisplay ? formatPathForDisplay(view.command) : view?.command
    const displayCwd = view?.cwd && formatPathForDisplay ? formatPathForDisplay(view.cwd) : view?.cwd
    const droppedNotice = useCallback(
      (count: number) => t('consoleTool.droppedChars', { count }),
      [t]
    )
    const handleFailure = useCallback(
      (titleKey: ConversationMessageKey, failure: AppError) => {
        capabilities.showNotice?.({
          title: t(titleKey),
          description: failure.message.trim() || t('consoleTool.errorFallback'),
          tone: 'error',
        })
      },
      [capabilities, t]
    )

    // 输出是拉来的：挂载先取一次（翻回历史消息也看得到留下的输出），进程还开着才按节奏接着取。
    useEffect(() => {
      if (!taskId || !canRead) return undefined

      let disposed = false
      const pump = async (): Promise<void> => {
        try {
          const chunk = await readConsoleOutputSince(
            capabilities,
            toNullable(sessionId),
            taskId,
            cursorRef.current
          )
          if (!chunk || disposed) return
          cursorRef.current = chunk.cursor
          if (chunk.text || chunk.droppedChars > 0)
            setOutput((previous) => appendConsoleChunk(previous, chunk, droppedNotice))
          if (!chunk.acceptsInput) setAcceptsInput(false)
        } catch {
          // arch-guard:silent-catch-ok 读输出失败只是这一轮没拿到，下一轮再试；不拿它打扰用户。
        }
      }

      void pump()
      const lease = acceptsInput ? timers.every(ConsolePollIntervalMs, () => void pump()) : null
      return () => {
        disposed = true
        lease?.cancel()
      }
    }, [acceptsInput, canRead, capabilities, droppedNotice, sessionId, taskId, timers])

    // 新输出到了就跟到底，和真终端一样。
    useEffect(() => {
      const node = outputRef.current
      if (node) node.scrollTop = node.scrollHeight
    }, [output])

    const handleSubmit = useCallback(async (): Promise<void> => {
      if (!view || !canWrite || isSending) return

      const text = draft
      setIsSending(true)
      try {
        const written = await submitConsoleInput(capabilities, toNullable(sessionId), taskId, text)
        if (!written) return

        setDraft('')
        // 管道背后的进程不回显，卡片自己把这一行补进去，用户才看得到自己输入了什么。
        if (shouldEchoLocally(view.session)) setOutput((previous) => `${previous}${text}\n`)
        if (!written.accepted) {
          capabilities.showNotice?.({
            title: t('consoleTool.inputErrorTitle'),
            description: written.message,
            tone: 'warning',
          })
        }
      } catch (error) {
        handleFailure('consoleTool.inputErrorTitle', AppError.from(error))
      } finally {
        setIsSending(false)
      }
    }, [canWrite, capabilities, draft, isSending, handleFailure, sessionId, t, taskId, view])

    const handleInterrupt = useCallback(async (): Promise<void> => {
      if (!taskId || !canInterrupt) return

      try {
        const interrupted = await interruptConsoleSession(capabilities, toNullable(sessionId), taskId)
        if (!interrupted) return

        capabilities.showNotice?.({
          title: t('consoleTool.interruptSent'),
          description: interrupted.message,
          tone: interrupted.accepted ? 'info' : 'warning',
        })
      } catch (error) {
        handleFailure('consoleTool.interruptErrorTitle', AppError.from(error))
      }
    }, [canInterrupt, capabilities, handleFailure, sessionId, t, taskId])

    const handleTerminate = useCallback(async (): Promise<void> => {
      const terminate = capabilities.terminateBackgroundTask
      if (!terminate || !taskId || !sessionId || isTerminating) return

      setIsTerminating(true)
      try {
        Result.unwrap(await terminate(sessionId, taskId))
        setAcceptsInput(false)
      } catch (error) {
        handleFailure('commandTool.terminateBackgroundErrorTitle', AppError.from(error))
      } finally {
        setIsTerminating(false)
      }
    }, [capabilities, isTerminating, handleFailure, sessionId, taskId])

    const handleKeyDown = useCallback(
      (event: React.KeyboardEvent<HTMLInputElement>): void => {
        const action = resolveConsoleKeyAction(event)
        if (action === 'none') return

        event.preventDefault()
        if (action === 'submit') void handleSubmit()
        else void handleInterrupt()
      },
      [handleInterrupt, handleSubmit]
    )

    if (!view) return <Text className={styles.hint}>{t('consoleTool.outputEmpty')}</Text>

    if (compact)
      return (
        <CompactToolRow
          tone={status === 'ended' ? 'success' : 'running'}
          icon={<TerminalWindowIcon size={12} />}
          label={block.toolName}
          detail={displayCommand}
          detailTitle={displayCommand}
          count={statusLabel}
        />
      )

    return (
      <ToolDisclosureCard
        statusTone={status === 'ended' ? 'success' : 'running'}
        defaultOpen
        lazyContent={false}
        leadingIcon={<TerminalWindowIcon size={12} className={styles.terminalIcon} />}
        title={block.toolName}
        meta={
          <span className={styles.headerMeta}>
            {canTerminate && status !== 'ended' && (
              <button
                type="button"
                className={styles.headerTerminateButton}
                disabled={isTerminating}
                aria-label={t('commandTool.terminateBackground')}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  void handleTerminate()
                }}
              >
                {isTerminating ? <SpinnerGapIcon size={13} className={styles.spinIcon} /> : <StopIcon size={13} />}
                <span>
                  {isTerminating
                    ? t('commandTool.terminateBackgroundPending')
                    : t('commandTool.terminateBackground')}
                </span>
              </button>
            )}
            <Text className={cx('statusBadge', ConsoleStatusBadgeClasses[status])}>{statusLabel}</Text>
          </span>
        }
        subtitle={
          <Stack gap="xs">
            <Paragraph spacing="none" className={styles.purpose}>
              {t('consoleTool.purpose')}
            </Paragraph>
            {!!displayCommand && <code className={styles.commandLine}>{displayCommand}</code>}
          </Stack>
        }
      >
        <Stack className={styles.sections} gap="sm">
          {!!displayCwd && (
            <Paragraph spacing="none" className={styles.meta} title={displayCwd}>
              {`${t('commandTool.metaDirectory')} ${displayCwd}`}
            </Paragraph>
          )}

          <pre ref={outputRef} className={styles.output} aria-label={t('consoleTool.ariaOutput')}>
            {output || t('consoleTool.outputEmpty')}
          </pre>

          {canWrite ? (
            <div className={styles.inputRow}>
              <Input
                size="sm"
                value={draft}
                disabled={!acceptsInput || isSending}
                placeholder={t('consoleTool.inputPlaceholder')}
                aria-label={t('consoleTool.ariaInput')}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={handleKeyDown}
              />
              <Button
                variant="outline"
                size="sm"
                disabled={!acceptsInput || isSending}
                onClick={() => void handleSubmit()}
              >
                {t('consoleTool.send')}
              </Button>
              {canInterrupt && (
                <Button
                  variant="outline"
                  size="sm"
                  className={styles.interruptButton}
                  disabled={!acceptsInput}
                  onClick={() => void handleInterrupt()}
                >
                  {t('consoleTool.interrupt')}
                </Button>
              )}
            </div>
          ) : (
            <Paragraph spacing="none" className={styles.hint}>
              {t('consoleTool.readOnlyHint')}
            </Paragraph>
          )}
        </Stack>
      </ToolDisclosureCard>
    )
  }
)

ConsoleToolRender.displayName = 'ConsoleToolRender'

export { ConsoleToolRender }
