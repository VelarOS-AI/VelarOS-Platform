import type { TurnContextAnchor, TurnContextDelta } from '../types/turnContext'

// 环境回合上下文的唯一渲染实现：pre-send 冻结块（renderer 调用）与 mid-run
// history note（main 调用）共用，保证同输入同输出、冻结后逐字稳定。
// 模板刻意只做行拼接，不含 locale/相对时间等任何非确定性成分。

export const TurnContextBlockOpenTag = '<environment-context>'
export const TurnContextBlockCloseTag = '</environment-context>'

/** mid-run note 的固定引导行（user note 注入历史时置于块前）。 */
export const TurnContextMidRunNoteLead =
  '以下为运行期间用户环境的实际变化（系统自动注入，非用户输入）：'

/**
 * 从 user message 中移除宿主自动附加的环境回合上下文。
 *
 * 这些块为了兼容模型 API 会以 user role 传输，但它们不是用户意图；
 * 意图路由、长期记忆采集等边界不能把块内的页面/记忆/工作区信号
 * 当成用户新请求。未闭合块按宿主输入处理，从 open tag 起丢弃到末尾。
 */
export function stripTurnContextBlocks(text: string): string {
  let cursor = 0
  let visibleText = ''

  while (cursor < text.length) {
    const openIndex = text.indexOf(TurnContextBlockOpenTag, cursor)
    if (openIndex < 0) {
      visibleText += text.slice(cursor)
      break
    }

    visibleText += text.slice(cursor, openIndex)
    const closeIndex = text.indexOf(
      TurnContextBlockCloseTag,
      openIndex + TurnContextBlockOpenTag.length
    )
    if (closeIndex < 0) break

    cursor = closeIndex + TurnContextBlockCloseTag.length
  }

  return visibleText.replaceAll(TurnContextMidRunNoteLead, '').trim()
}

export function formatTurnContextOmittedNote(count: number): string {
  return `较早的 ${count} 条环境变化已因容量限制省略，以下仅包含最新变化。`
}

export interface TurnContextBlockInput {
  /** 空数组表示本次不重发 anchors。顺序由 fan-in 定死（sourceId,key），不得重排。 */
  anchors: readonly TurnContextAnchor[]
  overflowNotes: readonly string[]
  /** 已过滤 dismissed、已确定性排序；不得重排。 */
  deltas: readonly TurnContextDelta[]
}

/** 无内容时返回 null（护栏：附加 0 字符）。 */
export function renderTurnContextBlock(input: TurnContextBlockInput): Nullable<string> {
  const { anchors, overflowNotes, deltas } = input
  if (anchors.length === 0 && overflowNotes.length === 0 && deltas.length === 0) return null

  const lines: string[] = [TurnContextBlockOpenTag]

  if (anchors.length > 0) {
    lines.push('当前环境：')
    for (const anchor of anchors) lines.push(`- ${anchor.text}`)
  }

  if (overflowNotes.length > 0 || deltas.length > 0) {
    lines.push('环境变化：')
    for (const note of overflowNotes) lines.push(`- ${note}`)
    for (const delta of deltas) {
      lines.push(`- ${delta.summaryText}`)
      if (delta.inspect) {
        const args = delta.inspect.argsHint ? ` ${JSON.stringify(delta.inspect.argsHint)}` : ''
        lines.push(`  （需核实当前状态时用 ${delta.inspect.tool}${args}）`)
      }
    }
  }

  lines.push(TurnContextBlockCloseTag)
  return lines.join('\n')
}
