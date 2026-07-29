# @velaros-ai/browser/runtime 中文接口文档

## 定位与非目标

本包是 Electron 宿主适配层，负责 WebContents 页面驱动、内嵌浏览器会话、导航等待、诊断、截图和 Electron Browser runtime 生命周期。

本包不提供 React UI，不注册 Agent 工具，不拥有聊天、项目或产品状态；无 Electron 的应用应使用 `@velaros-ai/browser/core`。

## 安装

```bash
npm install @velaros-ai/browser/runtime @velaros-ai/browser/core electron
```

要求 Node.js 20 及以上，Electron 41 及以上。

## 公共入口

```ts
import {
  ElectronBrowserRuntime,
  ElectronWebContentsBrowserPageDriver,
  BrowserSessionManager,
  BrowserPageWaiter,
  createBrowserKernelModule,
  type ElectronBrowserRuntimeOptions,
} from '@velaros-ai/browser/runtime'
```

## 核心类与接口

- `ElectronBrowserRuntime`：Electron Browser 能力的主要生命周期对象。
- `ElectronWebContentsBrowserPageDriver`：把 `WebContents` 适配为 Browser Core 的页面驱动。
- `BrowserSessionManager`：接管、查找、等待并释放 WebContents 会话。
- `BrowserPageWaiter`：统一处理加载、选择器和页面稳定等待。
- `BrowserDiagnosticsRecorder`：保存有界的会话诊断。
- `createBrowserKernelModule()`：可选的 Kernel SDK 模块适配器。

## 生命周期/并发

应用主进程应只创建一个 `ElectronBrowserRuntime`。同一 `sessionId` 的有副作用操作会串行化；不同会话可以并发。窗口关闭使用 `closeSession()` 或 `closeAllSessions()`，进程退出必须调用 `dispose()`。

`createBrowserKernelModule()` 默认不释放调用方注入的 runtime；只有显式设置 `disposeInjectedRuntime: true` 才转移释放责任。

## 依赖注入

通过 `ElectronBrowserRuntimeOptions` 注入页面驱动工厂、外部浏览器 launcher、回调和宿主策略。Kernel 模块只依赖公开的 Kernel SDK 能力注册端口，不依赖具体产品 IPC。

## 错误模型

参数和会话错误通常使用 `AppError`。Kernel callable 边界在反序列化失败时抛出稳定的输入错误。Electron 原始错误可能作为 cause 保留；宿主应在进程边界统一序列化。

## 最小第三方示例

```ts
import type { BrowserSiteContext } from '@velaros-ai/browser/core'
import { ElectronBrowserRuntime } from '@velaros-ai/browser/runtime'

const browser = new ElectronBrowserRuntime({
  onSessionSiteChange(sessionId, url) {
    applicationStore.updateBrowserUrl(sessionId, url)
  },
})

export function present(
  sessionId: string,
  context: BrowserSiteContext,
  webContents: Electron.WebContents,
) {
  return browser.presentPage(sessionId, context, webContents.id)
}

app.on('before-quit', () => browser.dispose())
```

## 扩展点

优先通过 `ElectronBrowserRuntimeOptions` 和 Browser Core 的 `BrowserPageDriver` 扩展。新的 Agent 工具放在 `@velaros-ai/browser/tools`；新的 React 组合放在 `@velaros-ai/browser/composition`。

## 兼容策略

已有 runtime 方法和 Kernel capability ID 保持兼容。Electron 仅作为 peer dependency；本包不会把某个应用的 IPC、状态容器或窗口布局加入公共 API。
