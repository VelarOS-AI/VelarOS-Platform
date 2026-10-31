# @velaros-ai/velaros/web

网上查资料：代码面 `velaros:web` 的 `search`（用搜索引擎搜，交回标题、真实地址与摘要）与 `read`（把一个网页读成分段的正文）。浏览器由宿主给——一个用户看不到的无头页面；本单元往页面里装地址、跑读取脚本、解跳转链接、整理结果、切分正文，用完关掉。

## 用法

```ts
import { createCapabilityModule } from '@velaros-ai/velaros'
import { AppError } from '@velaros-ai/core/error'
import { type WebOperationContext, webOperations, type WebSpacePort } from '@velaros-ai/velaros/web'
import { VelarWebModule, WebErrorCodes } from '@velaros-ai/velaros/web/contracts'

// 宿主给：不显示的页面（Electron 里是 show:false、不落盘临时分区的窗口）与用户设置里的搜索引擎
declare const web: WebSpacePort

// 宿主自己调用（界面、测试）
const context: WebOperationContext = { abortSignal: new AbortController().signal, web }
try {
  const { engine, results } = await webOperations.search({ query: 'Node.js 事件循环', limit: 5 }, context)
  const page = await webOperations.read({ url: results[0]!.url }, context)
  console.log(engine, page.title, page.totalChars, page.nextOffset)
} catch (error) {
  if (!(error instanceof AppError && error.code === WebErrorCodes.searchFailed)) throw error
  console.warn(error.message) // 两个搜索引擎都搜不了：message 写着两边各自为什么
}

// 挂成模型程序里可以 import 的 velaros:web；两个操作都没有效果（none），观察脚本里也能调
export const webModule = createCapabilityModule({
  surface: VelarWebModule,
  implementation: webOperations,
  instanceId: 'web',
  context: (call) => ({ abortSignal: call.signal, web }),
})
```

宿主的端口大致这样接（Electron 主进程）：`openPage` 开一个 `show: false`、`webPreferences: { partition: '<不带 persist: 的临时名字>', backgroundThrottling: false }` 的窗口，拒掉弹窗与下载；`load` 用 `webContents.loadURL`，signal 触发时 `webContents.stop()`；`evaluate` 用 `webContents.mainFrame.executeJavaScript`（当场跑；`webContents.executeJavaScript` 要等页面停止加载才跑，搜索就快不起来），它以字符串 `'Script not run'` 拒跑时（响应头 CSP 带 sandbox 的页面，比如 raw.githubusercontent.com 上的文件）改经 `webContents.debugger` 发 DevTools 协议的 `Runtime.evaluate`（`returnByValue`、`awaitPromise`），页面自己的脚本照样不跑；`url` 是 `webContents.getURL()`；可选的 `loading` 是 `webContents.isLoadingMainFrame()`（read 靠它等加载完之后又自己跳走的页面）；`close` 是 `window.destroy()`；可选的 `resolveRedirect` 在同一个会话里用 `net.request({ redirect: 'manual' })` 读 302 的 Location；可选的 `engineBackoff` 启动时把 JSON 文件读进内存，`read` 从内存交回，`write` 改内存再落盘。完整的一份在 `test/probes/electron-web.probe.mjs`。

## 入口

| 入口 | 运行环境 | 内容 |
| --- | --- | --- |
| `@velaros-ai/velaros/web` | Node | `webOperations`、宿主要给的 `WebSpacePort`、`WebPage` 与 `WebEngineBackoff`、调用上下文 `WebOperationContext` |
| `@velaros-ai/velaros/web/contracts` | 任何进程 | 错误码 `WebErrorCodes`、上限 `WebLimits`、入参与结果、模型面 `VelarWebModule` |

## 约定

- 只经端口碰外面：本单元不发网络请求、不起进程，开页面与（可选的）问跳转都由宿主做。页面要放在不落盘的临时会话里（碰不到用户的 Cookie、登录与浏览记录），用户看不到；要关掉后台节流，不然单页应用渲染不出来。建议给页面一个正常的 Chrome UA（去掉 `Electron/…` 那段），不然搜索引擎更容易把它拦成验证页。
- 每次尝试开一个新页面，用完在 finally 里 `close`：搜成、搜不通、打不开、超时、取消都一样；撒手之后宿主才开出来的页面也会被关掉。`close` 要能重复调用，抛错只记一笔。
- 结果一出现在 DOM 里就抓：文档落下之后每 150 毫秒看一眼结果页，认出了结果、DOM 解析完（或条数稳住 300 毫秒）就用，并叫停剩下的加载；一条都没有时照旧等页面加载完或到点。
- 搜索先用 `searchEngine()` 报的那个，搜不通（加载出错、超时、被拦成验证页或同意页、认不出结果）换另一个。Google 4.5 秒连一个文档都没落下（打不开时连接一直挂着）就换 Bing，文档落下了只是结果页慢的照等到加载时限。Google 短暂网络失败后冷却 1 分钟再探测；明确验证、同意或限流页冷却 15 分钟，期间直接走 Bing：进程里记一份，端口给了 `engineBackoff` 也记在那里（宿主存进一个小 JSON 文件就能跨重启），每次搜索读一次、失败时写；旧版超长冷却收敛到最多 15 分钟，并行请求最多一个 Google 探测在途。两边都搜不了抛 `WEB_SEARCH_FAILED`；Bing 明说没有结果交回空的 results。
- Bing 的跳转链接在本地解开；Google 现在给的是 `/goto?url=<令牌>`，真实地址只有问一次 Google 才知道：端口给了 `resolveRedirect` 就一批并发问（有时限），不给或问不出来的原样交出去，`read` 照样读得了。
- `read` 加载完之后等单页应用渲染（有上限），读出 article 或 main（占大半正文时）或整个 body 的 innerText，按字符分段；每次 `read` 都重新打开网页。网页的正文并好空白、段落之间空一行；纯文本文件（媒体类型是 text/ 下除 HTML、XML 之外的，或 JSON、JavaScript）空白就是内容，原样交回，只统一换行、去掉开头的空行与末尾的空白。页面禁了脚本（CSP sandbox）也照样读，前提是宿主的 `evaluate` 在这种页上跑得了（见上面的接法）。打不开抛 `WEB_PAGE_UNREACHABLE`，PDF 或读正文的脚本没跑成抛 `WEB_PAGE_UNREADABLE`；到点还在加载但已经有正文的照读。
- 超时与各种时长在 `utils/tuning.ts`；`WebPage.load` 要把服务端跳转与页面自己跳走算成同一次加载（Electron 的 `loadURL` 遇到页面自己跳走会以 `ERR_ABORTED` 失败，探针里有接法）。
- 取消以 `abortSignal` 的原因失败，不等页面；入参不对是 `VALIDATION`，一个页面都不开。
