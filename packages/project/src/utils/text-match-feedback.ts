// 域：文本锚点匹配失败时给模型的定位线索。
//
// 模型凭记忆拼写数千字符的 oldText 时，最常见的失败是某一行差一个空格或一个反斜杠；
// 只回复「找到 0 个」会迫使它整段重读再盲猜。这里给出有界的最佳候选位置、首个分歧行及
// 可识别的差异原因，并统一行尾空白/换行符宽容匹配的判定。所有输出都有上限：候选数、
// 展示的匹配数与摘录长度都被截断，绝不把整文件塞回上下文。
import { isBlank, isEmpty, isPresent, toNullable, truncate } from '@velaros-ai/core'

import { offsetToLine } from './text.js'

const MaxAnchorLines = 8
const MaxCandidateStarts = 200
const MaxReportedMatches = 10
const ExcerptChars = 160
const MaxEnclosingLookbackLines = 200

export type TextMismatchCause =
  | 'line_ending'
  | 'trailing_whitespace'
  | 'indentation'
  | 'backslash_escape'
  | 'quote_style'
  | 'content'
  | 'end_of_file'
  | 'absent'

export interface TextMatchMissDiagnosis {
  /** oldText 在文件中最接近的对齐起始行（1-based）；任何非空行都不在文件中时缺省。 */
  candidateLine?: number
  /** 候选位置从 oldText 第 1 行起连续逐字一致的行数。 */
  matchedLines?: number
  oldTextLines: number
  firstMismatch?: {
    oldTextLine: number
    fileLine: number
    expected: string
    /** null 表示文件在该行之前已结束。 */
    actual: Nullable<string>
  }
  causes: TextMismatchCause[]
  hint: string
}

export interface TextMatchLocation {
  occurrence: number
  line: number
  /** 匹配所在行之上最近的外层（缩进更浅的）行，用来区分同形文本分别属于哪个块。 */
  within?: string
}

