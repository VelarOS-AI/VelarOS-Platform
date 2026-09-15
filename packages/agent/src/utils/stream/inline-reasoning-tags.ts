/**
 * 内联 `<think>` 思考标签的流式切分器。
 *
 * 结构化思考增量与各提供方的原始思考字段已由 `StreamConsumer` 单独成流，但部分兼容网关和
 * 自托管蒸馏模型仍把思维链当可见正文输出，并以 `<think>...</think>` 包裹。本切分器把可见文本
 * 拆成有序的正文段与思考段；标签内路由到思考块，标签外保持正文，没有标签时完全透传。
 *
 * 标签可能跨两个增量被切断，因此用 `tail` 承接残缺的标签前缀，避免把半个标签泄漏到界面。
 */

/** 支持的开标签及其对应闭标签（`<think>` / `<thinking>` 两种常见写法）。 */
const InlineReasoningOpenTags = ['<think>', '<thinking>'] as const

function closeTagFor(openTag: string): string {
  return openTag === '<thinking>' ? '</thinking>' : '</think>'
}

export type InlineReasoningSegmentKind = 'visible' | 'reasoning'

export interface InlineReasoningSegment {
  kind: InlineReasoningSegmentKind
  text: string
}

export interface InlineReasoningTagSplitState {
  /** 当前是否处在思考标签内部。 */
  inReasoning: boolean
  /** 处在思考标签内部时，正在等待的闭标签。 */
  activeCloseTag: string
  /** 跨 delta 承接的、可能是标签前缀的尾巴。 */
  tail: string
}

export function createInlineReasoningTagSplitState(): InlineReasoningTagSplitState {
  return { inReasoning: false, activeCloseTag: '', tail: '' }
}

/** s 的后缀中，同时是 marker 前缀的最长长度（用于跨 delta 承接被切断的标记）。 */
function markerPrefixHoldLength(s: string, marker: string): number {
  const max = Math.min(marker.length - 1, s.length)
  for (let hold = max; hold > 0; hold -= 1) {
    if (s.slice(s.length - hold) === marker.slice(0, hold)) return hold
  }
  return 0
}

/** 在 s 中查找最靠前出现的开标签。 */
function findEarliestOpenTag(s: string): { index: number; tag: string } {
  let bestIndex = -1
  let bestTag = ''
  for (const tag of InlineReasoningOpenTags) {
    const index = s.indexOf(tag)
    if (index !== -1 && (bestIndex === -1 || index < bestIndex)) {
      bestIndex = index
      bestTag = tag
    }
  }
  return { index: bestIndex, tag: bestTag }
}

/** 任意开标签前缀在 s 后缀中的最长承接长度。 */
function openTagTailHoldLength(s: string): number {
  let max = 0
  for (const tag of InlineReasoningOpenTags) {
    const hold = markerPrefixHoldLength(s, tag)
    if (hold > max) max = hold
  }
  return max
}

function pushSegment(
  segments: InlineReasoningSegment[],
  kind: InlineReasoningSegmentKind,
  text: string
): void {
  if (!text) return
  segments.push({ kind, text })
}

/**
 * 切分一个可见文本增量，返回有序的 visible / reasoning 段（就地更新 state）。
 * 单个增量里可以混排多段（`abc<think>xyz</think>def` → visible/reasoning/visible），
 * 顺序被保留，供上游按序 emit，避免打乱正文与思考的先后。
 */
export function splitInlineReasoningTagDelta(
  state: InlineReasoningTagSplitState,
  text: string
): InlineReasoningSegment[] {
  const segments: InlineReasoningSegment[] = []
  if (!text) return segments

  let combined = state.tail + text
  state.tail = ''

  while (combined) {
    if (!state.inReasoning) {
      const found = findEarliestOpenTag(combined)
      if (found.index === -1) {
        const hold = openTagTailHoldLength(combined)
        if (hold > 0) {
          state.tail = combined.slice(combined.length - hold)
          combined = combined.slice(0, combined.length - hold)
        }
        pushSegment(segments, 'visible', combined)
        break
      }

      pushSegment(segments, 'visible', combined.slice(0, found.index))
      state.inReasoning = true
      state.activeCloseTag = closeTagFor(found.tag)
      combined = combined.slice(found.index + found.tag.length)
      continue
    }

    const closeTag = state.activeCloseTag
    const closeIndex = combined.indexOf(closeTag)
    if (closeIndex === -1) {
      const hold = markerPrefixHoldLength(combined, closeTag)
      if (hold > 0) {
        state.tail = combined.slice(combined.length - hold)
        combined = combined.slice(0, combined.length - hold)
      }
      pushSegment(segments, 'reasoning', combined)
      break
    }

    pushSegment(segments, 'reasoning', combined.slice(0, closeIndex))
    state.inReasoning = false
    state.activeCloseTag = ''
    combined = combined.slice(closeIndex + closeTag.length)
  }

  return segments
}

/**
 * 流结束时冲刷承接的尾巴：标签始终没凑齐，说明这段尾巴不是标签而是真内容，按当前所处
 * 上下文补发（思考标签内 → reasoning，标签外 → visible）。
 */
export function flushInlineReasoningTagTail(
  state: InlineReasoningTagSplitState
): InlineReasoningSegment[] {
  const remaining = state.tail
  state.tail = ''
  if (!remaining) return []

  return [{ kind: state.inReasoning ? 'reasoning' : 'visible', text: remaining }]
}
