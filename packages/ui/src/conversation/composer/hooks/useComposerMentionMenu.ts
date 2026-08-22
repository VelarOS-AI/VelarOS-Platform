import { useCallback, useEffect, useMemo, useState } from 'react'
import type React from 'react'

import type { ChatInputMentionableOption } from '../chatInputTypes'

import { isEmpty, isNotNull, isNull } from '#internal/runtime'

/** 输入值是否处于 `@` 引用调用形态：以 `@` 开头的单行短查询（仅第一个位置生效）。 */
export function isMentionQuery(value: string): boolean {
  return value.startsWith('@') && !value.includes('\n') && value.length <= 64
}

/** 按 `@` 后的查询词过滤可引用项（定位/正文，不区分大小写）。 */
export function filterMentionOptions(
  options: readonly ChatInputMentionableOption[],
  query: string
): ChatInputMentionableOption[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return [...options]

  return options.filter((option) =>
    `${option.label}\n${option.body}`.toLowerCase().includes(normalized)
  )
}

interface UseComposerMentionMenuInput {
  value: string
  disabled: boolean
  available: readonly ChatInputMentionableOption[]
  selectedIds: readonly string[]
  onToggleSelected: (id: string, selected: boolean) => void
  onDelete: (id: string) => void
  clearInput: () => void
}

export interface UseComposerMentionMenuReturn {
  open: boolean
  items: ChatInputMentionableOption[]
  selectedIdSet: Set<string>
  highlightedIndex: number
  setHighlightedIndex: (index: number) => void
  selectItem: (id: string) => void
  deleteItem: (id: string) => void
  /** 返回 true 表示按键已被引用菜单消费，调用方不要再走发送等默认行为。 */
  handleKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => boolean
}

/**
 * 聊天输入 `@` **可引用项**菜单（与 `/` 技能菜单同款交互）。
 *
 * 「可引用项」是来源无关的：工作台行内评论、空间选中对象、将来任何 mod 声明"我的 delta 走
 * mention 面"的东西，都只是它的一种来源。菜单本身不认识任何来源 id——上一版把它叫「评论」，
 * 否则其他来源使用 `@` 时，弹出的面板会错误沿用“评论”及“删除评论”等文案。
 *
 * 输入以 `@` 开头即弹出列表，随查询过滤；↑↓ 移动、Enter/点击切换选中、Esc 关闭。
 * 选中 = 进入 selectedIds（chips 条显示），同时清掉输入框里的 `@query`；列表项可就地移除。
 */
export function useComposerMentionMenu({
  value,
  disabled,
  available,
  selectedIds,
  onToggleSelected,
  onDelete,
  clearInput,
}: UseComposerMentionMenuInput): UseComposerMentionMenuReturn {
  const [dismissed, setDismissed] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(0)

  const query = isMentionQuery(value) ? value.slice(1) : null
  const items = useMemo(
    () => (isNull(query) ? [] : filterMentionOptions(available, query)),
    [available, query]
  )
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds])
  const open = !disabled && !dismissed && isNotNull(query) && !isEmpty(items)

  // 输入变化时复位：重新打开、重置高亮到第一项。
  useEffect(() => {
    setDismissed(false)
    setHighlightedIndex(0)
  }, [value])

  const selectItem = useCallback(
    (id: string): void => {
      onToggleSelected(id, !selectedIdSet.has(id))
      clearInput()
    },
    [clearInput, onToggleSelected, selectedIdSet]
  )

  const deleteItem = useCallback(
    (id: string): void => {
      onDelete(id)
    },
    [onDelete]
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!open) return false

      // 输入法组合期（拼音候选框开着）**整条键盘链让路**：↑↓ 是 IME 选候选词的键、
      // Esc 是取消组合的键。此前只有 Enter 判了 isComposing，方向键与 Esc 裸 preventDefault，
      // 于是用中文过滤菜单时候选列表动不了、Esc 关不掉组合。判定必须在 switch 之前一次做完，
      // 不能逐 case 补——逐 case 补就是下一个键再漏一次。
      if (event.nativeEvent.isComposing) return false

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault()
          setHighlightedIndex((index) => (index + 1) % items.length)
          return true
        case 'ArrowUp':
          event.preventDefault()
          setHighlightedIndex((index) => (index - 1 + items.length) % items.length)
          return true
        case 'Enter': {
          event.preventDefault()
          const item = items[Math.min(highlightedIndex, items.length - 1)]
          if (item) selectItem(item.id)
          return true
        }
        case 'Escape':
          event.preventDefault()
          setDismissed(true)
          return true
        default:
          return false
      }
    },
    [highlightedIndex, items, open, selectItem]
  )

  return {
    open,
    items,
    selectedIdSet,
    highlightedIndex,
    setHighlightedIndex,
    selectItem,
    deleteItem,
    handleKeyDown,
  }
}
