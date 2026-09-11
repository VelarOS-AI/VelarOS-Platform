import type { AppLocale, ThinkingBlock } from '#contracts'
import { isBlank, isNonBlankString, isTrue } from '#internal/runtime'

export type ThinkingTextLanguage = 'english' | 'chinese' | 'mixed' | 'neutral'

export type ThinkingTranslationButtonKind =
  | 'hidden'
  | 'translate'
  | 'show-original'
  | 'show-translation'

export type ThinkingTranslationClickResolution =
  | { kind: 'noop' }
  | { kind: 'show-original' }
  | { kind: 'show-cached' }
  | { kind: 'request-model'; sourceText: string }

const StreamingThinkingTailChars = 12_000
const StreamingThinkingTailLines = 240
const CjkPattern = /[\u3400-\u9fff\uf900-\ufaff]/g
const LatinPattern = /[A-Za-z]/g
const MarkdownFencePattern = /```[\s\S]*?```/g
const InlineCodePattern = /`[^`]*`/g
const UrlPattern = /https?:\/\/\S+/gi

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0
}

function stripNonLinguisticText(text: string): string {
  return text
    .replace(MarkdownFencePattern, ' ')
    .replace(InlineCodePattern, ' ')
    .replace(UrlPattern, ' ')
}

export function detectThinkingTextLanguage(text: string): ThinkingTextLanguage {
  const normalized = stripNonLinguisticText(text)
  const cjkCount = countMatches(normalized, CjkPattern)
  const latinCount = countMatches(normalized, LatinPattern)

  if (cjkCount === 0 && latinCount === 0) return 'neutral'

  if (cjkCount === 0) return 'english'

  if (latinCount === 0) return 'chinese'

  if (cjkCount >= latinCount * 0.35) return 'chinese'

  if (latinCount >= cjkCount * 3) return 'english'

  return 'mixed'
}

export function shouldOfferThinkingTranslation(text: string, locale: AppLocale): boolean {
  if (isBlank(text)) return false

  const language = detectThinkingTextLanguage(text)
  if (language === 'neutral') return false

  if (locale === 'zh-CN') return language !== 'chinese'

  return language !== 'english'
}

export function hasThinkingTranslationForLocale(
  block: ThinkingBlock,
  locale: AppLocale
): boolean {
  return (
    block.translatedLocale === locale &&
    isNonBlankString(block.translatedText)
  )
}

export function isThinkingTranslationVisible(
  block: ThinkingBlock,
  locale: AppLocale
): boolean {
  return isTrue(block.translationVisible) && hasThinkingTranslationForLocale(block, locale)
}

export function getThinkingBlockDisplayText(block: ThinkingBlock, locale: AppLocale): string {
  return isThinkingTranslationVisible(block, locale) ? block.translatedText ?? block.text : block.text
}

export interface StreamingThinkingDisplayWindow {
  /** 窗口里的思考原文（整段原文的一个后缀）。 */
  text: string
  /** 窗口在整段原文里的起点。 */
  start: number
  /** 前面还有被截掉的部分。 */
  truncated: boolean
}

/** 流式思考只显示末尾一段：最多 `maxChars` 个字、`maxLines` 行，窗口永远是原文的后缀。 */
export function getStreamingThinkingDisplayWindow(
  text: string,
  options: {
    streaming: boolean
    maxChars?: number
    maxLines?: number
  }
): StreamingThinkingDisplayWindow {
  if (!options.streaming) return { text, start: 0, truncated: false }

  const maxChars = options.maxChars ?? StreamingThinkingTailChars
  const maxLines = options.maxLines ?? StreamingThinkingTailLines
  let start = maxChars > 0 && text.length > maxChars ? text.length - maxChars : 0

  if (maxLines > 0) {
    let newlines = 0
    for (let index = text.length - 1; index >= start; index -= 1) {
      if (text[index] !== '\n') continue
      newlines += 1
      if (newlines === maxLines) {
        start = index + 1
        break
      }
    }
  }

  return { text: text.slice(start), start, truncated: start > 0 }
}

export function getStreamingThinkingDisplayText(
  text: string,
  options: {
    streaming: boolean
    maxChars?: number
    maxLines?: number
  }
): string {
  const window = getStreamingThinkingDisplayWindow(text, options)
  return window.truncated ? `...\n${window.text}` : window.text
}

export function getThinkingTranslationButtonKind(
  block: ThinkingBlock,
  locale: AppLocale
): ThinkingTranslationButtonKind {
  if (isThinkingTranslationVisible(block, locale)) return 'show-original'

  if (hasThinkingTranslationForLocale(block, locale)) return 'show-translation'

  return shouldOfferThinkingTranslation(block.text, locale) ? 'translate' : 'hidden'
}

export function resolveThinkingTranslationClick(
  block: ThinkingBlock,
  locale: AppLocale
): ThinkingTranslationClickResolution {
  if (isThinkingTranslationVisible(block, locale)) return { kind: 'show-original' }

  if (hasThinkingTranslationForLocale(block, locale)) return { kind: 'show-cached' }

  const sourceText = block.text.trim()
  if (!shouldOfferThinkingTranslation(sourceText, locale)) return { kind: 'noop' }

  return {
    kind: 'request-model',
    sourceText,
  }
}

export function shouldAutoTranslateThinkingBlock(
  block: ThinkingBlock,
  locale: AppLocale,
  enabled: boolean
): boolean {
  if (!enabled) return false
  if (hasThinkingTranslationForLocale(block, locale)) return false

  return resolveThinkingTranslationClick(block, locale).kind === 'request-model'
}
