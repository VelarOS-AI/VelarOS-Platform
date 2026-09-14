import { isEmpty } from '@velaros-ai/core'

import { diagnoseTextMatchMiss, findLineWhitespaceTolerantMatches } from '../../edits/text-match-feedback.js'
import type { ProjectEditView } from '../types.js'

import type { OffsetWindow } from './coverage.js'
import type { ProjectSourceCoordinates } from './source.js'

const CandidateLimit = 8
const CandidateTextLimit = 1200
const ContextLimit = 120
const DiagnosisBudget = 16_000

export interface ProjectMatchCandidate {
  range: readonly [number, number]
  startOffset: number
  endOffset: number
  text: string
  truncated: boolean
  match?: string
  prefix?: string
  suffix?: string
  differences?: readonly string[]
  confidence: 'exact' | 'whitespace' | 'similar'
}

function boundedText(text: string): { text: string; truncated: boolean } {
  let end = Math.min(text.length, CandidateTextLimit)
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end -= 1
  return { text: text.slice(0, end), truncated: end < text.length }
}

/** 建议的 match 包含未改动上下文；替换文本需要同时保留这些前缀和后缀。 */
function distinguishingMatch(source: ProjectSourceCoordinates, window: OffsetWindow, windows: readonly OffsetWindow[], start: number, end: number) {
  if (end - start > CandidateTextLimit) return {}
  const unique = (from: number, to: number) => {
    const value = source.content.slice(from, to).replace(/\r\n/g, '\n')
    if (isEmpty(value)) return false
    const rangeStart = source.lines[source.lineAt(from) - 1].start
    const rangeEnd = source.lines[source.lineAt(Math.max(from, to - 1)) - 1].end
    let count = 0
    for (const visible of windows) {
      const left = Math.max(visible.start, rangeStart)
      const right = Math.min(visible.end, rangeEnd)
      if (right <= left) continue
      const begin = source.logicalOffset(left)
      const until = source.logicalOffset(right)
      for (let at = source.logical.indexOf(value, begin); at !== -1 && at + value.length <= until; at = source.logical.indexOf(value, at + 1)) {
        count += 1
        if (count > 1) return false
      }
    }
    return count === 1
  }
  const suggestion = (from: number, to: number) => ({
    match: source.content.slice(from, to), prefix: source.content.slice(from, start), suffix: source.content.slice(end, to),
    range: [source.lineAt(from), source.lineAt(Math.max(from, to - 1))] as const,
  })
  if (unique(start, end)) return suggestion(start, end)
  for (let extra = 1; extra <= ContextLimit; extra += 1) {
    // 优先尝试单侧上下文，再尝试两侧均衡窗口；搜索开销不随文件大小无限增长。
    for (const left of [extra, 0, Math.floor(extra / 2)]) {
      let from = Math.max(window.start, start - left)
      let to = Math.min(window.end, end + extra - left)
      if (from > window.start && (/[\uDC00-\uDFFF]/.test(source.content[from]) || (source.content[from] === '\n' && source.content[from - 1] === '\r'))) from -= 1
      if (to < window.end && (/[\uD800-\uDBFF]/.test(source.content[to - 1]) || (source.content[to - 1] === '\r' && source.content[to] === '\n'))) to += 1
      if (unique(from, to)) return suggestion(from, to)
    }
  }
  return {}
}

export function matchCandidate(
  source: ProjectSourceCoordinates,
  window: OffsetWindow,
  windows: readonly OffsetWindow[],
  start: number,
  end: number,
  confidence: ProjectMatchCandidate['confidence'],
  differences?: readonly string[],
): ProjectMatchCandidate {
  return {
    range: [source.lineAt(start), source.lineAt(Math.max(start, end - 1))], startOffset: start, endOffset: end,
    ...boundedText(source.content.slice(start, end)),
    ...distinguishingMatch(source, window, windows, start, end),
    confidence, differences,
  }
}

export function exactMatchCandidates(source: ProjectSourceCoordinates, windows: readonly OffsetWindow[], matches: readonly OffsetWindow[]): ProjectMatchCandidate[] {
  return matches.slice(0, CandidateLimit).map((match) => matchCandidate(source,
    windows.find((window) => window.start <= match.start && window.end >= match.end)!, windows, match.start, match.end, 'exact'))
}

/** Suggestions never authorize or apply a fuzzy edit. Only displayed windows are examined. */
export function missingMatchCandidates(view: ProjectEditView, source: ProjectSourceCoordinates, windows: readonly OffsetWindow[], match: string): ProjectMatchCandidate[] {
  const candidates: ProjectMatchCandidate[] = []
  if (match.length > DiagnosisBudget) return candidates
  let remaining = DiagnosisBudget
  for (const window of windows) {
    if (remaining <= 0 || candidates.length >= CandidateLimit) break
    let end = Math.min(window.end, window.start + remaining)
    if (end < window.end && (/[\uD800-\uDBFF]/.test(view.content[end - 1]) || (view.content[end - 1] === '\r' && view.content[end] === '\n'))) end -= 1
    const content = view.content.slice(window.start, end)
    remaining -= content.length
    for (const candidate of findLineWhitespaceTolerantMatches(content, match, CandidateLimit - candidates.length)) {
      const start = window.start + candidate.index
      candidates.push(matchCandidate(source, window, windows, start, start + candidate.text.length, 'whitespace', ['trailing_whitespace']))
    }
    if (!isEmpty(candidates)) continue
    const diagnosis = diagnoseTextMatchMiss(content, match)
    if (!diagnosis.candidateLine) continue
    const local = content.split('\n')
    const start = window.start + local.slice(0, diagnosis.candidateLine - 1).reduce((count, line) => count + line.length + 1, 0)
    const candidateEnd = Math.min(end, start + local.slice(diagnosis.candidateLine - 1, diagnosis.candidateLine - 1 + diagnosis.oldTextLines).join('\n').length)
    candidates.push(matchCandidate(source, window, windows, start, candidateEnd, 'similar', diagnosis.causes))
  }
  return candidates
}
