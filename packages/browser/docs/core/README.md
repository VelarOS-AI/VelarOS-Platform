# @velaros-ai/browser/core

> `@velaros-ai/browser` 的一个导入切片(`packages/browser/src/core`)。包总览见
> [包 README](../../README.md)。

## 这个切片是什么

浏览器运行时里 **host 无关的那一半**:

- `BrowserPageDriver` 契约本体;
- CDP 页面驱动(`CdpBrowserPageDriver` + `CdpWebSocketTransport`);
- 外部 / 内置浏览器启动器(`CdpExternalBrowserLauncher`、`CloakBrowserLauncher`、
  `CloakBrowserRuntimeResolver`);
- 全部页面**脚本构建器**(`BrowserPageScriptBuilder` 一族);
- CDP 网络 / 模拟 / 性能追踪控制器;
- 挂起事件 broker、工作区产物管理器、共享纯函数;
- 以及不依赖 Electron 的 `CdpBrowserRuntime` 装配件。

**这里没有任何一行 import Electron——连类型都不行。**

## 公共入口

- `@velaros-ai/browser/core` —— Node / CDP 完整运行时。
- `@velaros-ai/browser/core/contracts` —— 浏览器安全 DTO 与确定性策略。

renderer、Web Worker、RPC 与前端测试**只需要共享 DTO 与纯策略时,一律走 `/contracts`**。
该入口不含 CDP 传输、浏览器启动器、文件访问或任何 Node 内置模块,进 bundle 安全。

## 边界

**本切片永远不许 import `electron`(值或类型)**;arch-guard 的 `electron` 规则
与「裸 `require('@velaros-ai/browser/core')`」冒烟测试双重执法,防止急切的宿主值 import 泄进来。

Electron 的那一半——内嵌 WebContents 驱动、`ElectronBrowserRuntime`、会话 / partition 管理、
以及三大引擎的内嵌分支——住 `@velaros-ai/browser/runtime`,它**依赖本切片**,方向不可反。

CDP profile 存储按 member / site 落在宿主注入的数据根下,**从不桥接 Electron partition**
——两套登录存储**刻意不可互操作**。

本切片不注册 agent 工具、不拥有产品 IPC、不做聊天 / 会话编排、不 import 渲染层代码。
面向 agent 的工具在 `@velaros-ai/browser/tools`;Electron 宿主装配在消费方的装配根。

## 引擎切分:用继承分「外部 / 内嵌」

三个领域引擎按载体切成两层,**分支逻辑是逐字节搬过来的,行为不变**:

- `CdpInteractionEngine` / `CdpPageDataEngine`(本切片)持有**外部 / CDP 驱动分支** +
  由 `BrowserPageDriverKernel` 驱动的统一方法 + 全部共享纯函数。
  Electron 侧的 `BrowserInteractionEngine` / `BrowserPageDataEngine`(runtime 切片)**继承**它们:
  每个双载体方法先探测外部会话,走 CDP 就 `super`,本地只留 `webContents` / `nativeImage` 那条内嵌分支。
- `CdpScreenshotEngine`(本切片)是一个**降级版的新增对应物**。Electron 的
  `BrowserScreenshotEngine` 整块留在 runtime,因为它连外部路径都跟 `nativeImage` 耦合
  (裁剪 / 标注 / 模型图 / 差分),而且靠隐藏 `BrowserWindow` 渲染模型视图——这些 CDP 没有等价物。
  本切片的 CDP 版经 `driver.captureScreenshot` 抓字节并保存,**富功能是诚实缺席,不是伪造**。

## `CdpBrowserRuntime`

把 host 无关的零件(动作队列 + 三个外部引擎核 + `BrowserPerformanceOrchestrator` +
`BrowserPendingEventsBroker` + 工作区文件访问 + 前后台双启动器)装成一个**不需要 Electron 的
浏览器自动化运行时**。

`bindBrowserApi(sessionId, context)` 返回一个会话绑定对象,**结构上满足**
`@velaros-ai/browser/tools` 的 `ToolBrowserApi`。这条一致性由
`packages/browser/src/tools/CdpBrowserRuntimeContract.ts` 在**编译期**强制:
方向是 browser-tools → browser-core(**无环**——core 刻意不 import `ToolBrowserApi`),
返回面缺方法或签名漂移就在那里编译报错。

`CdpBrowserRuntime` 在包级由 build / typecheck / lint / schema / 构造冒烟 / 发布 dry-run 各门覆盖;
真机旅程电池、凭据、生命周期与生产装配仍归产品宿主。

