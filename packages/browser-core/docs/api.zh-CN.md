# @velaros-ai/browser-core 中文接口文档

## 定位与非目标

本包提供与宿主无关的浏览器自动化核心：页面驱动协议、CDP 连接与外部浏览器启动器、脚本构建器、动作队列、性能分析、阻塞事件、截图和无 Electron 的 `CdpBrowserRuntime`。

本包不依赖 Electron，不注册 Agent 工具，不拥有 UI、IPC、聊天会话或应用级路由。

## 安装

```bash
npm install @velaros-ai/browser-core @velaros-ai/core
```

完整 CDP 运行时要求 Node.js 20 及以上，外部浏览器需支持 Chrome DevTools
Protocol。只消费 `/contracts` 的浏览器、renderer 或 Web Worker 不需要 Node.js
运行时和 Node 类型声明。

## 公共入口

Node/CDP 运行时从根入口导入：

```ts
import {
  BrowserPageScriptBuilder,
  CdpBrowserPageDriver,
  CdpExternalBrowserLauncher,
  CdpBrowserRuntime,
  BrowserPerformanceTraceEngine,
  BrowserResourceRuntimeRegistry,
  type BrowserPageDriver,
  type CdpWorkspaceFileAccess,
} from '@velaros-ai/browser-core'
```

共享 DTO、地址解析和截图选项归一化使用浏览器安全入口：

```ts
import {
  buildBrowserScreenshotOptions,
  getBrowserSiteHost,
  resolveBrowserSearchOrNavigationInput,
  type BrowserElementSelection,
  type BrowserViewportOptions,
} from '@velaros-ai/browser-core/contracts'
```

`/contracts` 不导出 CDP transport、launcher、文件产物实现或宿主 runtime；它可以
直接进入浏览器 bundle。需要连接真实浏览器时继续使用包根入口。

## 核心类与接口

- `BrowserPageDriver`：页面自动化的宿主无关协议；自定义 Playwright、远程 CDP 或测试驱动应实现它。
- `CdpWebSocketTransport` / `CdpBrowserPageDriver`：标准 CDP WebSocket 传输与页面驱动。
- `CdpExternalBrowserLauncher`：启动 Chrome/Chromium，发现调试端口并返回可释放的会话。
- `CdpBrowserRuntime`：组合驱动、动作引擎、事件和产物访问的无 Electron 运行时。
- `BrowserPageScriptBuilder`：统一生成页面注入脚本。
- `BrowserSessionActionQueue`：按会话串行化有副作用动作。
- `BrowserPendingEventsBroker`：管理 dialog、download、permission 的超时和结算。
- `BrowserPerformanceTraceEngine`：每个 runtime 独占的 trace 解析器，内部串行化解析。
- `BrowserResourceRuntimeRegistry`：宿主拥有的可选 Browser 资源注册表。

## 生命周期/并发

每个应用组合根创建一个 `CdpBrowserRuntime`，每个实际页面登记一个唯一 `sessionId`。同一会话的动作经队列串行执行，不同会话可以并发。关闭单会话调用 `disposeSession()`，应用结束调用 `dispose()`。

`BrowserPerformanceTraceEngine` 不能在解析中重置自身，因此类内部会串行执行并发 parse；不同 runtime 使用不同实例，不共享可变解析状态。

## 依赖注入

`CdpBrowserRuntime` 必须注入：

- `artifactAccess`：列表、读取和写入浏览器产物的最小文件端口；
- `scripts`：`BrowserPageScriptBuilder`；
- 可选的前台、后台 `BrowserExternalPageLauncher`。

`CdpExternalBrowserLauncher` 的进程、文件系统、网络、时钟和 driver 连接均可通过 dependencies 替换，方便测试及非标准宿主接入。

## 错误模型

领域失败使用 `@velaros-ai/core/error` 的 `AppError`，常见代码为 `VALIDATION`、`NOT_FOUND`、`PERMISSION` 和 `EXECUTION_FAILED`。网络、CDP 和宿主进程原始异常保留为 cause。调用方应按错误代码处理，不应解析中文消息。

## 最小第三方示例

```ts
import {
  BrowserPageScriptBuilder,
  CdpBrowserRuntime,
  CdpExternalBrowserLauncher,
} from '@velaros-ai/browser-core'

const runtime = new CdpBrowserRuntime({
  scripts: new BrowserPageScriptBuilder(),
  artifactAccess: {
    listFiles: async () => [],
    readFile: async (path) => ({ path, content: '', totalLines: 0, truncated: false }),
    writeFile: async (path, content) => ({
      path,
      bytes: Buffer.byteLength(content),
      created: true,
      changed: true,
    }),
  },
  foregroundBrowserLauncher: new CdpExternalBrowserLauncher(),
})

try {
  const launched = await runtime.getLaunchers().foreground?.launch({
    executablePath: '/path/to/chrome',
    url: 'https://example.com',
  })
  // 将 launched.driver 注册到业务会话后，再通过 bindBrowserApi 暴露能力。
} finally {
  runtime.dispose()
}
```

## 扩展点

- 实现 `BrowserPageDriver` 接入新的浏览器后端；
- 实现 `BrowserExternalPageLauncher` 接入远程浏览器或容器；
- 实现 `CdpWorkspaceFileAccess` 接入对象存储、沙箱或虚拟文件系统；
- 注入 `BrowserResourceRuntimeRegistry` 接入自定义资源目录。

## 兼容策略

根入口已有导出保持兼容。旧的 `parseBrowserTraceEvents()` 和默认资源单例继续存在，但新代码应使用宿主拥有的 `BrowserPerformanceTraceEngine` 与 `BrowserResourceRuntimeRegistry`。CDP 无法实现的 Electron 专属能力会明确返回不支持，不以伪结果维持表面兼容。
