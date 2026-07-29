import { type RefObject, useEffect, useRef, useState } from 'react'

import { isArray, toNullable } from '#internal/runtime'

/**
 * rich 工具卡懒渲染用的可见性观察 hook（零宿主耦合的叶子件，随 richOutput 入包）。
 * 宿主 htmlPreview 另有一份同源副本（随参考壳退场），此处为包自持副本。
 */
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

    if (!window.IntersectionObserver) {
      setEntry(null)
      setIsIntersecting(fallbackIsIntersecting)
      return undefined
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const nextEntry = toNullable(entries[0])
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
