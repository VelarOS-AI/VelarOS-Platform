import { isArray, isNumber, isPlainObject, isString } from '@velaros-ai/core'

// 模型 JSON 预算收紧后，Project 分页读取的范围与续读信息仍须真实。

/** 行号只属于模型视图；原始结果与 recall 正文保持逐字节语义。 */
function numberProjectRead(value: Record<string, unknown>): Record<string, unknown> {
  const content = value.content as string
  const range = isPlainObject(value.range) ? value.range : {}
  const startLine = isNumber(range.startLine) ? range.startLine : 1
  return {
    ...value,
    content: content
      ? content
          .split('\n')
          .map((line, index) => `${startLine + index}|${line}`)
          .join('\n')
      : '',
    contentFormat: 'line-numbered',
  }
}

function shortenProjectRead(value: unknown, maximum: number): unknown {
  if (
    !isPlainObject(value) ||
    !isString(value.content) ||
    !isPlainObject(value.snapshot) ||
    !isString(value.snapshot.path) ||
    !isString(value.snapshot.revision)
  )
    return value
  // 历史回放可以重复收敛预算；先还原原文，避免重复编号或把编号计入续读列。
  const content =
    value.contentFormat === 'line-numbered' ? value.content.replace(/^\d+\|/gm, '') : value.content
  const rawValue = { ...value, content }
  const numbered = numberProjectRead(rawValue)
  if (JSON.stringify(numbered).length <= maximum) return numbered

  const snapshot = value.snapshot
  const range = isPlainObject(value.range) ? value.range : {}
  const startLine = isNumber(range.startLine) ? range.startLine : 1
  const startColumn = isNumber(range.startColumn) ? range.startColumn : 1
  const existingContinuation = isPlainObject(value.continuation) ? value.continuation : {}
  const existingRange = isPlainObject(existingContinuation.range) ? existingContinuation.range : {}
  const candidate = (requestedLength: number) => {
    let length = requestedLength
    // 不拆开代理对字符或 CRLF。
    const last = content.charCodeAt(length - 1)
    if (
      (last >= 0xd800 && last <= 0xdbff) ||
      (content[length - 1] === '\r' && content[length] === '\n')
    )
      length--
    const prefix = content.slice(0, Math.max(0, length))
    const lines = prefix.split('\n')
    const endLine = startLine + lines.length - 1
    const endColumn =
      lines.length === 1 ? startColumn + prefix.length : lines[lines.length - 1].length + 1
    return numberProjectRead({
      ...rawValue,
      content: prefix,
      range: {
        ...range,
        startLine,
        startColumn,
        endLine,
        endColumn,
        ...(isNumber(range.startOffset)
          ? { endOffset: range.startOffset + prefix.length }
          : {}),
      },
      truncated: true,
      hasMore: true,
      returnedChars: prefix.length,
      nextStartLine: endColumn === 1 ? endLine : undefined,
      remainingLines: undefined,
      continuation: {
        ...existingContinuation,
        path: snapshot.path,
        range: { ...existingRange, startLine: endLine, startColumn: endColumn },
        baseRevisions: { [snapshot.path as string]: snapshot.revision },
      },
    })
  }
  let low = 0
  let high = content.length
  // JSON 转义会放大体积，按序列化后的候选结果测量，而不是原始字符数。
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (JSON.stringify(candidate(middle)).length <= maximum) low = middle
    else high = middle - 1
  }
  return candidate(low)
}

export function fitProjectReadsForModel(result: unknown, maximum: number): unknown {
  if (!isPlainObject(result) || !isArray(result.files)) return shortenProjectRead(result, maximum)
  const overhead = JSON.stringify({ ...result, files: [] }).length + result.files.length * 2
  const perFile = Math.max(512, Math.floor((maximum - overhead) / Math.max(1, result.files.length)))
  return { ...result, files: result.files.map((file) => shortenProjectRead(file, perFile)) }
}
