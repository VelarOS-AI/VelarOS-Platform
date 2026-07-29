import {
  type ConversationTranslator,
  conversationTranslatorRuntime,
} from '../i18n/conversationTranslator'

import type { AppLocale } from '#contracts'
import { isPresent, isString, Log, stringifyPretty } from '#internal/runtime'

const log = Log.tag('tool-display-utils')

/** 命令输出和相关调试视图截断前的默认最大字符数。 */
export const DEFAULT_COMMAND_TOOL_DISPLAY_MAX_CHARS = 6000

/** 默认工具渲染中通用 JSON 参数和结果预览的最大字符数。 */
export const DEFAULT_TOOL_JSON_PREVIEW_MAX_CHARS = 8000

export function formatUnknownPayload(value: any): string {
  if (!isPresent(value)) return '—'
  if (isString(value)) return value
  try {
    return stringifyPretty(value)
  } catch (error) {
    log.debug('序列化工具展示 payload 失败，使用字符串兜底', {
      error: String(error),
    })
    return String(value)
  }
}

/**
 * 为屏幕上的工具和调试视图截断长文本。
 * 保留正文、空行和截断提示的展示格式。
 */
export function truncateForDisplay(text: string, maxChars: number, bracketInner: string): string {
  if (text.length <= maxChars) return text

  return `${text.slice(0, maxChars)}\n\n... [${bracketInner}]`
}

export function truncateLocalizedCommandOutput(
  text: string,
  locale: AppLocale,
  maxChars: number = DEFAULT_COMMAND_TOOL_DISPLAY_MAX_CHARS,
  runtime: ConversationTranslator = conversationTranslatorRuntime
): string {
  return truncateForDisplay(
    text,
    maxChars,
    runtime.translate(locale, 'commandTool.truncated', {
      length: text.length,
    })
  )
}
