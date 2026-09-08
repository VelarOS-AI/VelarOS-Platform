import type { ConversationMessageKey } from '../i18n'

import type {
  UserActionCard,
  UserActionCardAction,
  UserActionCardActionIcon,
  UserActionCardIcon,
  UserActionCardTone,
} from '#contracts'

/**
 * user-action 卡的**纯呈现层**——图标/语气/标签/完成键推断，零 localStorage / 零 timer / 零 IPC。
 *
 * 从原 desktop `userActionCardViewModel.pure`（呈现子集）+ `userActionCard.utils`（纯谓词子集）劈分入包，
 * 供包内 `UserActionCard`/`AskUserCarousel` 渲染件消费；有状态半壁（localStorage 消费标记 / 超时 / 表单
 * 校验 / hook 逻辑）留宿主，其纯谓词一律回引本文件（单源）。视图契约类型（FormDraftValue/UserActionEntry 等）
 * 住投影层 `../projection`。
 */

/** 渲染件用的翻译签名，与 conversation-ui 的 typed key seam 同形。 */
export type CardTranslate = (
  key: ConversationMessageKey,
  params?: Record<string, string | number>
) => string

export type ActionCardTone = 'neutral' | 'info' | 'success' | 'warning' | 'error'

/** 历史消息里已消费用户动作卡的展示策略（仅代码内切换，无设置项）。 */
export type ConsumedUserActionCardDisplayMode = 'hide' | 'disable'

/**
 * 已消费卡片：`'hide'` 不渲染；`'disable'` 保留灰显且不可操作。
 *
 * 取 `'disable'` 是为了**审批留痕**：确认/拒绝本身不产生任何消息，卡再自己隐掉，事后回看会话
 * 就只看得到 agent 装了个系统工具、跑了条破坏性命令，看不到当时问了什么、谁批的、填了什么理由。
 * 结算记录现在随存档落盘（`ConversationCardResolution`），灰显卡展示的就是那份事实。
 * 开发/调试时改此常量即可，勿接入 RendererPreferences。
 */
export const consumedUserActionCardDisplayMode: ConsumedUserActionCardDisplayMode = 'disable'

export type UserActionCardVisualIcon = UserActionCardIcon | 'input'

const PATH_HINT_PATTERN = /路径|path|workspace|工作区|项目|目录|folder|repository|repo|root/i

const CARD_ICON_CLASS: Record<UserActionCardVisualIcon, string> = {
  info: 'cardIconInfo',
  warning: 'cardIconWarning',
  success: 'cardIconSuccess',
  danger: 'cardIconDanger',
  plugin: 'cardIconPlugin',
  plan: 'cardIconPlan',
  target: 'cardIconTarget',
  tool: 'cardIconTool',
  workspace: 'cardIconWorkspace',
  memory: 'cardIconMemory',
  input: 'cardIconInput',
}

function primaryAction(card: Pick<UserActionCard, 'actions'>): UserActionCardAction | undefined {
  return card.actions[0]
}

function textHints(card: Pick<UserActionCard, 'title' | 'description'>): string {
  return `${card.title}\n${card.description}`
}

function looksLikePathRequest(card: Pick<UserActionCard, 'title' | 'description'>): boolean {
  return PATH_HINT_PATTERN.test(textHints(card))
}

export function cardHasRejectAction(
  entries: ReadonlyArray<{ action: UserActionCardAction }>
): boolean {
  return entries.some((entry) => entry.action.kind === 'reject')
}

export function shouldHideConsumedUserActionCard(consumed: boolean, timedOut = false): boolean {
  return consumed && !timedOut && consumedUserActionCardDisplayMode === 'hide'
}

export function shouldForceDisableConsumedUserActionCard(
  consumed: boolean,
  timedOut = false
): boolean {
  return timedOut || (consumed && consumedUserActionCardDisplayMode === 'disable')
}

/** 根据卡片语义与主操作推断左侧展示图标，避免模型一律填 workspace/info。 */
export function resolveUserActionCardVisualIcon(
  card: Pick<UserActionCard, 'icon' | 'actions' | 'title' | 'description'>
): UserActionCardVisualIcon {
  const explicit = card.icon
  if (explicit && explicit !== 'info') return explicit

  const action = primaryAction(card)
  if (!action) return explicit ?? 'info'

  switch (action.kind) {
    case 'enable_prompt_features':
      return 'plugin'
    case 'submit_form':
      return 'tool'
    case 'reject':
      return 'danger'
    case 'acknowledge':
      return 'success'
    case 'submit_input':
      return looksLikePathRequest(card) ? 'workspace' : 'input'
    default:
      return explicit ?? 'info'
  }
}

export function userActionCardVisualIconClassName(icon: UserActionCardVisualIcon): string {
  return CARD_ICON_CLASS[icon]
}

export function shouldDisableAfterCompletion(
  card: Pick<UserActionCard, 'blocking'>,
  action: UserActionCardAction
): boolean {
  return card.blocking || !!action.disableAfterClick
}

export function buildActionCompletionKey(
  sessionId: string,
  cardId: string,
  action: UserActionCardAction,
  index: number
): string {
  return `${sessionId}:${cardId}:${index}:${action.kind}:${action.label}`
}

export function getDefaultActionIcon(action: UserActionCardAction): UserActionCardActionIcon {
  switch (action.kind) {
    case 'enable_prompt_features':
      return 'plugin'
    case 'reject':
      return 'reject'
    case 'submit_input':
      return 'input'
    case 'submit_form':
      return 'send'
    case 'acknowledge':
    default:
      return 'confirm'
  }
}

export function shouldRenderTextAction(action: UserActionCardAction): boolean {
  return (
    action.kind === 'acknowledge' ||
    action.kind === 'enable_prompt_features' ||
    action.kind === 'reject' ||
    action.kind === 'submit_form'
  )
}

export function getTextActionLabel(action: UserActionCardAction, t: CardTranslate): string {
  if (action.label.trim()) return action.label

  switch (action.kind) {
    case 'acknowledge':
    case 'enable_prompt_features':
      return t('common.approve')
    case 'reject':
      return t('common.reject')
    default:
      return action.label
  }
}

export function normalizeTone(tone: UserActionCardTone): ActionCardTone {
  return tone === 'danger' ? 'error' : tone
}

export function selectCardTone(card: {
  icon: UserActionCardIcon
  tone: UserActionCardTone
}): ActionCardTone {
  return card.icon === 'plugin' ? 'warning' : normalizeTone(card.tone)
}

export function fieldHtmlId(cardId: string, fieldId: string): string {
  return `user-action-form-${cardId}-${fieldId}`
}
