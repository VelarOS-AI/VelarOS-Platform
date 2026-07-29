import { type RefObject,useEffect, useRef, useState } from 'react'

import { isArray, toNullable } from './runtime'

/** 监听元素与视口相交状态；不支持 IntersectionObserver 的环境退回 `fallbackIsIntersecting`。 */
export interface UseIntersectionObserverOptions extends IntersectionObserverInit {
  fallbackIsIntersecting?: boolean
  initialIsIntersecting?: boolean
}

export interface UseIntersectionObserverResult<T extends Element> {
  ref: RefObject<Nullable<T>>
  entry: Nullable<IntersectionObserverEntry>
  isIntersecting: boolean
}

function getThresholdKey(threshold: IntersectionObserverInit['threshold']): string {
  return isArray(threshold) ? threshold.join(',') : String(threshold ?? 0)
}

export function useIntersectionObserver<T extends Element>({
  root = null,
  rootMargin = '0px',
  threshold = 0,
  fallbackIsIntersecting = true,
  initialIsIntersecting = false,
}: UseIntersectionObserverOptions = {}): UseIntersectionObserverResult<T> {
  const ref = useRef<T>(null)
  const [entry, setEntry] = useState<Nullable<IntersectionObserverEntry>>(null)
  const [isIntersecting, setIsIntersecting] = useState(initialIsIntersecting)
  const thresholdKey = getThresholdKey(threshold)

  useEffect(() => {
    const target = ref.current

    if (!target) return undefined

    const win = globalThis.window
    if (!win?.IntersectionObserver) {
      setEntry(null)
      // 旧浏览器或测试环境无 IO 时避免抛错，由调用方决定默认是否视为「在视口内」。
      setIsIntersecting(fallbackIsIntersecting)
      return undefined
    }

    const observer = new win.IntersectionObserver(
      (entries) => {
        const nextEntry = (toNullable(entries[0]))
        setEntry(nextEntry)
        setIsIntersecting(!!nextEntry?.isIntersecting)
      },
      { root, rootMargin, threshold }
    )

    observer.observe(target)

    return () => observer.disconnect()
  }, [fallbackIsIntersecting, root, rootMargin, thresholdKey])

  return { ref, entry, isIntersecting }
}
