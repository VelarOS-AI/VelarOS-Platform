const BACKTICK_SEQUENCE_PATTERN = /`+/g

export function buildStreamdownCodeFence({
  code,
  language = 'text',
}: {
  code: string
  language?: string
}): string {
  const trimmedLanguage = language.trim()
  const longestBacktickSequence = Math.max(
    0,
    ...Array.from(code.matchAll(BACKTICK_SEQUENCE_PATTERN), (match) => match[0].length)
  )
  const fence = '`'.repeat(Math.max(3, longestBacktickSequence + 1))
  const info = trimmedLanguage ? trimmedLanguage : 'text'

  return `${fence}${info}\n${code.trimEnd()}\n${fence}`
}
