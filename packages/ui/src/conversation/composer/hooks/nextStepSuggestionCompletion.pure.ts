import type { ChatSuggestionItem } from '#contracts'
import { isEmpty } from '#internal/runtime'

export const NoNextStepSuggestionHighlightIndex = -1

export type NextStepSuggestionKeyboardAction =
  | { kind: 'dismiss' }
  | { kind: 'highlight'; index: number }
  | { kind: 'ignore' }
  | { kind: 'open'; index: number }
  | { kind: 'remove-attachment'; dismissWhenEmpty: boolean; index: number }
  | { kind: 'submit'; index: number }

function normalizeCompletionText(value: string): string {
  return value.trim().replaceAll(/\s+/gu, ' ').toLocaleLowerCase()
}

/**
 * 输入框为空时展示全部下一步建议；用户开始输入后只保留前缀命中项。
 */
export function matchNextStepSuggestionPrefix(
  suggestions: readonly ChatSuggestionItem[],
  input: string
): ChatSuggestionItem[] {
  if (input.includes('\n')) return []
  if (isEmpty(input)) return [...suggestions]

  const normalizedPrefix = normalizeCompletionText(input)
  if (!normalizedPrefix) return []

  return suggestions.filter((suggestion) =>
    normalizeCompletionText(suggestion.prompt).startsWith(normalizedPrefix)
  )
}

/**
 * @deprecated 建议集合出主进程时已按 confidence 降序排好（`normalizeChatSuggestionDrafts`），
 * 内联形态直接用「第 1 条 = 最高优先级」的数组序，不再二次挑最高分。随面板一起保留待回滚。
 */
export function findHighestConfidenceNextStepSuggestion(
  suggestions: readonly ChatSuggestionItem[]
): ChatSuggestionItem | undefined {
  return suggestions.reduce<ChatSuggestionItem | undefined>(
    (best, suggestion) => (!best || suggestion.confidence > best.confidence ? suggestion : best),
    undefined
  )
}

export function isNextStepSuggestionExactMatch(
  suggestion: ChatSuggestionItem,
  input: string
): boolean {
  return normalizeCompletionText(suggestion.prompt) === normalizeCompletionText(input)
}

/**
 * 扩展栏尚未高亮选项时，向下从第一项开始、向上从最后一项开始；之后循环移动。
 */
export function resolveNextStepSuggestionHighlightIndex(
  currentIndex: number,
  itemCount: number,
  direction: 'down' | 'up'
): number {
  if (itemCount <= 0) return NoNextStepSuggestionHighlightIndex
  if (currentIndex === NoNextStepSuggestionHighlightIndex)
    return direction === 'down' ? 0 : itemCount - 1

  return direction === 'down'
    ? (currentIndex + 1) % itemCount
    : (currentIndex - 1 + itemCount) % itemCount
}

/**
 * 输入框里那条建议此刻停在第几项。
 *
 * 索引存的是「用户拨到过第几条」，而可见集合会随输入前缀收缩（输入 `帮我` 后三条可能只剩一条）。
 * 因此展示前一律夹到可见集合内，而不是在 value 每次变化时用 effect 把索引写回 0——夹取是纯函数，
 * 删掉刚输入的字符时索引还能回到用户原本拨到的那一条。
 */
export function resolveInlineNextStepSuggestionIndex(
  currentIndex: number,
  itemCount: number
): number {
  if (itemCount <= 0) return NoNextStepSuggestionHighlightIndex
  return Math.min(Math.max(currentIndex, 0), itemCount - 1)
}

/** 输入框内联建议的按键动作（面板退役后取代 {@link NextStepSuggestionKeyboardAction}）。 */
export type InlineNextStepSuggestionAction =
  | { kind: 'accept' }
  | { kind: 'cycle'; index: number }
  | { kind: 'dismiss' }
  | { kind: 'ignore' }
  | { kind: 'restore' }
  | { kind: 'send' }

