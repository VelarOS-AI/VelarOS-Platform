// 域：文本锚点操作（replace_text、insert_text_at_anchor、delete_text）到底改哪几处匹配。
// occurrence、replaceAll、expectedMatches 的语义在这里统一判定；零命中时给出带定位线索的失败，而不是只报「找到 0 个」。
import { isEmpty, isPresent, isTrue, optionalWhen } from '@velaros-ai/core'

import type { PatchStrategyInput } from '../../types/patch.js'
import type { SelectedTextMatches, TextMatchSelectionOperation } from '../../types/strategies.js'
import { ProjectError } from '../errors.js'
import { offsetToLine, resolveLineEndingAwareTextMatch } from '../text.js'

import {
  describeMatchLines,
  diagnoseTextMatchMiss,
  findLineWhitespaceTolerantMatches,
  locateTextMatches,
  summarizeTextMatchMiss,
  textMatchMissNextAction,
} from './text-match-feedback.js'

/** 片段在正文里每一处出现的起点，按出现顺序、互不重叠。 */
function allMatchIndices(content: string, needle: string): number[] {
  const indices: number[] = []
  let from = 0
  while (true) {
    const index = content.indexOf(needle, from)
    if (index === -1) return indices
    indices.push(index)
    from = index + Math.max(1, needle.length)
  }
}

/**
 * 精确匹配为 0 时的唯一出路：忽略行尾空白与换行符后全文唯一、且与断言/occurrence 相容才宽容应用；
 * 否则抛出带最佳候选与首个分歧行的定位线索，让模型只修正出错的那一行。
 */
function selectMissingTextMatch(
  content: string,
  needle: string,
  replacementText: Optional<string>,
  operationName: string,
  expected: Optional<number>,
  occurrence: Optional<number>,
): SelectedTextMatches {
  const tolerant = findLineWhitespaceTolerantMatches(content, needle, 2)
  if (tolerant.length === 1 && (expected ?? 1) === 1 && (occurrence ?? 1) === 1) {
    const [match] = tolerant
    return {
      indices: [match.index],
      matchedText: match.text,
      // 换行符差异被宽容时 newText 的换行符不可信：先统一成 LF，再由调用方按被替换区域适配。
      replacementText: replacementText?.replace(/\r\n/g, '\n'),
      totalMatches: 1,
      matchNote: `${operationName} 的文本与文件第 ${offsetToLine(content, match.index)} 行起的内容仅在行尾空白或换行符（CRLF/LF）上不同；忽略这些差异后全文唯一，已按该位置修改。`,
    }
  }
  const diagnosis = diagnoseTextMatchMiss(content, needle)
  const tolerantLocations = locateTextMatches(
    content,
    tolerant.map((match) => match.index),
  )
  const tolerantClue = isEmpty(tolerant)
    ? ''
    : `忽略行尾空白与换行符差异后可在${describeMatchLines(tolerantLocations, tolerant.length)}命中，但不唯一或与断言/occurrence 不符，未自动应用。`
  const headline = isPresent(expected)
    ? `${operationName} 断言 ${expected} 个匹配，实际找到 0 个`
    : `${operationName} 未找到匹配文本`
  throw new ProjectError(
    'TARGET_NOT_FOUND',
    `${headline}。${summarizeTextMatchMiss(diagnosis)}${tolerantClue}`,
    {
      expected: expected ?? 1,
      actual: 0,
      ...diagnosis,
      whitespaceTolerantMatches: optionalWhen(!isEmpty(tolerant), tolerantLocations),
    },
    textMatchMissNextAction(diagnosis),
  )
}

/**
 * 选出文本锚点操作要改的匹配：按 occurrence 选一处、replaceAll 全改，或要求恰好一处；expectedMatches 只断言总数。
 * 换行符按文件适配后再匹配；选不出时抛出列着各处行号的歧义或越界错误。
 */
