import type { ChatSuggestionItem } from '#contracts'

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
  if (input.length === 0) return [...suggestions]

  const normalizedPrefix = normalizeCompletionText(input)
  if (!normalizedPrefix) return []

  return suggestions.filter((suggestion) =>
    normalizeCompletionText(suggestion.prompt).startsWith(normalizedPrefix)
  )
}

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

/** 把扩展栏按键转换成与 React/DOM 无关的动作，供输入框路由与回归测试共用。 */
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
