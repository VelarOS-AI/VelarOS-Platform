import { createContext, createElement, type ReactElement, type ReactNode, useContext } from 'react'

import { AppError } from '@velaros-ai/core/error'

import { BrowserErrorCodes } from '../contract/constants'
import type { BrowserCompositionAdapter, ControlledBrowserSurface } from '../contract/requires'
import type { ControlledBrowserSurfaceInput } from '../types/browser'

/**
 * React 合成边界：产品只说「我要一个受控浏览器页面」，具体怎么渲染由宿主装的适配器决定。
 *
 * 为什么要这一层：受控页面是宿主的东西（Electron 的 WebContentsView、Workbench 的独立窗口），产品侧不该
 * 知道它长什么样；这里只把适配器经 React context 传下去，并保证 hook 拓扑固定——适配器在应用生命周期内不换，
 * 所以 `useControlledSurface` 里调宿主 hook 不会违反 hooks 规则。
 *
 * 实例归进程：context 是实例字段，文件末尾给出进程唯一的一份。
 */
export interface BrowserCompositionApi {
  /** 装适配器：包在产品树外面，里面的组件才能拿到受控页面。 */
  Provider(props: { adapter: BrowserCompositionAdapter; children: ReactNode }): ReactElement
  /** 取一个受控浏览器页面；没装 Provider 时按 `BrowserErrorCodes.compositionNotInstalled` 报错。 */
  useControlledSurface(input: ControlledBrowserSurfaceInput): ControlledBrowserSurface
}

export class BrowserComposition implements BrowserCompositionApi {
  private readonly context = createContext<Nullable<BrowserCompositionAdapter>>(null)

  public Provider({
    adapter,
    children,
  }: {
    adapter: BrowserCompositionAdapter
    children: ReactNode
  }): ReactElement {
    // 用 createElement 写而不是 JSX：本包的合成边界要留在 .ts 里，门禁只扫 .ts。
    return createElement(this.context.Provider, { value: adapter }, children)
  }

  public useControlledSurface(input: ControlledBrowserSurfaceInput): ControlledBrowserSurface {
    const adapter = useContext(this.context)
    if (!adapter) {
      throw new AppError(
        'VALIDATION',
        '当前界面没有装浏览器合成 Provider，拿不到受控页面。',
        undefined,
        {
          reason: BrowserErrorCodes.compositionNotInstalled,
        }
      )
    }
    // 适配器在应用生命周期内固定，因此这里的宿主 hook 拓扑不会变化。
    return adapter.useControlledSurface(input)
  }
}

/** 进程唯一的一份：一个渲染进程只有一套合成边界。 */
export const browserComposition: BrowserCompositionApi = new BrowserComposition()
