import type { AppLocale } from '#contracts'
import { isBlank, isEmpty,truncate } from '#internal/runtime'

export const ChatComposerVirtualPasteMinChars = 8_000

const VirtualPasteMarkerPrefix = '{{paste:'
const VirtualPasteMarkerSuffix = '}}'

export interface ChatVirtualPasteReference {
  id: string
  marker: string
  title: string
  charCount: number
  lineCount: number
  createdAt: number
}

export function shouldVirtualizePastedText(input: {
  pastedText: string
  nextInputLength: number
  maxInputChars: number
}): boolean {
  const text = input.pastedText.trim()
  if (isBlank(text)) return false

  return (
    text.length >= ChatComposerVirtualPasteMinChars || input.nextInputLength > input.maxInputChars
  )
}

export function createVirtualPasteMarker(id: string): string {
  return `${VirtualPasteMarkerPrefix}${id}${VirtualPasteMarkerSuffix}`
}

export function createVirtualPasteReference(input: {
  id: string
  text: string
  createdAt?: number
}): ChatVirtualPasteReference {
  const trimmedText = input.text.trim()
  const firstLine = trimmedText
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => !isBlank(line))
  const title = truncate((firstLine ?? input.id).replace(/\s+/gu, ' '), 42)
  const lineCount = isBlank(trimmedText) ? 0 : trimmedText.split(/\r?\n/u).length

  return {
    id: input.id,
    marker: createVirtualPasteMarker(input.id),
    title,
    charCount: input.text.length,
    lineCount,
    createdAt: input.createdAt ?? Date.now(),
  }
}

export function formatVirtualPasteReference(
  reference: ChatVirtualPasteReference,
  locale: AppLocale
): string {
  const charUnit = locale === 'zh-CN' ? '字符' : 'chars'
  const lineUnit = locale === 'zh-CN' ? '行' : 'lines'

  return `粘贴索引 ${reference.id}: ${reference.title} (${reference.charCount} ${charUnit}, ${reference.lineCount} ${lineUnit})`
}

export function formatVirtualPasteReferencesForMessage(input: {
  text: string
  references: readonly ChatVirtualPasteReference[]
  locale: AppLocale
}): string {
  let nextText = input.text.trim()
  const appendedReferences: ChatVirtualPasteReference[] = []

  for (const reference of input.references) {
    const formatted = formatVirtualPasteReference(reference, input.locale)

    if (nextText.includes(reference.marker)) {
      nextText = nextText.split(reference.marker).join(formatted)
    } else {
      appendedReferences.push(reference)
    }
  }

  if (isEmpty(appendedReferences)) return nextText

  const appendedText = appendedReferences
    .map((reference) => formatVirtualPasteReference(reference, input.locale))
    .join('\n')

  return [nextText, appendedText].filter((part) => !isBlank(part)).join('\n\n')
}
