// 搜索空结果时给模型的自纠提示，以及提示与 trace 告警的合并。
// 这些文案是模型面的：0 条召回最容易被读成「这事没发生过」，必须当场把口径纠回来。纯函数，不记状态。

import { isEmpty } from '@velaros-ai/core'

/**
 * 一条都没命中时，攒一组让模型换个搜法的提示；有命中（matchedCount > 0）时返回空数组。
 *
 * 三层：先申明「0 条不等于没发生」，再让它换更罕见的关键词；搜索空间本身为空时（totalCandidates <= 0）
 * 说清这个会话压根没有这类可搜内容；最后按 kind 提醒它这条搜索只覆盖哪一半，另一半该换哪个 `历史检索服务` 口径。
 */
export function buildEmptySearchRetryHints(input: {
  kind: 'conversation-history' | 'terminal-output'
  matchedCount: number
  totalCandidates: number
}): string[] {
  if (input.matchedCount > 0) return []

  const hints = [
    '0 条召回不代表事件没有发生；只表示当前已索引范围和本次 query 没命中。',
    '请换用更少、更罕见的文件名、符号名、错误指纹或用户原话关键词重新搜索。',
  ]

  if (input.totalCandidates <= 0) {
    hints.push(
      input.kind === 'terminal-output'
        ? '当前会话没有可搜索的内部终端日志引用；需要命令输出时应先确认相关工具结果是否保存了 logPath。'
        : '当前会话还没有可搜索的历史消息；需要当前状态时请改用对应的注入检查能力。',
    )
  }

  if (input.kind === 'terminal-output') {
    hints.push(
      'terminal 搜索只覆盖内部命令日志；如果要找对话结论、普通工具摘要或保存 payload，需要宿主在 conversation/all 范围搜索或按 ref 解析。',
    )
  } else {
    hints.push(
      'conversation 搜索只覆盖已索引聊天记录；如果要找命令输出或测试日志，需要宿主在 terminal/all 范围搜索。',
    )
  }

  return hints
}

/**
 * 把 trace 自己的告警（重复搜索之类）和空结果提示拼成一句交给调用方；空白项会被滤掉，
 * 一项都不剩时给 null——搜索结果里的 warning 字段宁可缺席，也不要一个空字符串让下游以为有话要说。
 */
export function combineSearchWarnings(
  traceWarning: LooseOptional<string>,
  retryHints: string[],
): LooseOptional<string> {
  const parts = [traceWarning, ...retryHints].filter((part): part is string => Boolean(part?.trim()))

  return isEmpty(parts) ? null : parts.join(' ')
}
