import { useCallback, useEffect, useMemo, useState } from 'react'
import type React from 'react'

import type { ChatInputSkillOption } from '../chatInputTypes'

import { isEmpty,isNotNull, isNull } from '#internal/runtime'

export const NoSlashSkillHighlightIndex = -1

/** 输入值是否处于斜杠调用形态：以 / 开头的单行短查询。 */
export function isSlashSkillQuery(value: string): boolean {
  return value.startsWith('/') && !value.includes('\n') && value.length <= 64
}

function normalizeSlashSkillSearchText(value: string): string {
  return value.trim().replace(/^\/+/, '').trim().toLowerCase()
}

function normalizeSlashSkillSlugText(value: string): string {
  return normalizeSlashSkillSearchText(value).replaceAll(/\s+/gu, '-')
}

/** 按 / 后的查询词过滤技能（右侧 slug/id/名称/描述，不区分大小写）。 */
export function filterSlashSkillOptions(
  skills: readonly ChatInputSkillOption[],
  query: string
): ChatInputSkillOption[] {
  const normalized = normalizeSlashSkillSearchText(query)
  if (!normalized) return [...skills]
  const normalizedSlug = normalizeSlashSkillSlugText(query)

  return skills.filter((skill) => {
    const id = skill.id.toLowerCase()
    const slashSlug = `/${id}`
    const searchableText = [id, slashSlug, skill.label, skill.description ?? '']
      .join('\n')
      .toLowerCase()

    return searchableText.includes(normalized) || id.includes(normalizedSlug)
  })
}

export function isSlashSkillSelected(
  skillId: string,
  selectedSkillIds: readonly string[]
): boolean {
  return selectedSkillIds.includes(skillId)
}

export function resolveSlashSkillToggleSelected(
  skillId: string,
  selectedSkillIds: readonly string[]
): boolean {
  return !isSlashSkillSelected(skillId, selectedSkillIds)
}

export function resolveNextSlashSkillHighlightIndex(
  currentIndex: number,
  itemCount: number,
  direction: 'down' | 'up'
): number {
  if (itemCount <= 0) return NoSlashSkillHighlightIndex
  if (currentIndex === NoSlashSkillHighlightIndex) return direction === 'down' ? 0 : itemCount - 1

  return direction === 'down'
    ? (currentIndex + 1) % itemCount
    : (currentIndex - 1 + itemCount) % itemCount
}

export function resolveSlashSkillSelectionIndex(
  highlightedIndex: number,
  itemCount: number
): number {
  if (itemCount <= 0) return NoSlashSkillHighlightIndex
  if (highlightedIndex < 0 || highlightedIndex >= itemCount) return 0
  return highlightedIndex
}

interface UseComposerSlashSkillMenuInput {
  value: string
  disabled: boolean
  availableSkills: readonly ChatInputSkillOption[]
  selectedSkillIds: readonly string[]
  updateSelectedSkill: (skillId: string, enabled: boolean) => void
}

export interface UseComposerSlashSkillMenuReturn {
  open: boolean
  items: ChatInputSkillOption[]
  highlightedIndex: number
  setHighlightedIndex: (index: number) => void
  selectItem: (skillId: string) => void
  isItemSelected: (skillId: string) => boolean
  /** 返回 true 表示按键已被斜杠菜单消费，调用方不要再走发送等默认行为。 */
  handleKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => boolean
}

/**
 * 聊天输入 `/` 斜杠技能菜单（Claude Code 同款交互）：
 * 输入以 `/` 开头即弹出已装技能列表，随查询过滤；↑↓ 移动、Enter/点击选中、Esc 关闭。
 * 选中 = toggle 技能进入/移出 selectedSkillIds（chips 条显示），输入保留用于继续过滤多选。
 */
export function useComposerSlashSkillMenu({
  value,
  disabled,
  availableSkills,
  selectedSkillIds,
  updateSelectedSkill,
}: UseComposerSlashSkillMenuInput): UseComposerSlashSkillMenuReturn {
  const [dismissed, setDismissed] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(NoSlashSkillHighlightIndex)

  const query = isSlashSkillQuery(value) ? value.slice(1) : null
  const items = useMemo(
    () => (isNull(query) ? [] : filterSlashSkillOptions(availableSkills, query)),
    [availableSkills, query]
  )
  const open = !disabled && !dismissed && isNotNull(query) && !isEmpty(items)

  // 输入变化时复位：重新打开、重置高亮到第一项。
  useEffect(() => {
    setDismissed(false)
    setHighlightedIndex(NoSlashSkillHighlightIndex)
  }, [value])

  const selectItem = useCallback(
    (skillId: string): void => {
      updateSelectedSkill(skillId, resolveSlashSkillToggleSelected(skillId, selectedSkillIds))
    },
    [selectedSkillIds, updateSelectedSkill]
  )

  const isItemSelected = useCallback(
    (skillId: string): boolean => isSlashSkillSelected(skillId, selectedSkillIds),
    [selectedSkillIds]
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
          setHighlightedIndex((index) =>
            resolveNextSlashSkillHighlightIndex(index, items.length, 'down')
          )
          return true
        case 'ArrowUp':
          event.preventDefault()
          setHighlightedIndex((index) =>
            resolveNextSlashSkillHighlightIndex(index, items.length, 'up')
          )
          return true
        case 'Enter': {
          event.preventDefault()
          const selectionIndex = resolveSlashSkillSelectionIndex(highlightedIndex, items.length)
          const item = items[selectionIndex]
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
    highlightedIndex,
    setHighlightedIndex,
    selectItem,
    isItemSelected,
    handleKeyDown,
  }
}
