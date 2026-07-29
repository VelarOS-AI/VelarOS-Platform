import { useCallback, useLayoutEffect, useRef } from 'react'

const MAX_HEIGHT = 150

interface AutoResizeOptions {
  maxHeight?: number
}

export function useAutoResize(
  value: string,
  options: AutoResizeOptions = {}
): React.RefObject<Nullable<HTMLTextAreaElement>> {
  const ref = useRef<HTMLTextAreaElement>(null)
  const maxHeight = options.maxHeight ?? MAX_HEIGHT

  const resize = useCallback(() => {
    const el = ref.current
    if (!el) return

    if (!value.trim()) {
      el.style.height = ''
      return
    }

    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`
  }, [maxHeight, ref, value])

  useLayoutEffect(() => {
    resize()
  }, [resize])

  return ref
}