export function selectTextMatches(
  input: PatchStrategyInput,
  operation: TextMatchSelectionOperation,
  content: string,
  needle: string,
  replacementText: Optional<string>,
  operationName: string,
): SelectedTextMatches {
  if (isPresent(operation.occurrence) && isTrue(operation.replaceAll)) {
    throw new ProjectError(
      'INVALID_INPUT',
      `${operationName} 的 occurrence 与 replaceAll 不能同时使用`,
      { occurrence: operation.occurrence, replaceAll: operation.replaceAll },
      '请只选择一个匹配位置，或明确修改全部匹配。',
    )
  }

  const found = resolveLineEndingAwareTextMatch(content, needle, replacementText)
  const expected =
    operation.expectedMatches ??
    input.intent.constraints?.expectedMatches ??
    input.target?.expectedMatches
  if (found.count === 0)
    return selectMissingTextMatch(
      content,
      needle,
      replacementText,
      operationName,
      expected,
      operation.occurrence,
    )

  const indices = allMatchIndices(content, found.matchedText)
  // 行号定位只在失败分支计算：成功路径不为诊断多扫一遍文件。
  const ambiguity = () => {
    const matches = locateTextMatches(content, indices)
    return { matches, lines: describeMatchLines(matches, indices.length) }
  }
  if (isPresent(expected) && found.count !== expected) {
    const { matches, lines } = ambiguity()
    throw new ProjectError(
      'AMBIGUOUS_TARGET',
      `${operationName} 断言 ${expected} 个匹配，实际找到 ${found.count} 个（${lines}）`,
      { expected, actual: found.count, matches },
      `expectedMatches 只断言文件中的匹配总数，不选择位置。只改其中一处：把 expectedMatches 改为 ${found.count}（或省略）并用 occurrence（1–${found.count}，按上述行号顺序）选择；全部修改：replaceAll=true；也可加长文本使其唯一。`,
    )
  }
  if (isPresent(operation.occurrence)) {
    if (
      !Number.isInteger(operation.occurrence) ||
      operation.occurrence < 1 ||
      operation.occurrence > indices.length
    ) {
      const { matches, lines } = ambiguity()
      throw new ProjectError(
        'TARGET_NOT_FOUND',
        `${operationName} 的 occurrence=${operation.occurrence} 超出 ${indices.length} 个匹配（${lines}）`,
        { occurrence: operation.occurrence, actual: indices.length, matches },
        `occurrence 按文件中出现顺序从 1 计数，请在 1–${indices.length} 之间选择。`,
      )
    }
    return {
      indices: [indices[operation.occurrence - 1]],
      matchedText: found.matchedText,
      replacementText: found.replacementText,
      totalMatches: found.count,
    }
  }
  if (isTrue(operation.replaceAll))
    return {
      indices,
      matchedText: found.matchedText,
      replacementText: found.replacementText,
      totalMatches: found.count,
    }
  if (found.count !== 1) {
    const { matches, lines } = ambiguity()
    throw new ProjectError(
      'AMBIGUOUS_TARGET',
      `${operationName} 找到 ${found.count} 个匹配（${lines}），但未指定 occurrence 或 replaceAll`,
      { expected: expected ?? 1, actual: found.count, matches },
      `请用 occurrence（1–${found.count}，按上述行号顺序）选择一个匹配，或传 replaceAll=true 修改全部匹配。`,
    )
  }
  return {
    indices: [indices[0]],
    matchedText: found.matchedText,
    replacementText: found.replacementText,
    totalMatches: found.count,
  }
}

/**
 * 新文本的换行符跟随被替换的区域，区域不跨行时才跟随整个文件：混用换行符的文件里，
 * LF 区域不会被写入 CRLF，CRLF 区域也不会混入 LF。
 */
export function lineEndingReference(content: string, matchedText: string): string {
  return matchedText.includes('\n') ? matchedText : content
}

/** 从后往前把选中的每处匹配换成替换文本，前面的偏移不受影响。 */
export function replaceSelectedMatches(
  content: string,
  indices: readonly number[],
  matchedText: string,
  replacementText: string,
): string {
  let next = content
  for (const index of [...indices].reverse()) {
    next = next.slice(0, index) + replacementText + next.slice(index + matchedText.length)
  }
  return next
}
