import { createContext, type ReactElement, type ReactNode, useContext } from 'react'

import type { BrowserElementSelection } from '../core'

export interface ControlledBrowserSurfaceInput {
  sessionId: string
  workspaceRefreshKey: number
  activationToken: Nullable<string>
}

export interface ControlledBrowserSurfaceRenderOptions {
  onElementPicked: (selection: BrowserElementSelection) => void
  onRequestClose: () => void
}

export interface ControlledBrowserSurface {
  readonly sessionId: string
  readonly active: boolean
  readonly activationToken: Nullable<string>
  readonly page: {
    readonly url: Nullable<string>
    readonly title: string
  }
  /**
   * 宿主拥有具体 Browser stage；产品只请求渲染并提供语义回调。
   * 返回节点不得要求消费方理解 Electron、WebView 或宿主 controller。
   */
  readonly render: (options: ControlledBrowserSurfaceRenderOptions) => ReactNode
}

export interface BrowserCompositionAdapter {
  /** Provider 安装后必须保持实现引用稳定，保证 hook 拓扑固定。 */
  useControlledSurface: (input: ControlledBrowserSurfaceInput) => ControlledBrowserSurface
}

export class BrowserCompositionError extends Error {
  public readonly code = 'BROWSER_COMPOSITION_NOT_INSTALLED'

  constructor() {
    super('Browser composition is not installed')
    this.name = 'BrowserCompositionError'
  }
}

const BrowserCompositionContext = createContext<Nullable<BrowserCompositionAdapter>>(null)

export function BrowserCompositionProvider({
  adapter,
  children,
}: {
  adapter: BrowserCompositionAdapter
  children: ReactNode
}): ReactElement {
  return (
    <BrowserCompositionContext.Provider value={adapter}>
      {children}
    </BrowserCompositionContext.Provider>
  )
}

export function useControlledBrowserSurface(
  input: ControlledBrowserSurfaceInput
): ControlledBrowserSurface {
  const adapter = useContext(BrowserCompositionContext)
  if (!adapter) throw new BrowserCompositionError()
  // Adapter 在应用生命周期内固定，因此这里的宿主 hook 拓扑不会变化。
  return adapter.useControlledSurface(input)
}
