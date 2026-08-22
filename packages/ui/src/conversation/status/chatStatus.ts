import type { ConversationMessageKey } from '../i18n/ConversationLocalizationProvider'
import {
  type ConversationTranslator,
  conversationTranslatorRuntime,
} from '../i18n/conversationTranslator'

import type { AppLocale, TeamExecutionPhase } from '#contracts'
import { isBlank, isEmpty, isPresent, optionalWhenLazy, truncate } from '#internal/runtime'

export type ChatStatusTone = 'idle' | 'running' | 'success' | 'warning' | 'error'

/** 会话运行状态（渲染侧契约，与 desktop `ChatRunStatus` 结构一致）。 */
export type ChatRunStatus =
  | 'idle'
  | 'running'
  | 'completed'
  | 'aborted'
  | 'failed'
  | 'awaiting-confirmation'
  | 'awaiting-input'

/**
 * 会话状态渲染所需的运行态窄投影（§8：按域投影非整桶透传）。
 * desktop 的 `ChatRuntimeState` 是结构超集，直接满足本契约。
 */
export interface ChatStatusRuntime {
  status: ChatRunStatus
  teamPhase: Nullable<TeamExecutionPhase>
  activeTurn: Nullable<number>
  completedTurns: number
  lastError: Nullable<string>
  connectionRetryAttempt: Nullable<number>
  connectionRetryMaxAttempts: Nullable<number>
  lastRunStartedAt: Nullable<number>
  awaitingConfirmationMessage: Nullable<string>
  awaitingInputQuestion: Nullable<string>
}

export interface ChatStatusMeta {
  label: string
  detail?: string
  tone: ChatStatusTone
}

export interface ChatNoticeMeta {
  title: string
  description: string
  tone: Exclude<ChatStatusTone, 'idle' | 'success'>
}

export interface ChatInlineNoticeMeta {
  text: string
  tone: Exclude<ChatStatusTone, 'idle' | 'success'>
}

export interface ChatInlineNoticeRuntimeSource {
  runtime: ChatStatusRuntime
  liveTraceSummary?: string
}

interface ChatInlineNoticeOptions {
  liveTraceSummary?: string
  now?: number
}

type ConversationTranslate = ConversationTranslator['translate']

const STATUS_LABEL_KEYS: Record<ChatRunStatus, ConversationMessageKey> = {
  idle: 'status.idle',
  running: 'status.running',
  completed: 'status.completed',
  aborted: 'status.aborted',
  failed: 'status.failed',
  'awaiting-confirmation': 'status.awaitingConfirmation',
  'awaiting-input': 'status.awaitingInput',
}

const STATUS_TONES: Record<ChatRunStatus, ChatStatusTone> = {
  idle: 'idle',
  running: 'running',
  completed: 'success',
  aborted: 'warning',
  failed: 'error',
  'awaiting-confirmation': 'warning',
  'awaiting-input': 'warning',
}

const TEAM_PHASE_LABEL_KEYS: Record<TeamExecutionPhase, ConversationMessageKey> = {
  'creating-task': 'status.phaseCreatingTask',
  'collecting-context': 'status.phaseCollectingContext',
  'preparing-tools': 'status.phasePreparingTools',
  'building-prompt': 'status.phaseBuildingPrompt',
  'requesting-model': 'status.phaseRequestingModel',
  preparing: 'status.phasePreparing',
  understanding: 'status.phaseUnderstanding',
  planning: 'status.phasePlanning',
  researching: 'status.phaseResearching',
  executing: 'status.phaseExecuting',
  'executing-tool': 'status.phaseExecutingTool',
  'waiting-user-browser': 'status.phaseWaitingUserBrowser',
  'capturing-browser-screenshot': 'status.phaseCapturingBrowserScreenshot',
  verifying: 'status.phaseVerifying',
  synthesizing: 'status.phaseSynthesizing',
  'waiting-confirmation': 'status.phaseWaitingConfirmation',
  completed: 'status.phaseCompleted',
}

function getInlineTeamPhaseLabelKey(phase: TeamExecutionPhase): ConversationMessageKey {
  // 思考前不再折叠成宽泛的「准备中」：三个真实阶段（任务创建中 / 上下文整理中 / 请求中）
  // 由 TEAM_PHASE_LABEL_KEYS 直接给出（preparing-tools / building-prompt 等已并入上下文整理中）。
  return TEAM_PHASE_LABEL_KEYS[phase]
}

