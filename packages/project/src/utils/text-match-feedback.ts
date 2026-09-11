// 域：文本锚点匹配失败时给模型的定位线索。
//
// 模型凭记忆拼写数千字符的 oldText 时，最常见的失败是某一行差一个空格或一个反斜杠；
// 只回复「找到 0 个」会迫使它整段重读再盲猜。这里给出有界的最佳候选位置、首个分歧行及
// 可识别的差异原因，并统一行尾空白/换行符宽容匹配的判定。所有输出都有上限：候选数、
// 展示的匹配数与摘录长度都被截断，绝不把整文件塞回上下文。
//
// 宽容匹配与分歧定位共用同一口径（忽略行尾空白与 \r，且被忽略的空白必须真的位于行尾）：
// 系统会自动放过的差异不能被报告成「第一处分歧」，否则模型会去修一行根本不用修的内容。
import { isBlank, isEmpty, isPresent, toNullable, truncate, unique } from '@velaros-ai/core'

import { offsetToLine } from './text.js'

const MaxCandidateStarts = 200
const MaxFuzzyAnchors = 8
const MinFuzzyAnchorChars = 4
const MinFragmentSimilarity = 0.75
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
  /** oldText 在文件中最接近的对齐起始行（1-based）；连相近的行都找不到时缺省。 */
  candidateLine?: number
  /** 候选位置从 oldText 第 1 行起、忽略行尾空白与换行符后连续一致的行数。 */
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
  /** 首个分歧之前各行存在、但宽容匹配会自动忽略的差异（行尾空白、换行符），无需修正。 */
  tolerated?: TextMismatchCause[]
  hint: string
}

export interface TextMatchLocation {
  occurrence: number
  line: number
  /** 匹配所在行之上最近的外层（缩进更浅的）行，用来区分同形文本分别属于哪个块。 */
  within?: string
}

