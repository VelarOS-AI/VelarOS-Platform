import { type RefObject, useEffect } from 'react'

/**
 * 挂载时聚焦目标元素（零耦合叶子 hook，随输入卡入包）。等价于宿主 `useAutoFocus`（useMount →
 * 空依赖 useEffect，行为一致）。
 */
export function useAutoFocus<T extends HTMLElement>(ref: RefObject<Nullable<T>>): void {
  useEffect(() => {
    ref.current?.focus()
  }, [ref])
}
