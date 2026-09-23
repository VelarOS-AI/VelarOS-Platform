// 域：edit 的 match 零命中或多处命中时给模型的候选。只在 fileRef 显示过的窗口里找，候选只供确认，不会被自动应用。
import { isEmpty } from '@velaros-ai/core'

import type {
  OffsetWindow,
  ProjectEditView,
  ProjectMatchCandidate,
  ProjectMatchElsewhere,
  ProjectSourceCoordinates,
} from '../../types/editing.js'
import { ProjectTuning } from '../tuning.js'

import { logicalSourceOffset, physicalSourceOffset, sourceLineAt } from './source.js'
import { diagnoseTextMatchMiss, findLineWhitespaceTolerantMatches } from './text-match-feedback.js'

/** 候选原文按字符上限截断，不把代理对切成两半。 */
function boundedText(text: string): { text: string; truncated: boolean } {
  let end = Math.min(text.length, ProjectTuning.editing.candidateChars)
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end -= 1
  return { text: text.slice(0, end), truncated: end < text.length }
}

/** 建议的 match 包含未改动上下文；替换文本需要同时保留这些前缀和后缀。 */
function distinguishingMatch(
  source: ProjectSourceCoordinates,
  window: OffsetWindow,
  windows: readonly OffsetWindow[],
  start: number,
  end: number
) {
  if (end - start > ProjectTuning.editing.candidateChars) return {}
  const unique = (from: number, to: number) => {
    const value = source.content.slice(from, to).replace(/\r\n/g, '\n')
    if (isEmpty(value)) return false
    const rangeStart = source.lines[sourceLineAt(source, from) - 1].start
    const rangeEnd = source.lines[sourceLineAt(source, Math.max(from, to - 1)) - 1].end
    let count = 0
    for (const visible of windows) {
      const left = Math.max(visible.start, rangeStart)
      const right = Math.min(visible.end, rangeEnd)
      if (right <= left) continue
      const begin = logicalSourceOffset(source, left)
      const until = logicalSourceOffset(source, right)
      for (
        let at = source.logical.indexOf(value, begin);
        at !== -1 && at + value.length <= until;
        at = source.logical.indexOf(value, at + 1)
      ) {
        count += 1
        if (count > 1) return false
      }
    }
    return count === 1
  }
  const suggestion = (from: number, to: number) => ({
    match: source.content.slice(from, to),
    prefix: source.content.slice(from, start),
    suffix: source.content.slice(end, to),
    range: [sourceLineAt(source, from), sourceLineAt(source, Math.max(from, to - 1))] as const,
  })
  if (unique(start, end)) return suggestion(start, end)
  for (let extra = 1; extra <= ProjectTuning.editing.candidateContextChars; extra += 1) {
    // 优先尝试单侧上下文，再尝试两侧均衡窗口；搜索开销不随文件大小无限增长。
    for (const left of [extra, 0, Math.floor(extra / 2)]) {
      let from = Math.max(window.start, start - left)
      let to = Math.min(window.end, end + extra - left)
      if (
        from > window.start &&
        (/[\uDC00-\uDFFF]/.test(source.content[from]) ||
          (source.content[from] === '\n' && source.content[from - 1] === '\r'))
      )
        from -= 1
      if (
        to < window.end &&
        (/[\uD800-\uDBFF]/.test(source.content[to - 1]) ||
          (source.content[to - 1] === '\r' && source.content[to] === '\n'))
      )
        to += 1
      if (unique(from, to)) return suggestion(from, to)
    }
  }
  return {}
}

/** 把原文里的 [start, end) 做成一个候选：行号、有界原文，以及能在可见区域里唯一定位它的 match 建议。 */
export function matchCandidate(
  source: ProjectSourceCoordinates,
  window: OffsetWindow,
  windows: readonly OffsetWindow[],
  start: number,
  end: number,
  confidence: ProjectMatchCandidate['confidence'],
  differences?: readonly string[]
): ProjectMatchCandidate {
  // 候选只给行范围和原文：模型面没有任何字段收字符偏移，给了只会被照抄进下一次入参。
  return {
    range: [sourceLineAt(source, start), sourceLineAt(source, Math.max(start, end - 1))],
    ...boundedText(source.content.slice(start, end)),
    ...distinguishingMatch(source, window, windows, start, end),
    confidence,
    differences,
  }
}