function getReconnectingLabel(
  runtime: ChatStatusRuntime,
  locale: AppLocale,
  conversationTranslate: ConversationTranslate
): string {
  const attempt = runtime.connectionRetryAttempt ?? 1

  if (isPresent(runtime.connectionRetryMaxAttempts))
    return conversationTranslate(locale, 'status.reconnecting', {
      attempt,
      count: runtime.connectionRetryMaxAttempts,
    })

  return conversationTranslate(locale, 'status.reconnectingIndefinite', { attempt })
}

export function getChatStatusMeta(
  runtime: ChatStatusRuntime,
  locale: AppLocale,
  translatorRuntime: ConversationTranslator = conversationTranslatorRuntime
): ChatStatusMeta {
  const conversationTranslate = translatorRuntime.translate
  const detail = getChatStatusDetail(runtime, locale, conversationTranslate)
  return {
    label: conversationTranslate(locale, STATUS_LABEL_KEYS[runtime.status]),
    detail,
    tone: STATUS_TONES[runtime.status],
  }
}

function getChatStatusDetail(
  runtime: ChatStatusRuntime,
  locale: AppLocale,
  conversationTranslate: ConversationTranslate
): string | undefined {
  if (runtime.status === 'running' && isPresent(runtime.connectionRetryAttempt))
    return getReconnectingLabel(runtime, locale, conversationTranslate)

  if (runtime.teamPhase)
    return conversationTranslate(locale, TEAM_PHASE_LABEL_KEYS[runtime.teamPhase])

  switch (runtime.status) {
    case 'running':
      return optionalWhenLazy(isPresent(runtime.activeTurn), () =>
        conversationTranslate(locale, 'status.turn', { count: runtime.activeTurn! })
      )
    case 'completed':
      return optionalWhenLazy(runtime.completedTurns, () =>
        conversationTranslate(locale, 'status.totalTurns', { count: runtime.completedTurns })
      )
    case 'aborted':
      return conversationTranslate(locale, 'status.stoppedRun')
    case 'awaiting-confirmation':
      return isPresent(runtime.awaitingConfirmationMessage)
        ? truncate(runtime.awaitingConfirmationMessage, 120)
        : conversationTranslate(locale, 'status.awaitingConfirmationDescription')
    case 'awaiting-input':
      return isPresent(runtime.awaitingInputQuestion)
        ? truncate(runtime.awaitingInputQuestion, 120)
        : conversationTranslate(locale, 'status.awaitingInputDescription')
    case 'failed':
      return isPresent(runtime.lastError)
        ? truncate(runtime.lastError, 120)
        : conversationTranslate(locale, 'status.seeErrorInContent')
    default:
      return undefined
  }
}

export function getChatNoticeMeta(
  runtime: ChatStatusRuntime,
  locale: AppLocale,
  translatorRuntime: ConversationTranslator = conversationTranslatorRuntime
): Nullable<ChatNoticeMeta> {
  const conversationTranslate = translatorRuntime.translate
  if (runtime.status === 'running' && isPresent(runtime.connectionRetryAttempt))
    return {
      title: conversationTranslate(locale, 'status.reconnectingTitle'),
      description: isPresent(runtime.connectionRetryMaxAttempts)
        ? conversationTranslate(locale, 'status.reconnectingDescription', {
            attempt: runtime.connectionRetryAttempt,
            count: runtime.connectionRetryMaxAttempts,
          })
        : conversationTranslate(locale, 'status.reconnectingDescriptionIndefinite', {
            attempt: runtime.connectionRetryAttempt,
          }),
      tone: 'running',
    }

  switch (runtime.status) {
    case 'failed':
      return {
        title: conversationTranslate(locale, 'status.failedTitle'),
        description: runtime.lastError ?? conversationTranslate(locale, 'status.failedDescription'),
        tone: 'error',
      }
    case 'aborted':
      return {
        title: conversationTranslate(locale, 'status.runAbortedTitle'),
        description:
          runtime.lastError ?? conversationTranslate(locale, 'status.runAbortedDescription'),
        tone: 'warning',
      }
    case 'awaiting-input':
      return {
        title: conversationTranslate(locale, 'status.awaitingInputTitle'),
        description:
          runtime.awaitingInputQuestion ??
          conversationTranslate(locale, 'status.awaitingInputDescription'),
        tone: 'warning',
      }
    case 'awaiting-confirmation':
      return {
        title: conversationTranslate(locale, 'status.awaitingConfirmationTitle'),
        description:
          runtime.awaitingConfirmationMessage ??
          conversationTranslate(locale, 'status.awaitingConfirmationDescription'),
        tone: 'warning',
      }
    default:
      return null
  }
}

