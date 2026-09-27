/**
 * 注入面：`velaros:web` 要宿主塞进来的东西。本单元只经这些口子碰外面（网络、浏览器），别处不留钩子。
 *
 * - 空间端口 `WebSpacePort`：开不显示的页面、报用户选的搜索引擎。页面由宿主的无头浏览器给（Electron 里是 show:false 的窗口），
 *   本单元只往页面里装地址、跑读取脚本，用完关掉。
 * - 页面 `WebPage`：端口开出来的一页。
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
}

/** 端口开出来的一页：装地址、在页面里跑脚本、读当前地址、关掉。 */
export interface WebPage {
  /**
   * 打开地址，等到页面加载完；加载失败或超时抛错。服务端跳转和页面自己跳走都算同一次加载，等最后落下的那一页。
   * signal 触发时停止加载并尽快失败（本单元按时限触发它，到点之后已经出来的内容照读）。
   */
  load(url: string, signal: AbortSignal): Promise<void>
  /** 在页面里跑一段表达式（可以是 async IIFE），交回可结构化克隆的值；脚本里抛的错照样抛出来。 */
  evaluate<T>(expression: string): Promise<T>
  /** 当前地址（跳转之后的）；还没装地址时是空字符串或 about:blank。 */
  url(): string
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
