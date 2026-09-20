/**
 * 两份文本逐行比，写成 unified 差量（和 `git diff` 一个样子）。
 *
 * 用 Myers 算法：先去掉首尾相同的行，中间那段按最短编辑路径比；编辑距离超过上限时不再细比，
 * 中间整段按「删掉旧的、写上新的」算——调用方应先限制输入规模，这条线只防两份毫不相干的代码把内存吃光。
 * 都不碰实例状态。
 */

type LineEdit = ['=' | '+' | '-', string]

/** 按 Myers 算法算中间那段的编辑脚本；编辑距离超过上限时交回 null。 */
function myersEdits(before: readonly string[], after: readonly string[], limit: number): Nullable<LineEdit[]> {
  const n = before.length
  const m = after.length
  const max = Math.min(n + m, limit)
  const offset = max + 1
  const frontier = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  for (let d = 0; d <= max; d += 1) {
    trace.push(frontier.slice())
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (frontier[offset + k - 1] ?? 0) < (frontier[offset + k + 1] ?? 0))
      let x = down ? frontier[offset + k + 1] ?? 0 : (frontier[offset + k - 1] ?? 0) + 1
      let y = x - k
      while (x < n && y < m && before[x] === after[y]) {
        x += 1
        y += 1
      }
      frontier[offset + k] = x
      if (x >= n && y >= m) return backtrack(trace, before, after, d, offset)
    }
  }
  return null
}

/** 从 Myers 的每一轮前沿倒着走回起点，交回编辑脚本。 */
function backtrack(trace: readonly Int32Array[], before: readonly string[], after: readonly string[], last: number, offset: number): LineEdit[] {
  const edits: LineEdit[] = []
  let x = before.length
  let y = after.length
  for (let d = last; d > 0; d -= 1) {
    const frontier = trace[d] ?? new Int32Array(0)
    const k = x - y
    const down = k === -d || (k !== d && (frontier[offset + k - 1] ?? 0) < (frontier[offset + k + 1] ?? 0))
    const previousK = down ? k + 1 : k - 1
    const previousX = frontier[offset + previousK] ?? 0
    const previousY = previousX - previousK
    while (x > previousX && y > previousY) {
      edits.push(['=', before[x - 1] ?? ''])
      x -= 1
      y -= 1
    }
    if (down) {
      edits.push(['+', after[y - 1] ?? ''])
      y -= 1
    } else {
      edits.push(['-', before[x - 1] ?? ''])
      x -= 1
    }
  }
  while (x > 0 && y > 0) {
    edits.push(['=', before[x - 1] ?? ''])
    x -= 1
    y -= 1
  }
  return edits.reverse()
}

/** 整份的编辑脚本：首尾相同的行直接对上，中间那段交给 Myers，比不动就整段删了重写。 */
function lineEdits(before: readonly string[], after: readonly string[], limit: number): LineEdit[] {
  let head = 0
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1
  let tail = 0
  while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail += 1
  const middleBefore = before.slice(head, before.length - tail)
  const middleAfter = after.slice(head, after.length - tail)
  const middle = myersEdits(middleBefore, middleAfter, limit)
    ?? [...middleBefore.map((line): LineEdit => ['-', line]), ...middleAfter.map((line): LineEdit => ['+', line])]
  return [
    ...before.slice(0, head).map((line): LineEdit => ['=', line]),
    ...middle,
    ...before.slice(before.length - tail).map((line): LineEdit => ['=', line]),
  ]
}

/**
 * 两份文本逐行比，交回 unified 差量：头两行是 `--- 旧` 与 `+++ 新`，每处改动一个 `@@` 块，前后带几行上下文。
 * 两份一样时交回空串。
 */
export function unifiedLineDiff(before: string, after: string, labels: { from: string; to: string; editLimit?: number; contextLines?: number }): string {
  if (before === after) return ''
  const edits = lineEdits(before.split('\n'), after.split('\n'), labels.editLimit ?? 2000)
  const context = labels.contextLines ?? 3
  // 每一行在旧、新两边各是第几行（从 1 起）：`+` 行的旧行号是它插在谁前面，`-` 行的新行号同理。
  const positioned: Array<{ edit: LineEdit; oldLine: number; newLine: number }> = []
  let oldLine = 1
  let newLine = 1
  for (const edit of edits) {
    positioned.push({ edit, oldLine, newLine })
    if (edit[0] !== '+') oldLine += 1
    if (edit[0] !== '-') newLine += 1
  }

  const lines = [`--- ${labels.from}`, `+++ ${labels.to}`]
  let index = 0
  while (index < positioned.length) {
    if (positioned[index]?.edit[0] === '=') {
      index += 1
      continue
    }
    // 一个块：从这处改动往前带几行上下文，往后一直延伸到下一处改动离得比两倍上下文还远为止。
    const start = Math.max(0, index - context)
    let lastChange = index
    let cursor = index
    while (cursor < positioned.length) {
      if (positioned[cursor]?.edit[0] !== '=') lastChange = cursor
      else if (cursor - lastChange > 2 * context) break
      cursor += 1
    }
    const end = Math.min(positioned.length, lastChange + context + 1)
    const hunk = positioned.slice(start, end)
    const oldCount = hunk.filter(({ edit }) => edit[0] !== '+').length
    const newCount = hunk.filter(({ edit }) => edit[0] !== '-').length
    const first = hunk[0]
    const oldStart = oldCount === 0 ? (first?.oldLine ?? 1) - 1 : first?.oldLine ?? 1
    const newStart = newCount === 0 ? (first?.newLine ?? 1) - 1 : first?.newLine ?? 1
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`)
    for (const { edit } of hunk) lines.push(`${edit[0] === '=' ? ' ' : edit[0]}${edit[1]}`)
    index = end
  }
  return lines.join('\n')
}
