# @velaros-ai/browser/runtime

> `@velaros-ai/browser` 的一个导入切片(`packages/browser/src/runtime`)。包总览见
> [包 README](../../README.md)。

## 这个切片是什么

**Electron 宿主适配层**:内嵌页面驱动、导航与会话管理、诊断、截图、预览流、生命周期装配。

host 中立的脚本、DTO、CDP 驱动、策略与产物契约**不在这里**,住
[`@velaros-ai/browser/core`](../core/README.md);本切片依赖它,方向不可反。

**本切片是全包唯一允许 import `electron` 的地方**(peer dependency,Electron 41+),
capability 架构门机械执法。

## 主要导出

- `ElectronBrowserRuntime` —— Electron 浏览器能力的主生命周期对象。
- `ElectronWebContentsBrowserPageDriver` —— 把 `WebContents` 适配成 core 的 `BrowserPageDriver`。
- `BrowserSessionManager` —— 接管、查找、等待、释放 WebContents 会话。
- `BrowserPageWaiter` —— 统一处理加载 / 选择器 / 页面稳定等待。
- `BrowserDiagnosticsRecorder` —— 保存有界的会话诊断。
- `BrowserInteractionEngine` / `BrowserPageDataEngine` / `BrowserScreenshotEngine` ——
  三大引擎的 Electron 侧(前两个继承 core 的 CDP 版,只留内嵌分支)。
- `createBrowserKernelModule()` —— 可选的 Kernel 模块适配器。

## 设计判决:自动化尽量走 driver

浏览器自动化**应尽可能穿过 `BrowserPageDriver`**,好让同一套检查 / 动作协议既能跑在内嵌 WebView 上,
也能跑在 `CdpBrowserPageDriver` 这样的外部驱动上。只有 WebContents 独有的能力才留本地分支。

外部 CDP 宿主的接法:

- 已有浏览器 → `CdpWebSocketTransport` 或 `CdpBrowserPageDriver.connect(webSocketDebuggerUrl)`;
- 新开 Chrome / Chromium 窗口 → `CdpExternalBrowserLauncher`,它读 `DevToolsActivePort`、
  从 `/json/list` 选一个 page target,返回页面驱动 + 宿主释放函数。

**释放责任分层(容易踩)**:外部 CDP 页面驱动的 dispose **只关当前页面连接**;
被启动的浏览器进程与临时 profile 的清理归 **runtime / session 的 dispose**。
外部 CDP 切目标时按 target id 重连页面驱动,**保留浏览器宿主本身**。

外部 CDP 驱动可以经 `BrowserPageDriver` 的**可选方法**暴露浏览器级能力:
cookie jar 读取、target 清单读取、target 切换、网络诊断 / 请求详情 / 响应体读取、下载、
PDF 导出、文件上传。

## 生命周期与并发

主进程应只建**一个** `ElectronBrowserRuntime`。同 `sessionId` 的有副作用操作串行化,
跨会话并发。关窗口用 `closeSession()` / `closeAllSessions()`,进程退出**必须** `dispose()`。

`createBrowserKernelModule()` 默认**不释放**调用方注入的 runtime;
只有显式设 `disposeInjectedRuntime: true` 才转移释放责任。

## 依赖注入

经 `ElectronBrowserRuntimeOptions` 注入页面驱动工厂、外部浏览器 launcher、回调与宿主策略。
Kernel 模块只依赖公开的 Kernel SDK 能力注册端口,不依赖具体产品 IPC。

## 边界

不注册 agent 工具、不拥有产品 IPC、不做聊天 / 会话编排、不 import 渲染层代码。
面向 agent 的工具在 `@velaros-ai/browser/tools`;宿主装配在消费方的装配根。
**不会把某个应用的 IPC、状态容器或窗口布局塞进公共 API。**

## 用法

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

## 错误模型

参数与会话错误通常用 `AppError`。Kernel callable 边界在反序列化失败时抛稳定的输入错误。
Electron 原始错误可能作为 cause 保留;宿主应在进程边界统一序列化。

## 扩展点

优先经 `ElectronBrowserRuntimeOptions` 与 core 的 `BrowserPageDriver` 扩展。
新的 agent 工具放 `@velaros-ai/browser/tools`;新的 React 合成放 `@velaros-ai/browser/composition`。