function buildInlineNoticeText(title: string, detail: Optional<string>): string {
  const parts: string[] = []
  if (!isBlank(title)) parts.push(title)

  const detailText = detail?.trim()
  if (detailText && !isBlank(detailText)) parts.push(detailText)

  return truncate(parts.join(' · '), 140)
}

function formatRunningElapsedShort(
  startedAt: number,
  now: number,
  locale: AppLocale,
  conversationTranslate: ConversationTranslate
): string {
  const elapsedSeconds = Math.max(1, Math.floor((now - startedAt) / 1000))

  if (elapsedSeconds < 60)
    return conversationTranslate(locale, 'status.elapsedSeconds', { seconds: elapsedSeconds })

  const elapsedMinutes = Math.floor(elapsedSeconds / 60)
  const remainingSeconds = elapsedSeconds % 60
  if (elapsedMinutes < 60)
    return conversationTranslate(locale, 'status.elapsedMinutesSeconds', {
      minutes: elapsedMinutes,
      seconds: remainingSeconds,
    })

  const elapsedHours = Math.floor(elapsedMinutes / 60)
  const remainingMinutes = elapsedMinutes % 60
  return conversationTranslate(locale, 'status.elapsedHoursMinutes', {
    hours: elapsedHours,
    minutes: remainingMinutes,
  })
}

function buildRunningInlineNoticeText(
  runtime: ChatStatusRuntime,
  locale: AppLocale,
  options: Optional<ChatInlineNoticeOptions>,
  conversationTranslate: ConversationTranslate
): string {
  const liveSummary = options?.liveTraceSummary?.trim() || null
  const parts: string[] = []
  const appendPart = (value: LooseOptional<string>): void => {
    if (!value || isBlank(value) || parts.includes(value)) return

    parts.push(value)
  }

  appendPart(liveSummary)
  appendPart(
    !liveSummary && runtime.teamPhase
      ? conversationTranslate(locale, getInlineTeamPhaseLabelKey(runtime.teamPhase))
      : null
  )
  appendPart(
    !liveSummary && runtime.activeTurn
      ? conversationTranslate(locale, 'status.turn', { count: runtime.activeTurn })
      : null
  )
  appendPart(
    runtime.lastRunStartedAt
      ? formatRunningElapsedShort(
          runtime.lastRunStartedAt,
          options?.now ?? Date.now(),
          locale,
          conversationTranslate
        )
      : null
  )

  return truncate(
    !isEmpty(parts) ? parts.join(' · ') : conversationTranslate(locale, 'status.running'),
    140
  )
}

export function getChatInlineNoticeMeta(
  runtime: ChatStatusRuntime,
  locale: AppLocale,
  options?: ChatInlineNoticeOptions,
  translatorRuntime: ConversationTranslator = conversationTranslatorRuntime
): Nullable<ChatInlineNoticeMeta> {
  const conversationTranslate = translatorRuntime.translate
  if (runtime.status === 'running' && isPresent(runtime.connectionRetryAttempt))
    return {
      tone: 'running',
      text: getReconnectingLabel(runtime, locale, conversationTranslate),
    }

  if (runtime.status === 'running')
    return {
      tone: 'running',
      text: buildRunningInlineNoticeText(runtime, locale, options, conversationTranslate),
    }

  switch (runtime.status) {
    case 'failed':
      return {
        tone: 'error',
        text: buildInlineNoticeText(
          conversationTranslate(locale, 'status.failedTitle'),
          runtime.lastError ?? conversationTranslate(locale, 'status.failedDescription')
        ),
      }
    case 'aborted':
      return {
        tone: 'warning',
        text:
          runtime.lastError?.trim() ||
          conversationTranslate(locale, 'status.runAbortedDescription'),
      }
    case 'awaiting-input':
      return {
        tone: 'warning',
        text: buildInlineNoticeText(
          conversationTranslate(locale, 'status.awaitingInputTitle'),
          runtime.awaitingInputQuestion ??
            conversationTranslate(locale, 'status.awaitingInputDescription')
        ),
      }
    case 'awaiting-confirmation':
      return {
        tone: 'warning',
        text: buildInlineNoticeText(
          conversationTranslate(locale, 'status.awaitingConfirmationTitle'),
          runtime.awaitingConfirmationMessage ??
            conversationTranslate(locale, 'status.awaitingConfirmationDescription')
        ),
      }
    default:
      return null
  }
}
