import { type RefObject, useLayoutEffect, useRef, useState } from 'react'

/**
 * 芯片条放不下时，把标签整体塌成**只剩图标**。
 *
 * ## 参照系必须与内容无关
 * 天真的做法是「量自己：内容宽 > 自己的宽就收起」。它有个致命回路：收起后自己变窄，下次再量
 * 还是「装不下」，于是宽度回来了也永远不还原；反过来若按收起态的宽去比，又会立刻判定装得下、
 * 展开、再收起，两态之间来回抖。
 *
 * 解法是让芯片条的宽度**不取决于它装了什么**：CSS 给它 `flex: 1 1 0`，于是它恒等于工具条左组
 * 的剩余空间。`clientWidth` 因此是一条稳定的「可用车道」，`scrollWidth`（强制展开态下读）是
 * 「自然内容宽」。两者相比是纯函数，不随自身输出漂移。
 *
 * ## 为什么每次都先强制展开
 * 收起态的 `scrollWidth` 只反映图标宽度，量出来永远「装得下」。测量前挂 `data-chips-measuring`
 * （CSS 据此临时让标签回来），读完立刻摘掉；`scrollWidth` 是强制重排的读，所以这一读必定读到
 * 展开态。
 *
 * ## 两个观察者各管一件事
 * 收起与否同时取决于**可用宽度**和**芯片内容**：ResizeObserver 盯前者，MutationObserver 盯后者
 * （增删芯片、切语言）。收起只改 CSS 可见性、不动 DOM，因此回调不会自激。
 */
export function useComposerToolbarChipCollapse(): {
  barRef: RefObject<Nullable<HTMLDivElement>>
  collapsed: boolean
} {
  const barRef = useRef<Nullable<HTMLDivElement>>(null)
  const [collapsed, setCollapsed] = useState(false)

  useLayoutEffect(() => {
    const bar = barRef.current
    if (!bar) return undefined

    const sync = (): void => {
      setCollapsed(measureComposerChipOverflow(bar))
    }
    sync()

    // 非浏览器宿主（SSR / 裁剪版 jsdom）缺这两个观察者时静默降级：首帧那次 sync 已经给出正确
    // 结果，缺的只是后续跟随。
    const observers: Array<{ disconnect: () => void }> = []
    const ResizeObserverCtor = globalThis.ResizeObserver
    if (ResizeObserverCtor) {
      const observer = new ResizeObserverCtor(sync)
      observer.observe(bar)
      observers.push(observer)
    }
    const MutationObserverCtor = globalThis.MutationObserver
    if (MutationObserverCtor) {
      const observer = new MutationObserverCtor(sync)
      // 只看内容，不看属性：`data-chips-collapsed` / `data-chips-measuring` 都是本机制自己写的，
      // 一并观察就等于让回调触发回调。
      observer.observe(bar, { childList: true, subtree: true, characterData: true })
      observers.push(observer)
    }
    return () => {
      for (const observer of observers) observer.disconnect()
    }
  }, [])

  return { barRef, collapsed }
}

/** 在强制展开态下判断芯片条是否已经装不下；导出仅供测试直读这条判据。 */
export function measureComposerChipOverflow(bar: HTMLElement): boolean {
  bar.dataset.chipsMeasuring = 'true'
  const overflowing = bar.scrollWidth > bar.clientWidth + 1
  delete bar.dataset.chipsMeasuring
  return overflowing
}
