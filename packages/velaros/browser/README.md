# @velaros-ai/velaros/browser

浏览器能力：代码面的三件，`velaros:browser`（进站、看页面、页面脚本、真实键鼠输入、等待、弹窗下载与权限、导出）、`velaros:devtools`（控制台与网络诊断、网络规则、性能 trace、堆快照、录屏、用户脚本）、`velaros:cdp`（模型自己的一条 CDP 会话），连同底下的 CDP 驱动、页面引擎、Electron 会话运行时与站点工作区。宿主的浏览器空间挂它，Electron 主进程持有运行时，渲染进程只拿纯策略与 React 合成边界。

## 用法

```ts
import { createCapabilityModule } from '@velaros-ai/velaros'
import { AppError } from '@velaros-ai/core/error'
import type { OperationContext } from '@velaros-ai/kernel'
import {
  browserOperations,
  cdpOperations,
  createBrowserLoginGate,
  devtoolsOperations,
  type BrowserLoginGatePort,
  type BrowserOperationContext,
  type BrowserSpacePort,
  type ElectronBrowserRuntimeApi,
} from '@velaros-ai/velaros/browser'
import {
  BrowserErrorCodes,
  VelarBrowserModule,
  VelarCdpModule,
  VelarDevtoolsModule,
} from '@velaros-ai/velaros/browser/contracts'
import { createElectronBrowserRuntime } from '@velaros-ai/velaros/browser/electron'

// Electron 主进程一份运行时，按会话管页面；应用退出时 runtime.dispose()
const runtime = createElectronBrowserRuntime()

// 宿主给：按会话把运行时拼成空间端口（运行时的方法带 sessionId，端口已经绑好会话与站点），
// 以及登录墙的确认卡（没有审批通道就回 { approved: false }）
declare function bindSession(runtime: ElectronBrowserRuntimeApi, sessionId: string): BrowserSpacePort
declare const loginApproval: BrowserLoginGatePort

// 登录墙门控包在端口外面，一个浏览器会话一份
const browser = createBrowserLoginGate(loginApproval).wrap(bindSession(runtime, 'chat-1'))

// 宿主自己调用：先 open 进站点，要页面的操作才能用
const context: BrowserOperationContext = { abortSignal: new AbortController().signal, browser }
await browserOperations.open({ url: 'https://example.com' }, context)
try {
  console.log(await browserOperations.evaluate({ script: 'document.title' }, context))
} catch (error) {
  if (!(error instanceof AppError && error.code === BrowserErrorCodes.scriptFailed)) throw error
  console.warn(error.message) // 页面里抛的错：错误名、原话与它在 script 里的行列
}

// 挂成模型程序里可以 import 的三件能力；截图的图经 attachImage 交给模型
const mount = (call: OperationContext): BrowserOperationContext => ({
  abortSignal: call.signal,
  browser,
  attachImage: (image) => call.attach({ type: 'image-data', ...image }),
})
export const browserModules = [
  createCapabilityModule({ surface: VelarBrowserModule, implementation: browserOperations, instanceId: 'chat-1', context: mount }),
  createCapabilityModule({ surface: VelarDevtoolsModule, implementation: devtoolsOperations, instanceId: 'chat-1', context: mount }),
  createCapabilityModule({ surface: VelarCdpModule, implementation: cdpOperations, instanceId: 'chat-1', context: mount }),
]
```

## 入口

| 入口 | 运行环境 | 内容 |
| --- | --- | --- |
| `@velaros-ai/velaros/browser` | Node | `browserOperations`、`devtoolsOperations`、`cdpOperations`，站点工作区 `createBrowserSiteWorkspaceFileAccess`、用户脚本 `createBrowserUserScriptStore`、登录墙 `createBrowserLoginGate`、动作策略 `browserActionPolicy`；另三个入口里公开接口的类型也在这里 |
| `@velaros-ai/velaros/browser/contracts` | 任何进程 | 错误码 `BrowserErrorCodes`、上限表、偏好闭集、可移植数据、三件模型面 `VelarBrowserModule`、`VelarDevtoolsModule`、`VelarCdpModule` |
| `@velaros-ai/velaros/browser/renderer` | 渲染进程 | 地址栏 `browserAddress`、偏好 `browserPreferences`、截图选项 `browserScreenshotPolicy`，React 合成边界 `browserComposition` |
| `@velaros-ai/velaros/browser/electron` | Electron 主进程 | 运行时 `createElectronBrowserRuntime`，挂进内核的 `createBrowserKernelModule` 与令牌 `BrowserRuntimeCapability` |

