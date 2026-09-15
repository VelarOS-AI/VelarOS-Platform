/**
 * 泄漏工具调用标记过滤器。
 *
 * 某些模型会把工具调用以含全宽竖线 `｜` 的原生 DSML 文本格式吐出来：
 * `<｜DSML｜tool_calls>...<｜DSML｜invoke name="project:edit">...`。正常情况下供应商会把它
 * 翻译成结构化 tool-call，但**大 payload（整文件塞进一个参数）时会在传输中断裂**，
 * 未翻译的原始标记就当普通文本泄漏到 UI/历史里，把整屏都堆满乱码。
 *
 * 本过滤器在文本流里检测该标记：一旦出现，标记及其后的所有内容（都是泄漏的工具调用
 * 标记，不是给用户看的正文）一律丢弃。标记可能被切在两个 delta 之间，用 tail 缓冲承接。
 */

/**
 * 泄漏标记锚点：`<｜DSML｜`（`<` + U+FF5C DSML U+FF5C）。含前导 `<`，这样标记被切在两个
 * delta 之间时连 `<` 一起承接、不漏残渣。全宽竖线在正常正文/代码里几乎不可能出现，误伤极低
 * （普通 `<` 只有恰好落在 delta 末尾时才被 hold 一拍，下一个字符非 `｜` 立即释放）。
 */
const LeakedToolMarkupAnchor = '<｜DSML｜'

export interface LeakedToolMarkupFilterState {
  /** 已进入抑制态：锚点已出现，其后一切文本都丢弃。 */
  suppressing: boolean
  /** 跨 delta 承接可能是锚点前缀的尾巴。 */
  tail: string
}

export function createLeakedToolMarkupFilterState(): LeakedToolMarkupFilterState {
  return { suppressing: false, tail: '' }
}

/** s 的后缀中，同时是 marker 前缀的最长长度（用于跨 delta 承接被切断的标记）。 */
function markerPrefixHoldLength(s: string, marker: string): number {
  const max = Math.min(marker.length - 1, s.length)
  for (let hold = max; hold > 0; hold -= 1) {
    if (s.slice(s.length - hold) === marker.slice(0, hold)) return hold
  }
  return 0
}

/**
 * 过滤一个文本增量，返回可安全输出的部分（可能为空）。就地更新 state。
 * 一旦命中锚点，state.suppressing 置位，之后所有增量都返回空串。
 */
export function filterLeakedToolMarkupDelta(
  state: LeakedToolMarkupFilterState,
  text: string
): string {
  if (state.suppressing) return ''
  if (!text) return ''

  const combined = state.tail + text
  const anchorIndex = combined.indexOf(LeakedToolMarkupAnchor)
  if (anchorIndex >= 0) {
    state.suppressing = true
    state.tail = ''
    // 标记前的正文照常输出（锚点已含 `<`，无需再剥）；去掉尾随空白，别在页面上留下残渣。
    return combined.slice(0, anchorIndex).replace(/\s+$/u, '')
  }

  const hold = markerPrefixHoldLength(combined, LeakedToolMarkupAnchor)
  state.tail = hold > 0 ? combined.slice(combined.length - hold) : ''
  return hold > 0 ? combined.slice(0, combined.length - hold) : combined
}

/**
 * 流结束时冲刷承接的尾巴：若从未进入抑制态，说明这段尾巴是正常正文（标记始终没凑齐），
 * 应当补发；若已抑制则丢弃。返回应补发的文本（可能为空）。
 */
export function flushLeakedToolMarkupTail(state: LeakedToolMarkupFilterState): string {
  if (state.suppressing) {
    state.tail = ''
    return ''
  }
  const remaining = state.tail
  state.tail = ''
  return remaining
}