## 领域契约住这里,不住 Kernel Core

页面 / 交互 / 网络 / 截图 / 模拟契约,外加 `BrowserActionPolicy`、`BrowserAddressHelper`、
`BrowserScreenshotPolicy`、`BrowserLoginDetection`,**都从本切片导出**。
其他浏览器切片从 `@velaros-ai/browser/core` 取这些契约;`@velaros-ai/core` 只当通用工具依赖。

## CDP 侧「诚实缺席」能力矩阵

| 能力 | Electron(runtime 切片) | CDP(本切片 / `CdpBrowserRuntime`) |
| --- | --- | --- |
| 页面检查 / 查询 / evaluate / 存储 / 等待 | 完整(webview `executeJavaScript`) | 完整(driver `executeJavaScript`) |
| 目标动作 / 自愈 / 效果指纹 | 完整 | 完整(driver) |
| 输入 / 按键 / 点击 / 拖拽 / 移动 | 完整(webview 输入合成) | 完整(driver 对应方法) |
| 网络控制 / 响应体 / 请求详情 / 模拟 | 完整(driver 统一) | 完整(driver 统一) |
| 性能 trace / insight / 堆快照 | 完整 | 完整(`BrowserPerformanceOrchestrator`) |
| PDF 导出 / 取资源 / 上传文件 | 完整 | 完整(driver `printToPdf` / `fetchResource` / `setFileInputFiles`) |
| 截图**抓取 + 保存** | 完整 | 降级——driver PNG 字节,尺寸取自抓取区域 |
| 截图**标注 / 模型图 / 差分** | 完整(`nativeImage`) | **诚实缺席**——需要栅格编解码器,不伪造 |
| 录屏**录制** | 完整 | driver 可录,但↓ |
| 录屏**GIF 合成** | 完整(`nativeImage` 帧解码) | **诚实缺席**——GIF 需要 PNG→RGBA 栅格解码器 |
| 隐藏 `BrowserWindow` 模型视图叠加渲染 | 完整 | **诚实缺席**——CDP 无等价物 |
| 虚拟指针 / 缩放 HUD / 目标高亮叠加层 | 完整(webview 页面脚本) | 缺席(headless 没有预览 UI) |
| 窗口宿主预览 / 画中画流 | 完整 | 不适用(headless) |
| 用户脚本存储 | 完整(`BrowserUserScriptManager`) | 默认缺席——由宿主按 member 数据根注入存储 |

> **读这张表的方式**:凡标「诚实缺席」的格子,CDP 路径会**明确返回不支持**,
> 而不是造一个看起来成功的假结果。表面兼容比功能缺失更贵。

## 生命周期与并发

每个装配根建**一个** `CdpBrowserRuntime`,每个真实页面登记唯一 `sessionId`。
同会话动作经队列串行,跨会话并发。关单会话 `disposeSession()`,应用结束 `dispose()`。

`BrowserPerformanceTraceEngine` **不能在解析途中重置自己**,所以类内部会串行化并发 parse;
不同 runtime 用不同实例,不共享可变解析状态。

## 依赖注入

`CdpBrowserRuntime` 必须注入 `artifactAccess`(产物列举 / 读 / 写的最小文件端口)
与 `scripts`(`BrowserPageScriptBuilder`);前后台 `BrowserExternalPageLauncher` 可选。
`CdpExternalBrowserLauncher` 的进程、文件系统、网络、时钟与 driver 连接**都可替换**,
方便测试与非标准宿主接入。

## 扩展点

- 实现 `BrowserPageDriver` → 接入新的浏览器后端;
- 实现 `BrowserExternalPageLauncher` → 接入远程浏览器或容器;
- 实现 `CdpWorkspaceFileAccess` → 接入对象存储、沙箱或虚拟文件系统;
- 注入 `BrowserResourceRuntimeRegistry` → 接入自定义资源目录。

## 用法

```ts
import {
  BrowserPageScriptBuilder,
  type BrowserPageDriver,
  CdpBrowserPageDriver,
  CdpBrowserRuntime,
  CdpExternalBrowserLauncher,
} from '@velaros-ai/browser/core'
```

## 错误模型

领域失败走 `@velaros-ai/core/error` 的 `AppError`,常见码 `VALIDATION` / `NOT_FOUND` /
`PERMISSION` / `EXECUTION_FAILED`。网络、CDP 与宿主进程的原始异常保留为 cause。
**按错误码分支,不要解析消息文案。**
