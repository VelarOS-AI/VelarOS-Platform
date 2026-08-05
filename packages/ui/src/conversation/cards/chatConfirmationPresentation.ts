import type { ConversationMessageKey } from '../i18n'

import type { ConfirmationRequestDetail } from '#contracts'
import { isEmpty } from '#internal/runtime'

/**
 * 等待确认卡的**纯呈现层**：结构化信封 → 标题/正文/要点。
 *
 * 判据只看 `detail.kind`。`message` 是**兜底散文**，只在三种情况下出场：信封缺席（旧会话存档、
 * 模型自由撰写的 `interaction:confirm`）、本卡还不认识该 kind（宿主比包新）、以及散文本身为空时
 * 的通用文案。
 *
 * 上一版反过来：信封只有一根散文，卡片靠「首行是不是等于某句固定中文」这类字面量比较把结构猜回来。
 * 上游改一个字结构卡就静默退化成一行灰字，没有任何门会红；写死的简体中文也让 en-US 永远触发不到
 * 结构布局。那三条反解分支已整体删除，别再往回加——`tests/ui/chatConfirmationEnvelope.test.ts` 会拦。
 */

export type ConfirmationTranslate = (
  key: ConversationMessageKey,
  params?: Record<string, string | number>
) => string

export interface ConfirmationPresentation {
  title: string
  description: string
  /** 结构化要点（工具名 / 技能 id 等）；散文形态为空。 */
  facts: string[]
}

function getMessageLines(message: Nullable<string>): string[] {
  const lines: string[] = []

  for (const line of (message ?? '').split('\n')) {
    const trimmedLine = line.trim()
    if (!isEmpty(trimmedLine)) lines.push(trimmedLine)
  }

  return lines
}

/** 兜底散文：整段折成一行；空则用通用等待确认文案。 */
function proseDescription(message: Nullable<string>, fallback: string): string {
  const lines = getMessageLines(message)
  return isEmpty(lines) ? fallback : lines.join(' ')
}

export function buildConfirmationPresentation({
  message,
  detail,
  t,
}: {
  message: Nullable<string>
  detail: Nullable<ConfirmationRequestDetail>
  t: ConfirmationTranslate
}): ConfirmationPresentation {
  const genericTitle = t('status.awaitingConfirmation')
  const genericDescription = t('status.awaitingConfirmationDescription')
  const proseFallback = (): ConfirmationPresentation => ({
    title: genericTitle,
    description: proseDescription(message, genericDescription),
    facts: [],
  })

  if (!detail) return proseFallback()

  switch (detail.kind) {
    case 'tool-category-authorization':
      return {
        title: t('confirmation.toolCategoryTitle'),
        description: t('confirmation.toolCategoryDescription', { category: detail.categoryLabel }),
        facts: [t('confirmation.toolCategoryTool', { tool: detail.toolName })],
      }
    case 'mcp-tool-call':
      return {
        title: t('confirmation.mcpToolTitle'),
        description: t('confirmation.mcpToolDescription', {
          server: detail.serverName,
          tool: detail.toolName,
        }),
        facts: [],
      }
    case 'skill-load':
      return {
        title: t('confirmation.skillLoadTitle'),
        description: t('confirmation.skillLoadDescription', { label: detail.label }),
        facts: [
          detail.description?.trim() || null,
          t('confirmation.skillLoadId', { id: detail.skillId }),
        ].filter((fact): fact is string => !!fact),
      }
    default:
      // 未知 kind（宿主比包新）：不猜、不空白，直接回落散文。
      return proseFallback()
  }
}
