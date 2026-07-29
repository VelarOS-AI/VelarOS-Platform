type QueuedDraftDropPlacement = 'before' | 'after'

interface QueuedDraftMoveOperation {
  id: string
  direction: 'up' | 'down'
}

function resolveQueuedDraftDragMoves(
  orderedIds: readonly string[],
  draggedId: string,
  targetId: string,
  placement: QueuedDraftDropPlacement
): QueuedDraftMoveOperation[] {
  const draggedIndex = orderedIds.indexOf(draggedId)
  const targetIndex = orderedIds.indexOf(targetId)

  if (draggedIndex < 0 || targetIndex < 0 || draggedIndex === targetIndex) return []

  const targetFinalIndex =
    draggedIndex < targetIndex
      ? placement === 'before'
        ? targetIndex - 1
        : targetIndex
      : placement === 'before'
        ? targetIndex
        : targetIndex + 1

  if (targetFinalIndex === draggedIndex) return []

  const direction = targetFinalIndex < draggedIndex ? 'up' : 'down'
  const moveCount = Math.abs(targetFinalIndex - draggedIndex)

  return Array.from({ length: moveCount }, () => ({ id: draggedId, direction }))
}

export { resolveQueuedDraftDragMoves }
export type { QueuedDraftDropPlacement, QueuedDraftMoveOperation }
