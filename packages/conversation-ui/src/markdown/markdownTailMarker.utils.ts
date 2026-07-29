interface ActivateMarkdownTailMarkerOptions {
  container: Nullable<HTMLElement>
  inlineSlotSelector: string
  fallbackSlotSelector: string
}

function clearActiveTailMarker(slot: HTMLElement): void {
  delete slot.dataset.activeTailMarker
}

function isAtMarkdownTail(markdownRoot: Element, slot: Element): boolean {
  let current: Nullable<Element> = slot

  while (current && current !== markdownRoot) {
    if (current.nextElementSibling) return false
    current = current.parentElement
  }

  return current === markdownRoot
}

/**
 * 只有状态标记确实位于 Markdown 渲染树尾部时才保留行内位置。
 * 表格、代码块、图片、分隔线等非行内结尾统一使用 Streamdown 后方的兜底槽，
 * 避免状态标记错误地停留在更早的段落上。
 */
export function activateMarkdownTailMarker({
  container,
  inlineSlotSelector,
  fallbackSlotSelector,
}: ActivateMarkdownTailMarkerOptions): void {
  const inlineSlots = Array.from(
    container?.querySelectorAll<HTMLElement>(inlineSlotSelector) ?? []
  )
  const fallbackSlots = Array.from(
    container?.querySelectorAll<HTMLElement>(fallbackSlotSelector) ?? []
  )

  for (const slot of [...inlineSlots, ...fallbackSlots]) {
    clearActiveTailMarker(slot)
  }

  const fallbackSlot = fallbackSlots.at(-1)
  if (!fallbackSlot) return

  const markdownRoot = fallbackSlot.previousElementSibling
  const lastInlineSlot = inlineSlots.at(-1)
  const activeSlot =
    lastInlineSlot && markdownRoot && isAtMarkdownTail(markdownRoot, lastInlineSlot)
      ? lastInlineSlot
      : fallbackSlot

  activeSlot.dataset.activeTailMarker = 'true'
}
