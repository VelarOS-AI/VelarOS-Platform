import { type PointerEvent as ReactPointerEvent, useCallback } from 'react'

import { isFunction } from '../lib/runtime'

export interface PointerResizeMove {
  deltaX: number
  deltaY: number
  startX: number
  startY: number
}

export interface UsePointerResizeOptions<TTarget, TContext> {
  cursor: string | ((target: TTarget) => string)
  onResize: (target: TTarget, move: PointerResizeMove, context: TContext) => void
  onResizeStart: (target: TTarget, event: ReactPointerEvent) => TContext
}

export type PointerResizeStarter<TTarget> = (target: TTarget, event: ReactPointerEvent) => void

export function usePointerResize<TTarget, TContext>({
  cursor,
  onResize,
  onResizeStart,
}: UsePointerResizeOptions<TTarget, TContext>): PointerResizeStarter<TTarget> {
  return useCallback(
    (target: TTarget, event: ReactPointerEvent): void => {
      event.preventDefault()

      const startX = event.clientX
      const startY = event.clientY
      const context = onResizeStart(target, event)
      const previousCursor = document.body.style.cursor
      const previousUserSelect = document.body.style.userSelect

      document.body.style.cursor = isFunction(cursor) ? cursor(target) : cursor
      document.body.style.userSelect = 'none'

      const handlePointerMove = (pointerEvent: PointerEvent): void => {
        onResize(
          target,
          {
            deltaX: pointerEvent.clientX - startX,
            deltaY: pointerEvent.clientY - startY,
            startX,
            startY,
          },
          context
        )
      }

      const stopResize = (): void => {
        window.removeEventListener('pointermove', handlePointerMove)
        window.removeEventListener('pointerup', stopResize)
        window.removeEventListener('pointercancel', stopResize)
        document.body.style.cursor = previousCursor
        document.body.style.userSelect = previousUserSelect
      }

      window.addEventListener('pointermove', handlePointerMove)
      window.addEventListener('pointerup', stopResize)
      window.addEventListener('pointercancel', stopResize)
    },
    [cursor, onResize, onResizeStart]
  )
}