/** 多处精确命中时，把前几处做成候选，每处附上能唯一定位它的 match 建议。 */
export function exactMatchCandidates(
  source: ProjectSourceCoordinates,
  windows: readonly OffsetWindow[],
  matches: readonly OffsetWindow[]
): ProjectMatchCandidate[] {
  return matches.slice(0, ProjectTuning.editing.candidates).map((match) =>
    matchCandidate(
      source,
      windows.find((window) => window.start <= match.start && window.end >= match.end)!,
      windows,
      match.start,
      match.end,
      'exact'
    )
  )
}

/** 零命中时找所选区域之外的精确原文（有条数上限），只用来指路：可见的改 range，不可见的先读取。 */
export function matchesElsewhere(
  source: ProjectSourceCoordinates,
  visible: readonly OffsetWindow[],
  selected: readonly OffsetWindow[],
  match: string
): ProjectMatchElsewhere[] {
  const needle = match.replace(/\r\n/g, '\n')
  const found: ProjectMatchElsewhere[] = []
  for (
    let at = source.logical.indexOf(needle);
    at !== -1 && found.length < ProjectTuning.editing.candidates;
    at = source.logical.indexOf(needle, at + 1)
  ) {
    const start = physicalSourceOffset(source, at)
    const end = physicalSourceOffset(source, at + needle.length)
    const within = (windows: readonly OffsetWindow[]) =>
      windows.some((window) => window.start <= start && end <= window.end)
    if (!within(selected))
      found.push({
        range: [sourceLineAt(source, start), sourceLineAt(source, Math.max(start, end - 1))],
        visible: within(visible),
      })
  }
  return found
}

/** 零命中时在显示过的窗口里找相近原文：先找只差行尾空白的，没有再取失配诊断给出的最接近位置；候选只供确认，永远不授权、不应用模糊编辑。 */
export function missingMatchCandidates(
  view: ProjectEditView,
  source: ProjectSourceCoordinates,
  windows: readonly OffsetWindow[],
  match: string
): ProjectMatchCandidate[] {
  const candidates: ProjectMatchCandidate[] = []
  if (match.length > ProjectTuning.editing.similarScanChars) return candidates
  let remaining = ProjectTuning.editing.similarScanChars
  for (const window of windows) {
    if (remaining <= 0 || candidates.length >= ProjectTuning.editing.candidates) break
    let end = Math.min(window.end, window.start + remaining)
    if (
      end < window.end &&
      (/[\uD800-\uDBFF]/.test(view.content[end - 1]) ||
        (view.content[end - 1] === '\r' && view.content[end] === '\n'))
    )
      end -= 1
    const content = view.content.slice(window.start, end)
    remaining -= content.length
    for (const candidate of findLineWhitespaceTolerantMatches(
      content,
      match,
      ProjectTuning.editing.candidates - candidates.length
    )) {
      const start = window.start + candidate.index
      candidates.push(
        matchCandidate(
          source,
          window,
          windows,
          start,
          start + candidate.text.length,
          'whitespace',
          ['trailing_whitespace']
        )
      )
    }
    if (!isEmpty(candidates)) continue
    const diagnosis = diagnoseTextMatchMiss(content, match)
    if (!diagnosis.candidateLine) continue
    const local = content.split('\n')
    const start =
      window.start +
      local
        .slice(0, diagnosis.candidateLine - 1)
        .reduce((count, line) => count + line.length + 1, 0)
    const candidateEnd = Math.min(
      end,
      start +
        local
          .slice(diagnosis.candidateLine - 1, diagnosis.candidateLine - 1 + diagnosis.oldTextLines)
          .join('\n').length
    )
    candidates.push(
      matchCandidate(source, window, windows, start, candidateEnd, 'similar', diagnosis.causes)
    )
  }
  return candidates
}