// 差异归因按「逐级放宽」的顺序定义；只报告让两行相等所必需的那几级。
const MismatchNormalizers: ReadonlyArray<readonly [TextMismatchCause, (line: string) => string]> = [
  ['line_ending', (line) => line.replace(/\r$/, '')],
  ['trailing_whitespace', (line) => line.replace(/[ \t]+$/, '')],
  ['indentation', (line) => line.replace(/^[ \t]+/, '')],
  ['backslash_escape', (line) => line.replace(/\\+/g, '\\')],
  ['quote_style', (line) => line.replace(/[“”‘’'"`]/g, '"')],
]

/**
 * oldText 可以从行中间开始、在行中间结束：首行只要求是文件行的后缀，末行只要求是前缀，
 * 单行 oldText 只要求被包含，中间行必须整行相等。
 */
function alignedEqual(expected: string, actual: Optional<string>, index: number, count: number): boolean {
  if (!isPresent(actual)) return false
  if (count === 1) return actual.includes(expected)
  if (index === 0) return actual.endsWith(expected)
  if (index === count - 1) return actual.startsWith(expected)
  return actual === expected
}

function normalizeLoosely(line: string): string {
  return line.replace(/\r$/, '').trim()
}

/** 以 oldText 前若干条有辨识度的行做锚，找出与 oldText 逐行最相似的对齐起点。 */
function bestCandidateStart(fileLines: readonly string[], needleLines: readonly string[]): Optional<number> {
  const distinctive = needleLines
    .map((line, index) => ({ index, text: normalizeLoosely(line) }))
    .filter((anchor) => !isBlank(anchor.text))
  const anchors = (distinctive.some((anchor) => anchor.text.length >= 4)
    ? distinctive.filter((anchor) => anchor.text.length >= 4)
    : distinctive).slice(0, MaxAnchorLines)
  const starts = new Set<number>()
  for (const anchor of anchors) {
    for (const [fileIndex, fileLine] of fileLines.entries()) {
      if (starts.size >= MaxCandidateStarts) break
      if (fileIndex >= anchor.index && fileLine.includes(anchor.text)) starts.add(fileIndex - anchor.index)
    }
  }
  const looseFileLines = fileLines.map(normalizeLoosely)
  let best: Optional<{ start: number; score: number }>
  for (const start of starts) {
    const score = needleLines.filter((line, index) =>
      alignedEqual(normalizeLoosely(line), looseFileLines[start + index], index, needleLines.length)
    ).length
    if (!best || score > best.score || (score === best.score && start < best.start)) best = { start, score }
  }
  return best?.start
}

function mismatchCauses(expected: string, actual: string, index: number, count: number): TextMismatchCause[] {
  const equalUnder = (steps: typeof MismatchNormalizers) => {
    const normalize = (line: string) => steps.reduce((value, [, step]) => step(value), line)
    return alignedEqual(normalize(expected), normalize(actual), index, count)
  }
  for (let depth = 1; depth <= MismatchNormalizers.length; depth += 1) {
    const steps = MismatchNormalizers.slice(0, depth)
    if (!equalUnder(steps)) continue
    return steps
      .filter((step) => !equalUnder(steps.filter((other) => other !== step)))
      .map(([cause]) => cause)
  }
  return ['content']
}

function describeIndent(line: string): string {
  const indent = /^[ \t]*/.exec(line)?.[0] ?? ''
  const spaces = indent.replace(/\t/g, '').length
  const tabs = indent.length - spaces
  if (isEmpty(indent)) return '无缩进'
  return [tabs > 0 ? `${tabs} 个制表符` : '', spaces > 0 ? `${spaces} 个空格` : ''].filter((part) => !isEmpty(part)).join('+')
}

function countBackslashes(line: string): number {
  return line.match(/\\/g)?.length ?? 0
}

function causePhrase(cause: TextMismatchCause, expected: string, actual: Nullable<string>): string {
  switch (cause) {
    case 'line_ending':
      return '换行符不同（CRLF 与 LF，或该区域换行符混用）'
    case 'trailing_whitespace':
      return '行尾空白不同'
    case 'indentation':
      return `缩进不同（oldText：${describeIndent(expected)}，文件：${describeIndent(actual ?? '')}）`
    case 'backslash_escape':
      return `反斜杠数量不同（oldText 该行 ${countBackslashes(expected)} 个，文件 ${countBackslashes(actual ?? '')} 个；多半是转义多了或少了一层）`
    case 'quote_style':
      return '引号字符不同'
    case 'content':
      return '该行内容与文件不同（文件可能已变化，或 oldText 凭记忆拼写有误）'
    case 'end_of_file':
      return '文件在该行之前已结束（oldText 比候选位置之后的文件内容更长）'
    case 'absent':
      return 'oldText 的任何非空行都不在文件中（路径可能不对，或内容已被改写）'
  }
}

/** 超长行只截取首个差异附近的窗口，保证单条线索有界。 */
function excerptAround(line: string, focus: number): string {
  if (line.length <= ExcerptChars) return line
  const start = Math.max(0, Math.min(focus - ExcerptChars / 2, line.length - ExcerptChars))
  return `${start > 0 ? '…' : ''}${line.slice(start, start + ExcerptChars)}${start + ExcerptChars < line.length ? '…' : ''}`
}

function firstDifference(expected: string, actual: string): number {
  const left = expected.trimStart()
  const right = actual.trimStart()
  let index = 0
  while (index < left.length && index < right.length && left[index] === right[index]) index += 1
  return index
}

/**
 * 解释 oldText 为何在文件中 0 匹配。行比较沿用精确匹配已有的换行符适配：文件是 CRLF 而
 * oldText 只含 LF 时，精确匹配会自动转换，所以这里比较前先去掉文件行尾的 \r，避免把真正
 * 的分歧误报成换行符差异。
 */
export function diagnoseTextMatchMiss(content: string, needle: string): TextMatchMissDiagnosis {
  const autoCrlf = content.includes('\r\n') && !needle.includes('\r')
  const fileLines = content.split('\n').map((line) => autoCrlf ? line.replace(/\r$/, '') : line)
  const needleLines = needle.split('\n')
  const start = bestCandidateStart(fileLines, needleLines)
  if (!isPresent(start)) return {
    oldTextLines: needleLines.length,
    causes: ['absent'],
    hint: `${causePhrase('absent', needle, null)}；请确认 path，并重新读取目标区域后按原文复制。`,
  }

  const mismatchIndex = needleLines.findIndex((line, index) =>
    !alignedEqual(line, fileLines[start + index], index, needleLines.length)
  )
  if (mismatchIndex === -1) return {
    candidateLine: start + 1,
    matchedLines: needleLines.length,
    oldTextLines: needleLines.length,
    causes: ['line_ending'],
    hint: `${causePhrase('line_ending', needle, null)}；请只用单行锚点定位，或先统一该文件的换行符。`,
  }

  const expected = needleLines[mismatchIndex]
  const actual = toNullable(fileLines[start + mismatchIndex])
  const causes = isPresent(actual)
    ? mismatchCauses(expected, actual, mismatchIndex, needleLines.length)
    : ['end_of_file' as const]
  const focus = isPresent(actual) ? firstDifference(expected, actual) : 0
  const indent = (line: string) => line.length - line.trimStart().length
  return {
    candidateLine: start + 1,
    matchedLines: mismatchIndex,
    oldTextLines: needleLines.length,
    firstMismatch: {
      oldTextLine: mismatchIndex + 1,
      fileLine: start + mismatchIndex + 1,
      expected: excerptAround(expected, indent(expected) + focus),
      actual: isPresent(actual) ? excerptAround(actual, indent(actual) + focus) : null,
    },
    causes,
    hint: `${causes.map((cause) => causePhrase(cause, expected, actual)).join('；')}。`,
  }
}

/** 供错误消息使用的一句话摘要：宿主可能只把 message 转给模型，关键定位必须也在这里。 */
export function summarizeTextMatchMiss(diagnosis: TextMatchMissDiagnosis): string {
  const mismatch = diagnosis.firstMismatch
  if (!isPresent(diagnosis.candidateLine)) return diagnosis.hint
  if (!mismatch) return `最接近位置从文件第 ${diagnosis.candidateLine} 行开始；${diagnosis.hint}`
  // JSON 字符串形式正是模型写进工具参数时应有的转义，反斜杠与不可见的 \r 都一目了然。
  const actual = isPresent(mismatch.actual) ? JSON.stringify(mismatch.actual) : '（文件已结束）'
  return `最接近位置从文件第 ${diagnosis.candidateLine} 行开始，oldText 前 ${diagnosis.matchedLines} 行一致，`
    + `第 ${mismatch.oldTextLine} 行（文件第 ${mismatch.fileLine} 行）出现分歧：${diagnosis.hint}`
    + `oldText 该行为 ${JSON.stringify(mismatch.expected)}，文件原文为 ${actual}。`
}

/** 给出可直接执行的下一步：读哪几行、改 oldText 的哪一行。 */
export function textMatchMissNextAction(diagnosis: TextMatchMissDiagnosis): string {
  const mismatch = diagnosis.firstMismatch
  if (!isPresent(diagnosis.candidateLine))
    return '请重新读取目标区域并按原文复制 oldText；不要凭记忆重拼长段文本，只保留能唯一定位的 3–5 行。'
  const focusLine = mismatch?.fileLine ?? diagnosis.candidateLine
  const fromLine = Math.max(1, focusLine - 3)
  const target = mismatch ? `把 oldText 第 ${mismatch.oldTextLine} 行改成文件原文` : '按文件原文修正 oldText'
  return `用 project:read 读取第 ${fromLine}–${focusLine + 3} 行，${target}后重试；也可缩短 oldText，只保留能唯一定位的 3–5 行。`
}

/**
 * 行尾空白与换行符（CRLF/LF）差异是纯排版噪声：忽略它们后在全文唯一命中的位置可以安全替换。
 * 缩进不在宽容范围内——YAML、Python 等语言里缩进就是语义。
 */
export function findLineWhitespaceTolerantMatches(
  content: string,
  needle: string,
  limit: number,
): Array<{ index: number; text: string }> {
  if (isBlank(needle)) return []
  const pattern = needle
    .split('\n')
    .map((line) => line.replace(/[ \t\r]+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[ \\t]*\\r?\\n')
  const matches: Array<{ index: number; text: string }> = []
  for (const match of content.matchAll(new RegExp(pattern, 'g'))) {
    matches.push({ index: match.index, text: match[0] })
    if (matches.length >= limit) break
  }
  return matches
}

/** 把匹配 offset 投影成有上限的行号列表，并附带所属外层行帮助区分同形文本。 */
export function locateTextMatches(content: string, indices: readonly number[]): TextMatchLocation[] {
  const lines = content.split('\n')
  return indices.slice(0, MaxReportedMatches).map((offset, position) => {
    const line = offsetToLine(content, offset)
    return { occurrence: position + 1, line, within: enclosingLine(lines, line - 1) }
  })
}

function enclosingLine(lines: readonly string[], lineIndex: number): Optional<string> {
  const indentOf = (line: string) => line.length - line.trimStart().length
  const indent = indentOf(lines[lineIndex] ?? '')
  if (indent === 0) return undefined
  for (let index = lineIndex - 1; index >= Math.max(0, lineIndex - MaxEnclosingLookbackLines); index -= 1) {
    const line = lines[index]
    if (!isBlank(line) && indentOf(line) < indent) return truncate(line.trim(), 100)
  }
  return undefined
}

/** 行号列表的文字形式，超出上限时注明省略数量。 */
export function describeMatchLines(locations: readonly TextMatchLocation[], total: number): string {
  const listed = locations.map((location) => location.line).join('、')
  return total > locations.length ? `第 ${listed} 行等 ${total} 处` : `第 ${listed} 行`
}
