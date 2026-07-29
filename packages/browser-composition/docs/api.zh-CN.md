# @velaros-ai/browser-composition 中文接口文档

## 定位与非目标

本包是 React 应用与“受控浏览器页面”之间的组合边界。消费方只理解会话、页面标题、URL、激活状态和渲染回调，不需要知道 Electron、WebView 或 CDP。

本包不创建浏览器进程，不管理页面会话，不执行自动化动作，也不拥有产品路由或聊天状态。

## 安装

```bash
npm install @velaros-ai/browser-composition @velaros-ai/browser-core react
```

要求 Node.js 20 及以上用于构建；运行时 React 版本为 19.x。

## 公共入口

仅使用根入口：

```ts
import {
  BrowserCompositionProvider,
  BrowserCompositionError,
  useControlledBrowserSurface,
  type BrowserCompositionAdapter,
  type ControlledBrowserSurface,
} from '@velaros-ai/browser-composition'
```

## 核心类与接口

- `BrowserCompositionAdapter`：宿主提供的唯一适配口，负责把语义输入映射为受控页面。
- `ControlledBrowserSurface`：稳定的页面投影，包含页面状态和宿主渲染函数。
- `ControlledBrowserSurfaceInput`：会话 ID、刷新序号和激活令牌。
- `BrowserCompositionProvider`：在 React 树中安装适配器。
- `useControlledBrowserSurface()`：读取当前受控页面。
- `BrowserCompositionError`：未安装 Provider 时抛出的带错误码异常。

## 生命周期/并发

一个 React 应用根应安装一个 Provider。`adapter` 引用在 Provider 生命周期内必须稳定，因为它的方法可以调用宿主 Hook。并发会话由 `sessionId` 隔离；本包自身不保存会话数据。

## 依赖注入

宿主通过 `BrowserCompositionAdapter` 注入实现。具体 Browser runtime、状态容器和渲染组件都留在宿主侧。本包不要求特定状态管理库。

## 错误模型

Provider 缺失时抛出 `BrowserCompositionError`，其 `code` 为 `BROWSER_COMPOSITION_NOT_INSTALLED`。适配器内部错误保持原样向上抛出，由应用错误边界处理。

## 最小第三方示例

```tsx
import {
  BrowserCompositionProvider,
  useControlledBrowserSurface,
  type BrowserCompositionAdapter,
} from '@velaros-ai/browser-composition'

const adapter: BrowserCompositionAdapter = {
  useControlledSurface(input) {
    return useMyApplicationBrowserSurface(input.sessionId)
  },
}

function BrowserPanel({ sessionId }: { sessionId: string }) {
  const surface = useControlledBrowserSurface({
    sessionId,
    workspaceRefreshKey: 0,
    activationToken: null,
  })

  return surface.render({
    onElementPicked: console.log,
    onRequestClose: () => closeSession(sessionId),
  })
}

export function App() {
  return (
    <BrowserCompositionProvider adapter={adapter}>
      <BrowserPanel sessionId="customer-session-1" />
    </BrowserCompositionProvider>
  )
}
```

## 扩展点

新增宿主实现只需实现 `BrowserCompositionAdapter`。若要增加与具体产品无关的页面语义，应先扩展 `ControlledBrowserSurface`；Electron 或 CDP 专属字段应留在宿主实现中。

## 兼容策略

0.x 期间保持现有 Provider、Hook 和接口字段兼容；新增字段优先为可选字段。`BrowserCompositionError` 是新增的稳定错误类型，不改变原错误消息。
