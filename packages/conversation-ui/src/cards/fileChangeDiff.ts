import { isEmpty } from '#internal/runtime'
export interface FileDiffRow {
  kind: 'context' | 'add' | 'remove' | 'collapsed'
  oldLineNumber: Nullable<number>
  newLineNumber: Nullable<number>
  text: string
  hiddenCount?: number
}

export interface FileDiffSummary {
  added: number
  removed: number
  rows: FileDiffRow[]
}

interface DiffOperation {
  kind: 'equal' | 'add' | 'remove'
  text: string
}

const MAX_LCS_CELLS = 180_000
const MAX_CONTEXT_ROWS = 3

export function buildFileDiffSummary(beforeContent: string, afterContent: string): FileDiffSummary {
  const beforeLines = normalizeLines(beforeContent)
  const afterLines = normalizeLines(afterContent)
  const operations = buildDiffOperations(beforeLines, afterLines)

  let oldLineNumber = 1
  let newLineNumber = 1
  let added = 0
  let removed = 0

  const rows = operations.map((operation): FileDiffRow => {
    if (operation.kind === 'equal') return {
        kind: 'context',
        oldLineNumber: oldLineNumber++,
        newLineNumber: newLineNumber++,
        text: operation.text,
      }

    if (operation.kind === 'remove') {
      removed += 1
      return {
        kind: 'remove',
        oldLineNumber: oldLineNumber++,
        newLineNumber: null,
        text: operation.text,
      }
    }

    added += 1
    return {
      kind: 'add',
      oldLineNumber: null,
      newLineNumber: newLineNumber++,
      text: operation.text,
    }
  })

  return {
    added,
    removed,
    rows: collapseContextRows(rows),
  }
}

function normalizeLines(content: string): string[] {
  if (!content) return []

  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')

  if (lines.length === 1 && isEmpty(lines[0])) return []

  return lines
}

function buildDiffOperations(beforeLines: string[], afterLines: string[]): DiffOperation[] {
  if (isEmpty(beforeLines)) return afterLines.map((text) => ({ kind: 'add', text }))

  if (isEmpty(afterLines)) return beforeLines.map((text) => ({ kind: 'remove', text }))

  if (beforeLines.length * afterLines.length > MAX_LCS_CELLS) return buildFallbackOperations(beforeLines, afterLines)

  return buildLcsOperations(beforeLines, afterLines)
}

function buildLcsOperations(beforeLines: string[], afterLines: string[]): DiffOperation[] {
  const dp = Array.from({ length: beforeLines.length + 1 }, () =>
    new Uint16Array(afterLines.length + 1)
  )

  for (let beforeIndex = beforeLines.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = afterLines.length - 1; afterIndex >= 0; afterIndex -= 1) {
      dp[beforeIndex][afterIndex] =
        beforeLines[beforeIndex] === afterLines[afterIndex]
          ? dp[beforeIndex + 1][afterIndex + 1] + 1
          : Math.max(dp[beforeIndex + 1][afterIndex], dp[beforeIndex][afterIndex + 1])
    }
  }

  const operations: DiffOperation[] = []
  let beforeIndex = 0
  let afterIndex = 0

  while (beforeIndex < beforeLines.length && afterIndex < afterLines.length) {
    if (beforeLines[beforeIndex] === afterLines[afterIndex]) {
      operations.push({
        kind: 'equal',
        text: beforeLines[beforeIndex],
      })
      beforeIndex += 1
      afterIndex += 1
      continue
    }

    if (dp[beforeIndex + 1][afterIndex] >= dp[beforeIndex][afterIndex + 1]) {
      operations.push({
        kind: 'remove',
        text: beforeLines[beforeIndex],
      })
      beforeIndex += 1
      continue
    }

    operations.push({
      kind: 'add',
      text: afterLines[afterIndex],
    })
    afterIndex += 1
  }

  while (beforeIndex < beforeLines.length) {
    operations.push({
      kind: 'remove',
      text: beforeLines[beforeIndex],
    })
    beforeIndex += 1
  }

  while (afterIndex < afterLines.length) {
    operations.push({
      kind: 'add',
      text: afterLines[afterIndex],
    })
    afterIndex += 1
  }

  return operations
}

function buildFallbackOperations(beforeLines: string[], afterLines: string[]): DiffOperation[] {
  let prefix = 0
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1
  }

  let suffix = 0
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const operations: DiffOperation[] = []
  beforeLines.slice(0, prefix).forEach((text) => {
    operations.push({ kind: 'equal', text })
  })
  beforeLines.slice(prefix, beforeLines.length - suffix).forEach((text) => {
    operations.push({ kind: 'remove', text })
  })
  afterLines.slice(prefix, afterLines.length - suffix).forEach((text) => {
    operations.push({ kind: 'add', text })
  })
  beforeLines.slice(beforeLines.length - suffix).forEach((text) => {
    operations.push({ kind: 'equal', text })
  })

  return operations
}

function collapseContextRows(rows: FileDiffRow[]): FileDiffRow[] {
  const collapsedRows: FileDiffRow[] = []
  let index = 0

  while (index < rows.length) {
    if (rows[index].kind !== 'context') {
      collapsedRows.push(rows[index])
      index += 1
      continue
    }

    const start = index
    while (index < rows.length && rows[index].kind === 'context') {
      index += 1
    }
    const contextRows = rows.slice(start, index)

    if (contextRows.length <= MAX_CONTEXT_ROWS * 2 + 1) {
      collapsedRows.push(...contextRows)
      continue
    }

    collapsedRows.push(...contextRows.slice(0, MAX_CONTEXT_ROWS))
    collapsedRows.push({
      kind: 'collapsed',
      oldLineNumber: null,
      newLineNumber: null,
      text: '',
      hiddenCount: contextRows.length - MAX_CONTEXT_ROWS * 2,
    })
    collapsedRows.push(...contextRows.slice(-MAX_CONTEXT_ROWS))
  }

  return collapsedRows
}
