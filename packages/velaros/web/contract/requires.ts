/**
 * 注入面：`velaros:web` 要宿主塞进来的东西。本单元只经这些口子碰外面（网络、浏览器），别处不留钩子。
 *
 * - 空间端口 `WebSpacePort`：开不显示的页面、报用户选的搜索引擎。页面由宿主的无头浏览器给（Electron 里是 show:false 的窗口），
 *   本单元只往页面里装地址、跑读取脚本，用完关掉。
 * - 页面 `WebPage`：端口开出来的一页。
 * - 搜索引擎退避记忆 `WebEngineBackoff`：可选。宿主存下来（比如一个小 JSON 文件），Google 搜不通之后的退避就能跨重启。
 * - 调用上下文 `WebOperationContext`：宿主分发每一次调用时装好。
 *
 * 这里的每个接口都必须从根入口导出。
 */

import type { WebSearchEngineId } from '../types/web.js'

/**
 * `velaros:web` 的空间端口：宿主的无头浏览器与用户的搜索设置。
 *
 * 开出来的页面用户看不到，也不该留痕迹：放在不落盘的临时会话里（碰不到用户的 Cookie、登录与浏览记录），
 * 弹窗、下载、声音一律不要；不显示的页面要关掉后台节流，不然页面里的定时器和动画帧被压住，单页应用渲染不出来。
 */
export interface WebSpacePort {
  /** 开一个不显示的页面（无头浏览器）；用完必须 close。signal 触发时尽快放弃，已经开出来的交回也行（本单元会关掉它）。 */
  openPage(signal: AbortSignal): Promise<WebPage>
  /** 用户设置里的搜索引擎：搜索先用它，搜不通再换另一个。 */
  searchEngine(): WebSearchEngineId
  /**
   * 可选：跟一跳服务端跳转、不加载目标页面，交回它跳去的地址（响应头里的 Location）；不是跳转交回 null。
   * Google 的结果链接是 `/goto?url=…` 这种不透明的跳转，真实地址不在页面里，只有问一次 Google 才知道；宿主给了它，这些链接才换成真实地址，
   * 不给就原样交出去（read 照样读得了，浏览器会跟着跳）。请求要和页面在同一个临时会话里，signal 触发时放弃。
   */
  resolveRedirect?(url: string, signal: AbortSignal): Promise<Nullable<string>>
  /** 可选：搜索引擎退避记忆，宿主存下来就能跨重启；不给就只记在进程里，重启就忘。 */
  engineBackoff?: WebEngineBackoff
}

/**
 * 搜索引擎退避记忆：某个搜索引擎搜不通之后，到什么时候之前的搜索不再先试它（现在只有 Google 会退避）。
 * 同步读写：宿主启动时把存的读进内存，read 直接交回，write 改内存再自己找时机落盘。每次搜索只 read 一次，只在记下一次搜不通时 write；
 * 两个方法抛错只记一笔，搜索照常（退回进程里的记忆）。
 */
export interface WebEngineBackoff {
  /** 这个搜索引擎退避到什么时候（毫秒时间戳）；没有记录交回 null。 */
  read(engine: WebSearchEngineId): Nullable<number>
  /** 记下这个搜索引擎退避到什么时候（毫秒时间戳）：它刚搜不通。 */
  write(engine: WebSearchEngineId, until: number): void
}

/** 端口开出来的一页：装地址、在页面里跑脚本、读当前地址、关掉。 */
export interface WebPage {
  /**
   * 打开地址，等到页面加载完；加载失败或超时抛错。服务端跳转和页面自己跳走都算同一次加载，等最后落下的那一页。
   * signal 触发时停止加载并尽快失败（本单元按时限触发它，到点之后已经出来的内容照读）。
   */
  load(url: string, signal: AbortSignal): Promise<void>
  /**
   * 在页面里跑一段表达式（可以是 async IIFE），交回可结构化克隆的值；脚本里抛的错照样抛出来。
   * 要当场跑，不等页面加载完：搜索靠它在结果一出现在 DOM 里时就抓。Electron 里用 `webContents.mainFrame.executeJavaScript`——
   * `webContents.executeJavaScript` 会等页面停止加载才跑，那样也能用，只是结果要等整页加载完才抓得到。
   * 页面自己的脚本被禁掉时也要跑得了：响应头的 CSP 带 sandbox 又没给 allow-scripts（比如 raw.githubusercontent.com 上的文件），
   * `mainFrame.executeJavaScript` 以字符串 `'Script not run'` 拒跑，这时改经 `webContents.debugger` 发 DevTools 协议的
   * `Runtime.evaluate`（returnByValue、awaitPromise）；页面自己的脚本照样不跑，跑的只是本单元读页面的这一段。
   */
  evaluate<T>(expression: string): Promise<T>
  /**
   * 当前落下的地址（跳转之后的）。还没落下文档（服务器一个字节都没回来）时是空字符串或 about:blank——
   * 本单元靠这一点分辨 Google 是打不开，还是打得开只是结果页加载得慢。Electron 的 `webContents.getURL()` 就是这样。
   */
  url(): string
  /**
   * 可选：主框架是不是正在加载——有一次导航在进行，包括加载完之后页面自己又跳走的那种。Electron 是 `webContents.isLoadingMainFrame()`。
   * evaluate 当场跑的话，read 等渲染时靠它知道页面正在跳走、还没到最后那一页；不给就只看正文长度稳没稳。
   */
  loading?(): boolean
  /** 关掉这一页，释放它占的一切；关过再关什么也不做。 */
  close(): void
}

/** 每次调用 `velaros:web` 时宿主给的上下文。它不是模型能填的入参：宿主分发这次调用时装好，生成声明时整个丢掉。 */
export interface WebOperationContext {
  /** 本次调用的取消信号：一触发就不再等页面，以取消原因失败，开着的页面照样关掉。 */
  abortSignal: AbortSignal
  /** 宿主的无头浏览器与搜索设置。 */
  web: WebSpacePort
}