// 差异归因按「逐级放宽」的顺序定义；只报告让两行相等所必需的那几级。
// 前两级正是宽容匹配的口径，前三级是忽略缩进的宽松口径，全部五级用于找候选位置。
const MismatchNormalizers: ReadonlyArray<readonly [TextMismatchCause, (line: string) => string]> = [
  ['line_ending', (line) => line.replace(/\r$/, '')],
  ['trailing_whitespace', (line) => line.replace(/[ \t]+$/, '')],
  ['indentation', (line) => line.replace(/^[ \t]+/, '')],
  ['backslash_escape', (line) => line.replace(/\\+/g, '\\')],
  ['quote_style', (line) => line.replace(/[“”‘’'"`]/g, '"')],
]
const TolerantSteps = MismatchNormalizers.slice(0, 2)
const LooseSteps = MismatchNormalizers.slice(0, 3)

function normalizeWith(steps: typeof MismatchNormalizers, line: string): string {
  return steps.reduce((value, [, step]) => step(value), line)
}

function trimLineEnd(line: string): string {
  return line.replace(/[ \t\r]+$/, '')
}

function trailingBlankLength(line: string): number {
  return line.length - trimLineEnd(line).length
}

/**
 * oldText 可以从行中间开始、在行中间结束：首行只要求是文件行的后缀，末行只要求是前缀，
 * 单行 oldText 只要求被包含，中间行必须整行相等。endAnchored 表示 expected 的行尾空白已被
 * 规范化去掉：去掉的空白只有位于行尾才算「行尾空白」，所以末行与单行也必须对齐到文件行尾，
 * 否则 'const x ' 会前缀命中 'const xyz'。
 */
function alignedEqual(expected: string, actual: Optional<string>, index: number, count: number, endAnchored = false): boolean {
  if (!isPresent(actual)) return false
  if (index === 0) return count === 1 && !endAnchored ? actual.includes(expected) : actual.endsWith(expected)
  if (index === count - 1 && !endAnchored) return actual.startsWith(expected)
  return actual === expected
}

/**
 * 在给定口径下比较对齐的两行。口径去掉的末尾空白有两种读法：落在文件行尾时是行尾空白，按口径
 * 忽略；后面还跟着文件内容时（oldText 停在 `const x = ` 这类行中间）它就是正文，只能逐字比较。
 * 只有末行（含单行）可能停在行中间，其余各行必然到达文件行尾。两种读法都保证口径只会放宽
 * 不会收紧：原文逐字一致的行在任何口径下都一致，差异归因因此总能找到必要的那一级。
 */
function equalUnder(
  steps: typeof MismatchNormalizers,
  expected: string,
  actual: Optional<string>,
  index: number,
  count: number,
): boolean {
  if (!isPresent(actual)) return false
  const normalized = normalizeWith(steps, expected)
  const stripped = trailingBlankLength(normalized) < trailingBlankLength(expected)
  if (alignedEqual(normalized, normalizeWith(steps, actual), index, count, stripped)) return true
  if (!stripped || index !== count - 1) return false
  const bodySteps = steps.filter(([cause]) => cause !== 'line_ending' && cause !== 'trailing_whitespace')
  return alignedEqual(normalizeWith(bodySteps, expected), normalizeWith(bodySteps, actual), index, count)
}

interface CandidateStart {
  start: number
  /** 产生该起点的锚的相似度；精确对齐的锚为 1。 */
  similarity: number
}

/**
 * 每条非空 oldText 行都是一个锚，在全口径（忽略缩进、行尾空白、反斜杠层数与引号）下找对齐位置：
 * 中间行查整行索引，首/末行按后缀/前缀扫描。稀有的锚先占名额，避免 `}`、`return null;` 这类
 * 高频行把上限吃光、挤掉真正有辨识度的锚。
 */
function alignedAnchorStarts(file: readonly string[], needle: readonly string[]): CandidateStart[] {
  const count = needle.length
  const lineIndex = new Map<string, number[]>()
  for (const [fileIndex, line] of file.entries()) {
    const indices = lineIndex.get(line)
    if (indices) indices.push(fileIndex)
    else lineIndex.set(line, [fileIndex])
  }
  const hitsOf = (anchor: string, index: number) => index > 0 && index < count - 1
    ? lineIndex.get(anchor) ?? []
    : file.flatMap((line, fileIndex) => alignedEqual(anchor, line, index, count) ? [fileIndex] : [])
  const starts = needle
    .map((anchor, index) => ({ index, hits: isBlank(anchor) ? [] : hitsOf(anchor, index).filter((hit) => hit >= index) }))
    .sort((left, right) => left.hits.length - right.hits.length)
    .flatMap(({ index, hits }) => hits.map((hit) => hit - index))
  return [...new Set(starts)].slice(0, MaxCandidateStarts).map((start) => ({ start, similarity: 1 }))
}

function bigramCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (let index = 0; index < text.length - 1; index += 1) {
    const gram = text.slice(index, index + 2)
    counts.set(gram, (counts.get(gram) ?? 0) + 1)
  }
  return counts
}

/**
 * anchor 的字符二元组有多大比例（按次数配对）出现在文件行里。文件行远长于 anchor 时按长度折减，
 * 否则压缩代码这类超长行会凭字符堆积冒充候选。
 */
function fragmentSimilarity(anchorGrams: ReadonlyMap<string, number>, anchorLength: number, line: string): number {
  const remaining = new Map(anchorGrams)
  let shared = 0
  for (let index = 0; index < line.length - 1; index += 1) {
    const gram = line.slice(index, index + 2)
    const left = remaining.get(gram) ?? 0
    if (left === 0) continue
    remaining.set(gram, left - 1)
    shared += 1
  }
  return (shared / (anchorLength - 1)) * Math.min(1, (2 * anchorLength) / Math.max(1, line.length))
}

/** 没有任何锚能对齐时（最常见的是单行 oldText 里的错字），用最长的几条 oldText 行找相似的文件行。 */
function fuzzyAnchorStarts(file: readonly string[], needle: readonly string[]): CandidateStart[] {
  const anchors = needle
    .map((text, index) => ({ text, index }))
    .filter((anchor) => anchor.text.length >= MinFuzzyAnchorChars)
    .sort((left, right) => right.text.length - left.text.length)
    .slice(0, MaxFuzzyAnchors)
  const best = new Map<number, number>()
  for (const anchor of anchors) {
    const grams = bigramCounts(anchor.text)
    for (const [fileIndex, line] of file.entries()) {
      if (fileIndex < anchor.index) continue
      const similarity = fragmentSimilarity(grams, anchor.text.length, line)
      const start = fileIndex - anchor.index
      if (similarity >= MinFragmentSimilarity && similarity > (best.get(start) ?? 0)) best.set(start, similarity)
    }
  }
  return [...best]
    .map(([start, similarity]) => ({ start, similarity }))
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, MaxCandidateStarts)
}

/** 排名逐项比较：第一处不同的分量更大者胜出。 */
function outranks(left: readonly number[], right: readonly number[]): boolean {
  const index = left.findIndex((value, position) => value !== right[position])
  return index !== -1 && left[index] > right[index]
}

/**
 * 找 oldText 在文件中最可能对应的对齐起点：先取全口径下对齐的锚，全部落空再退到片段相似度；
 * 然后按「全口径一致行数 → 仅忽略空白时一致行数 → 锚相似度 → 位置靠前」择优。
 */
function bestCandidateStart(fileLines: readonly string[], needleLines: readonly string[]): Optional<number> {
  const semanticFile = fileLines.map((line) => normalizeWith(MismatchNormalizers, line))
  const semanticNeedle = needleLines.map((line) => normalizeWith(MismatchNormalizers, line))
  const looseFile = fileLines.map((line) => normalizeWith(LooseSteps, line))
  const looseNeedle = needleLines.map((line) => normalizeWith(LooseSteps, line))
  const alignedLines = (needle: readonly string[], file: readonly string[], start: number) =>
    needle.filter((line, index) => alignedEqual(line, file[start + index], index, needle.length)).length
  const aligned = alignedAnchorStarts(semanticFile, semanticNeedle)
  const candidates = isEmpty(aligned) ? fuzzyAnchorStarts(semanticFile, semanticNeedle) : aligned
  let best: Optional<{ start: number; rank: number[] }>
  for (const { start, similarity } of [...candidates].sort((left, right) => left.start - right.start)) {
    const rank = [alignedLines(semanticNeedle, semanticFile, start), alignedLines(looseNeedle, looseFile, start), similarity]
    if (!best || outranks(rank, best.rank)) best = { start, rank }
  }
  return best?.start
}

/**
 * 调用方只传原文不一致的行。首个让两行相等的放宽层级里，最后加入的那一级必然必要：去掉它
 * 就退回上一层级（或原文比较），而那里两行不相等，所以返回值不会为空。
 */
function mismatchCauses(expected: string, actual: string, index: number, count: number): TextMismatchCause[] {
  for (let depth = 1; depth <= MismatchNormalizers.length; depth += 1) {
    const steps = MismatchNormalizers.slice(0, depth)
    if (!equalUnder(steps, expected, actual, index, count)) continue
    return steps
      .filter((step) => !equalUnder(steps.filter((other) => other !== step), expected, actual, index, count))
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
      return 'oldText 的任何非空行都不在文件中（忽略缩进、行尾空白、反斜杠层数与引号后仍对不上，也没有相近的行；路径可能不对，或内容已被改写）'
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
  const count = needleLines.length
  const start = bestCandidateStart(fileLines, needleLines)
  if (!isPresent(start)) return {
    oldTextLines: count,
    causes: ['absent'],
    hint: `${causePhrase('absent', needle, null)}；请确认 path，并重新读取目标区域后按原文复制。`,
  }

  const toleratedBefore = (lineCount: number) => unique(needleLines.slice(0, lineCount).flatMap((line, index) =>
    alignedEqual(line, fileLines[start + index], index, count) ? [] : mismatchCauses(line, fileLines[start + index], index, count)
  ))
  // 宽容口径下仍不相等的第一行才是模型需要修正的分歧。
  const mismatchIndex = needleLines.findIndex((line, index) => !equalUnder(TolerantSteps, line, fileLines[start + index], index, count))
  if (mismatchIndex === -1) {
    const tolerated = toleratedBefore(count)
    const causes = isEmpty(tolerated) ? ['line_ending' as const] : tolerated
    return {
      candidateLine: start + 1,
      matchedLines: count,
      oldTextLines: count,
      causes,
      hint: `${causes.map((cause) => causePhrase(cause, needle, null)).join('；')}；请按文件原文复制 oldText，或只用单行锚点定位。`,
    }
  }

  const expected = needleLines[mismatchIndex]
  const actual = toNullable(fileLines[start + mismatchIndex])
  const causes = isPresent(actual)
    ? mismatchCauses(expected, actual, mismatchIndex, count)
    : ['end_of_file' as const]
  const tolerated = toleratedBefore(mismatchIndex)
  const focus = isPresent(actual) ? firstDifference(expected, actual) : 0
  const indent = (line: string) => line.length - line.trimStart().length
  return {
    candidateLine: start + 1,
    matchedLines: mismatchIndex,
    oldTextLines: count,
    firstMismatch: {
      oldTextLine: mismatchIndex + 1,
      fileLine: start + mismatchIndex + 1,
      expected: excerptAround(expected, indent(expected) + focus),
      actual: isPresent(actual) ? excerptAround(actual, indent(actual) + focus) : null,
    },
    causes,
    ...(isEmpty(tolerated) ? {} : { tolerated }),
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
  const tolerated = isPresent(diagnosis.tolerated) ? '（其间的行尾空白/换行符差异会被自动宽容，无需修正）' : ''
  return `最接近位置从文件第 ${diagnosis.candidateLine} 行开始，oldText 前 ${diagnosis.matchedLines} 行一致${tolerated}，`
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
 * 口径与 equalUnder(TolerantSteps) 一致：末行末尾的空白要么落在文件行尾、按行尾空白忽略，
 * 要么后面还有内容、按原文逐字匹配，绝不让 'const x ' 命中 'const xyz'。
 * 缩进不在宽容范围内——YAML、Python 等语言里缩进就是语义。
 */
export function findLineWhitespaceTolerantMatches(
  content: string,
  needle: string,
  limit: number,
): Array<{ index: number; text: string }> {
  if (isBlank(needle)) return []
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const lines = needle.split('\n')
  const lastLine = lines[lines.length - 1]
  const lastBody = trimLineEnd(lastLine)
  const lastTail = lastBody === lastLine
    ? ''
    : `(?:[ \\t]*(?=\\r?\\n|$)|${escape(lastLine.slice(lastBody.length))})`
  const pattern = lines.map((line) => escape(trimLineEnd(line))).join('[ \\t]*\\r?\\n') + lastTail
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
