import { CheckCircleIcon, ClockCountdownIcon, WarningCircleIcon } from '@phosphor-icons/react'
import type { ReactElement } from 'react'

import {
  type ConversationTranslator,
  conversationTranslatorRuntime,
} from '../../i18n'

import styles from './CommandToolRender.module.css'

import type {
  AppLocale,
  ProjectBackgroundProcessInfo,
  ProjectCommandResult,
  ProjectVerificationSummary,
  ToolCallBlock,
} from '#contracts'
import { isEmpty,isPlainObject, isString, isTrue, numberOrNull, optionalWhen, toOptional } from '#internal/runtime'

export interface CommandToolArgs {
  command?: string
  cwd?: string
  timeoutMs?: number
  background?: boolean
}

export function normalizeArgs(value: any): CommandToolArgs {
  if (!isPlainObject(value)) return {}

  const record = value
  return {
    command: optionalWhen(isString, record.command),
    cwd: optionalWhen(isString, record.cwd),
    timeoutMs: toOptional(numberOrNull(record.timeoutMs)),
    background: isTrue(record.background),
  }
}

export function getStatusLabel(
  block: ToolCallBlock,
  result: Nullable<ProjectCommandResult>,
  locale: AppLocale,
  runtime: ConversationTranslator = conversationTranslatorRuntime
): string {
  if (block.isRunning) return runtime.translate(locale, 'commandTool.statusRunning')

  if (block.error) return runtime.translate(locale, 'commandTool.statusFailed')

  if (result?.backgroundProcess) return runtime.translate(locale, 'commandTool.statusBackground')

  if (result?.timedOut) return runtime.translate(locale, 'commandTool.statusTimedOut')

  return runtime.translate(locale, 'commandTool.statusCompleted')
}

export function getStatusTone(
  block: ToolCallBlock,
  result: Nullable<ProjectCommandResult>
): 'running' | 'success' | 'error' | 'warning' {
  if (block.isRunning) return 'running'

  if (block.error) return 'error'

  if (result?.timedOut) return 'warning'

  return 'success'
}

export function getStatusIcon(
  block: ToolCallBlock,
  result: Nullable<ProjectCommandResult>
): ReactElement {
  if (block.isRunning) return <span className={styles.runningStatusDot} aria-hidden="true" />

  if (block.error) return <WarningCircleIcon size={13} weight="fill" />

  if (result?.timedOut) return <ClockCountdownIcon size={13} weight="fill" />

  return <CheckCircleIcon size={13} weight="fill" />
}

export function inferCommandPurpose(
  command: string,
  locale: AppLocale,
  verification?: LooseOptional<ProjectVerificationSummary>,
  backgroundProcess?: LooseOptional<ProjectBackgroundProcessInfo>,
  runtime: ConversationTranslator = conversationTranslatorRuntime
): string {
  if (backgroundProcess?.reason) return backgroundProcess.reason

  switch (verification?.kind) {
    case 'typecheck':
      return runtime.translate(locale, 'commandTool.purposeTypecheck')
    case 'lint':
      return runtime.translate(locale, 'commandTool.purposeLint')
    case 'test':
      return runtime.translate(locale, 'commandTool.purposeTest')
    case 'build':
      return runtime.translate(locale, 'commandTool.purposeBuild')
  }

  const tokens = command
    .trim()
    .split(/\s+/)
    .filter((value) => !!value)
  const first = tokens[0]?.toLowerCase() ?? ''
  const second = tokens[1]?.toLowerCase() ?? ''
  const third = tokens[2]?.toLowerCase() ?? ''

  if (first === 'git') {
    switch (second) {
      case 'status':
        return runtime.translate(locale, 'commandTool.purposeGitStatus')
      case 'diff':
        return runtime.translate(locale, 'commandTool.purposeGitDiff')
      case 'add':
        return runtime.translate(locale, 'commandTool.purposeGitAdd')
      case 'commit':
        return runtime.translate(locale, 'commandTool.purposeGitCommit')
      case 'checkout':
      case 'switch':
        return runtime.translate(locale, 'commandTool.purposeGitSwitch')
      default:
        return runtime.translate(locale, 'commandTool.purposeGitGeneric')
    }
  }

  if (first === 'npm' || first === 'pnpm' || first === 'yarn' || first === 'bun') {
    const scriptName = second === 'run' ? third : second

    switch (scriptName) {
      case 'install':
      case 'i':
      case 'add':
        return runtime.translate(locale, 'commandTool.purposeInstallDeps')
      case 'dev':
        return runtime.translate(locale, 'commandTool.purposeStartDev')
      case 'start':
      case 'serve':
      case 'preview':
        return runtime.translate(locale, 'commandTool.purposeStartLocal')
      case 'build':
        return runtime.translate(locale, 'commandTool.purposeBuild')
      case 'test':
        return runtime.translate(locale, 'commandTool.purposeTest')
      case 'lint':
        return runtime.translate(locale, 'commandTool.purposeLintGeneric')
      case 'typecheck':
        return runtime.translate(locale, 'commandTool.purposeTypecheckGeneric')
    }
  }

  if (first === 'python' || first === 'python3' || first === 'uv')
    return runtime.translate(locale, 'commandTool.purposePython')

  if (first === 'rg' || first === 'find' || first === 'ls' || first === 'cat' || first === 'sed')
    return runtime.translate(locale, 'commandTool.purposeInspectFiles')

  return runtime.translate(locale, 'commandTool.purposeShell')
}

export function summarizeOutput(
  result: Nullable<ProjectCommandResult>,
  locale: AppLocale,
  runtime: ConversationTranslator = conversationTranslatorRuntime
): Nullable<string> {
  if (!result) return null

  if (result.backgroundProcess) {
    const portDetail = !isEmpty(result.backgroundProcess.ports)
      ? ` ${runtime.translate(locale, 'commandTool.backgroundPorts', {
          ports: result.backgroundProcess.ports.join(', '),
        })}`
      : ''
    return `${runtime.translate(locale, 'commandTool.backgroundStarted')}${portDetail}`.trim()
  }

  if (result.timedOut) return runtime.translate(locale, 'commandTool.timedOut')

  if (result.success) return runtime.translate(locale, 'commandTool.finished')

  return null
}