## 约定

- 没 `open` 进站点（或已经 `leave`）时，要页面的操作一律抛 `BROWSER_SITE_NOT_OPEN`，端口上碰页面的方法一次都不调；`state` 照样回答。
- 入参在做事之前核对，顶层是严格对象，不对抛 `VALIDATION`（message 点名操作与字段），端口不调。
- 页面脚本抛错是 `BROWSER_SCRIPT_FAILED`，结果超过只为守住内存的上限是 `BROWSER_RESULT_TOO_LARGE`（不交半截），CDP 命令被协议拒绝是 `BROWSER_PROTOCOL_FAILED`，框架不在是 `BROWSER_FRAME_NOT_FOUND`；三种等待与 cdp 的 `waitForEvent` 等不到一律抛 `TIMEOUT`，不回半成品。
- 不替程序折叠：不给上限就按常量表的上限要，结果按 JSON 整份交回，要多少由程序自己切。
- 截图原图落进站点工作区，压缩图经 `attachImage` 交给模型、不进返回值；不给 `attachImage` 时照样落盘，只是模型看不到图。
- 整页与比一屏大的区域按一屏切块截再拼，页面不滚动、版面不变。带编号、区域、整页截图会临时改动页面画面（编号画进页面，每块都要按那一块重画一帧）：宿主给了 `onPageCaptureFreeze`，界面里的 `<webview>` 截之前先把此刻这一屏交给宿主盖住页面、等它盖好，截完再调一次（`null`）拿掉；画中画这段时间停在截之前的画面上。
- 站点工作区是硬边界：写只写当前根，读可以回退到历史根，`..`、绝对路径与指到根外的路径一律拒绝；截图、下载、PDF、trace、堆快照、录屏都落在这里。
- 同一个浏览器会话的动作按会话串行；运行时一个宿主进程一份，状态全在实例上，应用退出时 `dispose()`。
- 外部浏览器（`launchExternalBrowserPage`）先接用户开着的 Chrome（默认配置目录里有 DevToolsActivePort，即用户在 chrome://inspect/#remote-debugging 打开了远程调试，Chrome 弹窗请用户允许；`preferRunningBrowser: false` 一概不碰），再接 `userDataDir` 上开着的，都没有才拉起。每个浏览器只连一条浏览器级 WebSocket、不用 HTTP 的 /json 端点，每个会话在上面另开一个标签页；关会话只关它的标签页，`hasExternalPage` 回答会话的标签页还在不在（用户关了标签页或退出浏览器就不在）；`dispose()` 断开连接、杀掉自己拉起的浏览器，用户自己的 Chrome 从不关、也不改它的下载行为。
- 登录墙门控只包 `inspectPage` 与 `captureScreenshot`，每个站点每会话最多问一次，问过之后批准还是拒绝都不再阻塞；拿不到审批通道的宿主必须回 `approved: false`，不能静默放行。
- 模型的 CDP 会话与宿主那条分开，第一次用到才连；`reset`、`leave`、关会话时断开，它开的域、设的仿真与拦截一并撤掉；被它的 Fetch 拦下 30 秒没人放行的请求由运行时放行。
- 不给模型的协议会话设闸，隔离靠会话分开；要按用户的开关拦动作，用 `browserActionPolicy.check` 按宿主给的允许与拒绝表裁决。
- 模型建的用户脚本一律先停用，启用由宿主界面做；`@match` 先过、`@exclude` 一票否决，启用与否不改变匹配判定。
- 外部 Chrome（CDP）与内嵌页面（Electron partition）的登录态互不相通，不桥接；外部浏览器做不到的能力如实回报不支持。
- `./browser/contracts` 与 `./browser/renderer` 不碰 Node 内置模块，渲染进程可以直接加载；`./browser/electron` 要装 `electron`（可选 peer），只在 Electron 主进程加载。
- `createBrowserKernelModule({ runtime })` 挂进内核后运行时仍归产品，`disposeInjectedRuntime: true` 才由内核卸载时释放。
