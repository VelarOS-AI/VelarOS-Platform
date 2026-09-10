import { isEmpty, isPresent } from '#internal/runtime'
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

const UNIFIED_PATCH_HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u

/** hunk 头里行数为 0 时，起始行号指的是插入 / 删除点的**前一行**。 */
function readHunkStart(start: string, count: LooseOptional<string>): number {
  return count === '0' ? Number(start) + 1 : Number(start)
}

/** hunk 头省略行数（`@@ -3 +3 @@`）表示 1 行。 */
function readHunkLineCount(count: LooseOptional<string>): number {
  return isPresent(count) ? Number(count) : 1
}

/**
 * 由单个文件的 git 统一 diff 补丁构造差异摘要（与 `buildFileDiffSummary` 同一种行模型）。
 *
 * 行号取自 hunk 头；hunk 之间补丁没带的未改动区间折成一行「隐藏 N 行」，与按全文比出来的摘要
 * 同样呈现。二进制文件没有补丁，只给计数和一行说明；补丁缺席（过大被省略）时计数用调用方给的
 * numstat——所以两个计数都是必填。
 */
export function buildFileDiffSummaryFromUnifiedPatch(
  patch: string,
  options: {
    additions: number
    deletions: number
    binary: boolean
    /** 二进制文件那一行说明的文案，宿主按自己的语言传。 */
    binaryLabel?: string
  }
): FileDiffSummary {
  if (options.binary)
    return {
      added: options.additions,
      removed: options.deletions,
      rows: [
        {
          kind: 'context',
          oldLineNumber: null,
          newLineNumber: null,
          text: options.binaryLabel ?? 'Binary file changed',
        },
      ],
    }

  const rows: FileDiffRow[] = []
  let added = 0
  let removed = 0
  let oldLineNumber = 0
  let newLineNumber = 0
  // hunk 体按头里的行数读完为止：读完之后到下一个 hunk 头之间都是文件头，不按行首字符去猜。
  let remainingOldLines = 0
  let remainingNewLines = 0
  // 同一段补丁里的后一个 hunk 才折叠中间的区间；git 把「文件 ↔ 符号链接」拆成删除 + 新建
  // 两段输出，第二段从头编号。
  let continuesSection = false
  const lines = patch.split(/\r?\n/u)
  // 补丁以换行结尾时 split 多出的最后一段空串不是一行。
  if (isEmpty(lines[lines.length - 1])) lines.pop()

  for (const line of lines) {
    const hunkMatch = UNIFIED_PATCH_HUNK_HEADER.exec(line)
    if (hunkMatch) {
      const oldStart = readHunkStart(hunkMatch[1], hunkMatch[2])
      if (continuesSection && oldStart > oldLineNumber)
        rows.push({
          kind: 'collapsed',
          oldLineNumber: null,
          newLineNumber: null,
          text: '',
          hiddenCount: oldStart - oldLineNumber,
        })
      continuesSection = true
      oldLineNumber = oldStart
      newLineNumber = readHunkStart(hunkMatch[3], hunkMatch[4])
      remainingOldLines = readHunkLineCount(hunkMatch[2])
      remainingNewLines = readHunkLineCount(hunkMatch[4])
      continue
    }

    // `\` 行标注上一行「文件末尾没有换行」，可以出现在 hunk 中间，不占行数。
    if (line.startsWith('\\')) continue

    if (remainingOldLines <= 0 && remainingNewLines <= 0) {
      if (line.startsWith('diff ')) continuesSection = false
      continue
    }

    if (line.startsWith('+')) {
      added += 1
      remainingNewLines -= 1
      rows.push({
        kind: 'add',
        oldLineNumber: null,
        newLineNumber: newLineNumber++,
        text: line.slice(1),
      })
      continue
    }

    if (line.startsWith('-')) {
      removed += 1
      remainingOldLines -= 1
      rows.push({
        kind: 'remove',
        oldLineNumber: oldLineNumber++,
        newLineNumber: null,
        text: line.slice(1),
      })
      continue
    }

    remainingOldLines -= 1
    remainingNewLines -= 1
    rows.push({
      kind: 'context',
      oldLineNumber: oldLineNumber++,
      newLineNumber: newLineNumber++,
      text: line.startsWith(' ') ? line.slice(1) : line,
    })
  }

  return {
    added: added || options.additions,
    removed: removed || options.deletions,
    rows,
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