export interface InlineNextStepSuggestionKeyboardInput {
  key: string
  /** 已夹取过的当前索引。 */
  activeIndex: number
  itemCount: number
  /** 建议此刻是否正写在输入框里（Esc 收起后为 false）。 */
  visible: boolean
  inputEmpty: boolean
  /** 当前这条还有没有可补全的余量（与已输入内容不完全相同）。 */
  canAccept: boolean
}

/**
 * 把输入框按键翻译成内联建议动作；与 React/DOM 无关，供输入框路由与回归复核共用。
 *
 * 三条判据决定了这里为什么不是简单地「有建议就劫持方向键」：
 *  1. **只剩一条时不劫持方向键**——切换无处可去，劫持只会让光标动不了。
 *  2. **收起后方向键是「重新唤出」而不是「切下一条」**——索引原地不动，用户按上/下想看回刚被
 *     Esc 收掉的那条，而不是跳到相邻项。
 *  3. **Enter 只在输入框为空时才代表「发这条建议」**——一旦用户开始打字，Enter 必须发他自己
 *     打的那句；建议只能靠 Tab 落进输入框。
 */
export function resolveInlineNextStepSuggestionKeyboardAction({
  key,
  activeIndex,
  itemCount,
  visible,
  inputEmpty,
  canAccept,
}: InlineNextStepSuggestionKeyboardInput): InlineNextStepSuggestionAction {
  if (itemCount <= 0) return { kind: 'ignore' }

  if (key === 'ArrowDown' || key === 'ArrowUp') {
    if (!visible) return { kind: 'restore' }
    if (itemCount <= 1) return { kind: 'ignore' }

    return {
      kind: 'cycle',
      index: resolveNextStepSuggestionHighlightIndex(
        activeIndex,
        itemCount,
        key === 'ArrowDown' ? 'down' : 'up'
      ),
    }
  }

  if (!visible) return { kind: 'ignore' }
  if (key === 'Escape') return { kind: 'dismiss' }
  if (key === 'Tab' && canAccept) return { kind: 'accept' }
  if (key === 'Enter' && inputEmpty) return { kind: 'send' }

  return { kind: 'ignore' }
}

/**
 * 把扩展栏按键转换成与 React/DOM 无关的动作，供输入框路由与回归测试共用。
 *
 * @deprecated 面板形态（{@link import('../ComposerNextStepSuggestionMenu.tsx').ComposerNextStepSuggestionMenu}）
 * 已于 2026-08-06 退役，改为输入框内联建议；本函数随面板一起保留待回滚，现役路由见
 * {@link resolveInlineNextStepSuggestionKeyboardAction}。
 */
export function resolveNextStepSuggestionKeyboardAction(
  key: string,
  highlightedIndex: number,
  itemCount: number,
  menuOpen: boolean,
  inputEmpty: boolean,
  removableAttachmentCount = 0
): NextStepSuggestionKeyboardAction {
  if (!menuOpen) {
    if (key !== 'ArrowUp' || itemCount <= 0) return { kind: 'ignore' }
    return {
      kind: 'open',
      index: resolveNextStepSuggestionHighlightIndex(
        NoNextStepSuggestionHighlightIndex,
        itemCount,
        'up'
      ),
    }
  }

  if (key === 'Escape') return { kind: 'dismiss' }

  if (key === 'Backspace' && inputEmpty) {
    if (removableAttachmentCount > 0)
      return {
        kind: 'remove-attachment',
        dismissWhenEmpty: removableAttachmentCount === 1,
        index: removableAttachmentCount - 1,
      }

    return { kind: 'dismiss' }
  }

  if (key === 'ArrowDown' || key === 'ArrowUp') {
    const index = resolveNextStepSuggestionHighlightIndex(
      highlightedIndex,
      itemCount,
      key === 'ArrowDown' ? 'down' : 'up'
    )
    return index === NoNextStepSuggestionHighlightIndex
      ? { kind: 'ignore' }
      : { kind: 'highlight', index }
  }

  if (key === 'Enter' && highlightedIndex >= 0 && highlightedIndex < itemCount)
    return { kind: 'submit', index: highlightedIndex }

  return { kind: 'ignore' }
}
