import { isEmpty } from '#internal/runtime'
const EscapedDollar = '\\$'
const InlineCodeDelimiterPattern = /`+/g
const FenceLinePattern = /^ {0,3}(`{3,}|~{3,})/
const MathSignalPattern = /[\\^_={}<>≤≥≈≠±×÷∑∫√∞∈∉∩∪∂∇|/]/
const GreekLetterPattern = /[\u0370-\u03ff]/
const SingleIdentifierPattern = /^[A-Za-z\u0370-\u03ff]$/
const FunctionLikeMathPattern = /^[A-Za-z][A-Za-z0-9]*\s*\([^)]{1,120}\)$/
const PlainCurrencyAmountPattern =
  /^[+-]?(?:\d[\d,]*(?:\.\d+)?|\.\d+)\s*(?:usd|dollars?|rmb|cny|元|人民币|k|m|bn|万|亿)?$/i
const DirectoryTreeMarkerPattern = /[│├└─┬┴┼]/
const DirectoryTreeRootLinePattern = /^[^\n│├└─┬┴┼]+[/\\]\s*$/u

export function prepareStreamdownMarkdownText(markdown: string): string {
  const normalizedMarkdown = wrapUnfencedDirectoryTreeBlocks(markdown)
  const lines = normalizedMarkdown.split(/(\n)/)
  let fenceDelimiter: Nullable<string> = null

  return lines
    .map((part) => {
      if (part === '\n') return part

      const fenceMatch = part.match(FenceLinePattern)
      if (fenceMatch) {
        const delimiter = fenceMatch[1][0]
        if (!fenceDelimiter) {
          fenceDelimiter = delimiter
        } else if (delimiter === fenceDelimiter) {
          fenceDelimiter = null
        }
        return part
      }

      if (fenceDelimiter) return part

      return prepareInlineMarkdownText(part)
    })
    .join('')
}

function isDirectoryTreeLine(line: string): boolean {
  if (DirectoryTreeMarkerPattern.test(line)) return true

  return DirectoryTreeRootLinePattern.test(line.trim())
}

function wrapUnfencedDirectoryTreeBlocks(markdown: string): string {
  const lines = markdown.split('\n')
  let inFence = false
  let fenceDelimiter = ''
  const output: string[] = []
  let treeRun: string[] = []

  const flushTreeRun = (): void => {
    if (
      treeRun.length >= 2 &&
      treeRun.some((line) => DirectoryTreeMarkerPattern.test(line))
    ) {
      output.push('```', ...treeRun, '```')
    } else {
      output.push(...treeRun)
    }

    treeRun = []
  }

  for (const line of lines) {
    const fenceMatch = line.match(FenceLinePattern)
    if (fenceMatch) {
      flushTreeRun()
      const delimiter = fenceMatch[1][0]
      if (!inFence) {
        inFence = true
        fenceDelimiter = delimiter
      } else if (delimiter === fenceDelimiter) {
        inFence = false
        fenceDelimiter = ''
      }
      output.push(line)
      continue
    }

    if (inFence) {
      output.push(line)
      continue
    }

    if (isDirectoryTreeLine(line) || (treeRun.length > 0 && isEmpty(line.trim()))) {
      treeRun.push(line)
      continue
    }

    flushTreeRun()
    output.push(line)
  }

  flushTreeRun()

  return output.join('\n')
}

function prepareInlineMarkdownText(markdown: string): string {
  let result = ''
  let cursor = 0

  InlineCodeDelimiterPattern.lastIndex = 0
  while (cursor < markdown.length) {
    InlineCodeDelimiterPattern.lastIndex = cursor
    const opening = InlineCodeDelimiterPattern.exec(markdown)
    if (!opening) {
      result += guardLiteralDollars(markdown.slice(cursor))
      break
    }

    result += guardLiteralDollars(markdown.slice(cursor, opening.index))

    const delimiter = opening[0]
    const closingIndex = markdown.indexOf(delimiter, opening.index + delimiter.length)
    if (closingIndex === -1) {
      result += markdown.slice(opening.index)
      break
    }

    result += markdown.slice(opening.index, closingIndex + delimiter.length)
    cursor = closingIndex + delimiter.length
  }

  return result
}

function guardLiteralDollars(text: string): string {
  let result = ''
  let index = 0

  while (index < text.length) {
    if (text[index] !== '$' || isEscapedAt(text, index)) {
      result += text[index]
      index += 1
      continue
    }

    if (text[index + 1] === '$') {
      const closingBlockIndex = findClosingDoubleDollar(text, index + 2)
      if (closingBlockIndex === -1) {
        result += '$$'
        index += 2
      } else {
        result += text.slice(index, closingBlockIndex + 2)
        index = closingBlockIndex + 2
      }
      continue
    }

    const closingIndex = findInlineMathClosingDollar(text, index)
    if (closingIndex === -1) {
      result += EscapedDollar
      index += 1
      continue
    }

    result += text.slice(index, closingIndex + 1)
    index = closingIndex + 1
  }

  return result
}

function findClosingDoubleDollar(text: string, startIndex: number): number {
  for (let index = startIndex; index < text.length - 1; index += 1) {
    if (text[index] === '$' && text[index + 1] === '$' && !isEscapedAt(text, index)) return index
  }

  return -1
}

function findInlineMathClosingDollar(text: string, openingIndex: number): number {
  if (!isPotentialInlineMathOpening(text, openingIndex)) return -1

  for (let index = openingIndex + 1; index < text.length; index += 1) {
    if (text[index] !== '$' || isEscapedAt(text, index)) {
      continue
    }

    if (text[index + 1] === '$') return -1

    const content = text.slice(openingIndex + 1, index)
    if (isPotentialInlineMathClosing(text, index) && isLikelyInlineMathContent(content)) return index
  }

  return -1
}

function isPotentialInlineMathOpening(text: string, index: number): boolean {
  const previous = text[index - 1] ?? ''
  const next = text[index + 1] ?? ''

  if (!next || /\s/.test(next) || next === '{') return false

  return !/[A-Za-z0-9_]/.test(previous)
}

function isPotentialInlineMathClosing(text: string, index: number): boolean {
  const previous = text[index - 1] ?? ''
  const next = text[index + 1] ?? ''

  if (!previous || /\s/.test(previous)) return false

  return !/[A-Za-z0-9_$]/.test(next)
}

function isLikelyInlineMathContent(content: string): boolean {
  const trimmed = content.trim()

  if (
    isEmpty(trimmed) ||
    trimmed.includes('\n') ||
    trimmed.includes('$') ||
    PlainCurrencyAmountPattern.test(trimmed)
  ) return false

  return (
    SingleIdentifierPattern.test(trimmed) ||
    MathSignalPattern.test(trimmed) ||
    GreekLetterPattern.test(trimmed) ||
    FunctionLikeMathPattern.test(trimmed)
  )
}

function isEscapedAt(text: string, index: number): boolean {
  let backslashCount = 0
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) {
    backslashCount += 1
  }

  return backslashCount % 2 === 1
}
