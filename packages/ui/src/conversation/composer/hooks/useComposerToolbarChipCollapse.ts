import { type RefCallback, useCallback, useState } from 'react'

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
 * ## 为什么是 callback ref 而不是 useLayoutEffect
 * 芯片条**没有活动芯片时整个返回 null**。挂在对象 ref + 空依赖 effect 上时，组件首次挂载那一刻
 * 根本没有 DOM，effect 读到 null 就放弃了，而它此后再也不会重跑——用户后来打开计划模式、芯片
 * 出现，观察者一个都没装上，于是标签只会被 `overflow: hidden` 切掉一半而永远不塌成图标。
 * callback ref 精确跟随元素的挂载与卸载，天然没有这个时序洞。
 */
export function useComposerToolbarChipCollapse(): {
  attachBar: RefCallback<HTMLDivElement>
  collapsed: boolean
} {
  const [collapsed, setCollapsed] = useState(false)

  const attachBar = useCallback<RefCallback<HTMLDivElement>>((bar) => {
    if (!bar) return undefined

    const sync = (): void => {
      setCollapsed(measureComposerChipOverflow(bar))
    }
    sync()

    // 非浏览器宿主（SSR / 裁剪版 jsdom）缺这两个观察者时静默降级：挂载那次 sync 已经给出正确
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

  return { attachBar, collapsed }
}

/** 在强制展开态下判断芯片条是否已经装不下；导出仅供测试直读这条判据。 */
export function measureComposerChipOverflow(bar: HTMLElement): boolean {
  bar.dataset.chipsMeasuring = 'true'
  const overflowing = bar.scrollWidth > bar.clientWidth + 1
  delete bar.dataset.chipsMeasuring
  return overflowing
}
