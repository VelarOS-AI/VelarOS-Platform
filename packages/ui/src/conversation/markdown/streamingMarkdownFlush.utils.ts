import { isEmpty, trimmedStringOrEmpty } from '#internal/runtime'
export interface StreamingMarkdownBlockBuffer {
  kind: 'table'
  text: string
  confirmed: boolean
}

interface StreamingMarkdownFlushArgs {
  pendingText: string
  blockBuffer: Nullable<StreamingMarkdownBlockBuffer>
  emittedTextTail: string
  forceRelease?: boolean
}

interface StreamingMarkdownFlushResult {
  emitText: Nullable<string>
  pendingText: string
  blockBuffer: Nullable<StreamingMarkdownBlockBuffer>
  waitingForBlock: boolean
}

const MAX_EMITTED_TEXT_TAIL_LENGTH = 512

export function appendStreamingMarkdownTextTail(tail: string, text: string): string {
  const next = tail + text
  return next.length <= MAX_EMITTED_TEXT_TAIL_LENGTH
    ? next
    : next.slice(next.length - MAX_EMITTED_TEXT_TAIL_LENGTH)
}

export function splitMarkdownLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+/g) ?? []
}

export function stripMarkdownLineEnding(line: string): string {
  return line.replace(/\r?\n$/, '')
}

function splitTableCells(line: string): string[] {
  const trimmed = stripMarkdownLineEnding(line).trim()
  return trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|')
}

export function isMarkdownTableDelimiterRow(line: string): boolean {
  const cells = splitTableCells(line)

  return !isEmpty(cells) && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))
}

export function isPotentialMarkdownTableRow(line: string): boolean {
  const trimmed = stripMarkdownLineEnding(line).trim()

  if (!trimmed.includes('|') || isMarkdownTableDelimiterRow(trimmed)) return false

  return splitTableCells(trimmed).some((cell) => !isEmpty(cell.trim()))
}

export function containsMarkdownTable(text: string): boolean {
  const lines = splitMarkdownLines(text).map(stripMarkdownLineEnding)

  return lines.some(
    (line, index) =>
      isPotentialMarkdownTableRow(line) &&
      isMarkdownTableDelimiterRow(trimmedStringOrEmpty(lines[index + 1]))
  )
}

export function isCompleteMarkdownTableBlock(text: string): boolean {
  const lines = splitMarkdownLines(text)
    .map(stripMarkdownLineEnding)
    .map((line) => line.trim())

  while (isEmpty(lines[0])) {
    lines.shift()
  }

  while (isEmpty(lines[lines.length - 1])) {
    lines.pop()
  }

  if (lines.length < 2) return false

  const tableStartIndex = lines.findIndex(
    (line, index) =>
      isPotentialMarkdownTableRow(line) &&
      isMarkdownTableDelimiterRow(trimmedStringOrEmpty(lines[index + 1]))
  )

  if (tableStartIndex < 0) return false

  if (lines.slice(0, tableStartIndex).some((line) => !isEmpty(line))) return false

  for (let index = tableStartIndex + 2; index < lines.length; index += 1) {
    const line = lines[index]
    if (isEmpty(line)) {
      continue
    }

    if (!isPotentialMarkdownTableRow(line)) return false
  }

  return true
}

export function takeNextStreamingMarkdownFlush({
  pendingText,
  blockBuffer,
  emittedTextTail: _emittedTextTail,
  forceRelease = false,
}: StreamingMarkdownFlushArgs): StreamingMarkdownFlushResult {
  if (forceRelease) {
    const text = `${blockBuffer?.text ?? ''}${pendingText}`
    return {
      emitText: !isEmpty(text) ? text : null,
      pendingText: '',
      blockBuffer: null,
      waitingForBlock: false,
    }
  }

  const text = `${blockBuffer?.text ?? ''}${pendingText}`
  if (!text)
    return {
      emitText: null,
      pendingText: '',
      blockBuffer: null,
      waitingForBlock: false,
    }

  return {
    emitText: text,
    pendingText: '',
    blockBuffer: null,
    waitingForBlock: false,
  }
}
