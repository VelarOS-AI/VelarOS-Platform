# @velaros-ai/browser/composition

> `@velaros-ai/browser` 的一个导入切片(`packages/browser/src/composition`)。包总览见
> [包 README](../../README.md)。

## 这个切片是什么

React 应用与「**受控浏览器页面**」之间的**合成边界**。

消费方只需要理解会话、页面标题、URL、激活状态和一个渲染回调,
**不需要知道 Electron、WebView 或 CDP 的存在**。这就是本切片的全部价值:
把「页面怎么来的」这件事挡在 React 树之外。

peer 依赖 `react` 19.x。

## 公共入口

只有根入口 `@velaros-ai/browser/composition`。

## 核心概念

- `BrowserCompositionAdapter` —— 宿主提供的**唯一适配口**,负责把语义输入映射成受控页面。
- `ControlledBrowserSurface` —— 稳定的页面投影,含页面状态与宿主渲染函数。
- `ControlledBrowserSurfaceInput` —— 会话 ID、刷新序号、激活令牌。
- `BrowserCompositionProvider` —— 在 React 树里安装适配器。
- `useControlledBrowserSurface()` —— 读当前受控页面。
- `BrowserCompositionError` —— 未安装 Provider 时抛出的带码异常
  (`BROWSER_COMPOSITION_NOT_INSTALLED`)。

## 生命周期与并发

一个 React 应用根安装**一个** Provider。**`adapter` 引用在 Provider 生命周期内必须稳定**
——因为它的方法可以调用宿主 Hook,引用一变就违反 Hook 规则。
并发会话靠 `sessionId` 隔离;本切片自身**不保存任何会话数据**。

## 依赖注入

宿主经 `BrowserCompositionAdapter` 注入实现。具体 browser runtime、状态容器与渲染组件
**都留在宿主侧**;本切片不要求任何特定状态管理库。

## 用法

```tsx
import {
  type BrowserCompositionAdapter,
  BrowserCompositionProvider,
  useControlledBrowserSurface,
} from '@velaros-ai/browser/composition'

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

## 边界

**不拥有** Electron、WebView、CDP、IPC、聊天会话、导航驱动或任何浏览器自动化状态。

- runtime 与驱动原语留在 [`@velaros-ai/browser/runtime`](../runtime/README.md);
- 渲染实现归消费方应用;
- 产品消费者**只依赖 `ControlledBrowserSurface`**,不依赖它下面是什么。

## 错误模型

Provider 缺失时抛 `BrowserCompositionError`。适配器内部错误**原样向上抛**,
由应用自己的错误边界处理——本切片不做统一包装。

## 扩展点

新增宿主实现只要实现 `BrowserCompositionAdapter`。
要加与具体产品无关的页面语义,先扩 `ControlledBrowserSurface`;
Electron 或 CDP 专属字段**留在宿主实现里**,不上浮到契约。
