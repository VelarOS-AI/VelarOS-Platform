/**
 * CDP 能力（`velaros:cdp`）的操作：`CdpOperations` 与整个进程唯一的 `cdpOperations`。接口 `CdpOperationsApi` 在本文件的类上方。
 * 与 `velaros:browser`、`velaros:devtools` 共用同一个空间端口 `BrowserSpacePort`；会话本身（第一次用到时建、事件缓冲、兜底放行、断开）在运行时那一侧。
 */

import { toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import {
  BrowserErrorCodes,
  BrowserProtocolLimits,
  BrowserWaitLimits,
} from '../contract/constants.js'
import type { BrowserOperationContext } from '../contract/requires.js'
import type {
  BrowserProtocolEvent,
  BrowserProtocolEvents,
  CdpEventsInput,
  CdpSendInput,
  CdpWaitForEventInput,
} from '../types/browser.js'
import { eventsInput, protocolWaitInput, sendInput } from '../utils/input.js'
import { requireOpenSite } from '../utils/site.js'
import { waitForProtocolEvent } from '../utils/waits.js'

/**
 * @AgentView
 * 直接用 Chrome DevTools Protocol（CDP）操作当前页面：发任意命令、读事件。命令在你自己的一条会话上跑，和宿主那条互不影响：
 * 你开关的域、设的仿真与 Fetch 拦截只算在这条会话上，reset 或 leave 时一并撤掉；会话跨程序保留（上个程序设的深色模式，下个程序里还在）。
 * 事件从会话建起来之后开始记，要收哪个域的事件先 send 它的 enable（Network.enable、Page.enable）。
 * 跨源 iframe 与 worker：先 send Target.setAutoAttach（autoAttach、flatten 为真，waitForDebuggerOnStart 为假），Target.attachedToTarget 事件里的 sessionId 填进 session。
 * 被你用 Fetch 拦下的请求 30000 毫秒没人放行，宿主替你放行，并记一条 Velar.requestAutoContinued 事件。
 * 一条命令的结果按 JSON 超过 10000000 个字符抛 BROWSER_RESULT_TOO_LARGE。都作用在 velaros:browser 当前打开的站点上，没进站点时抛 BROWSER_SITE_NOT_OPEN。
 */
export interface CdpOperationsApi {
  /** @AgentView 发一条 CDP 命令，交回协议原样的结果；协议报错抛 BROWSER_PROTOCOL_FAILED，message 是协议给的原话。
   * @OperationEffect write
   */
  send(input: CdpSendInput, ctx: BrowserOperationContext): Promise<any>
  /** @AgentView 读这条会话收到的事件（最早的在前）。
   * @OperationEffect none
   */
  events(input: CdpEventsInput, ctx: BrowserOperationContext): Promise<BrowserProtocolEvents>
  /** @AgentView 等一条事件到来，交回它（先记下 events 的 last，再触发动作，再从 last 之后等，不会错过）。
   * @OperationEffect none
   */
  waitForEvent(
    input: CdpWaitForEventInput,
    ctx: BrowserOperationContext
  ): Promise<BrowserProtocolEvent>
  /** @AgentView 断开你的会话：开过的域、设过的仿真与拦截、缓冲的事件一并清掉；下一次 send 重新连一条。
   * @OperationEffect write
   */
  reset(ctx: BrowserOperationContext): Promise<void>
}

/**
 * 顺序同另两件能力：先查取消、再核对入参、再确认进了站点、最后经端口做事。会话的生命与事件缓冲都在运行时，这里只核对、限长与轮询。
 * 整个进程共用一份，无状态。
 */
export class CdpOperations implements CdpOperationsApi {
  public async send(input: CdpSendInput, ctx: BrowserOperationContext): Promise<any> {
    ctx.abortSignal.throwIfAborted()
    const command = sendInput(input)
    requireOpenSite(ctx)
    const result = await ctx.browser.sendProtocolCommand(command)
    const chars = JSON.stringify(toNullable(result)).length
    if (chars > BrowserProtocolLimits.resultChars) {
      throw new AppError(
        BrowserErrorCodes.resultTooLarge,
        `${command.method} 的结果按 JSON 有 ${chars} 个字符，超过了上限：缩小范围再取（DOM.getDocument 给 depth，截图给 clip，响应体分几次读）。`
      )
    }
    return result
  }

  public async events(
    input: CdpEventsInput,
    ctx: BrowserOperationContext
  ): Promise<BrowserProtocolEvents> {
    ctx.abortSignal.throwIfAborted()
    const query = eventsInput(input)
    requireOpenSite(ctx)
    return ctx.browser.readProtocolEvents(query)
  }

  public async waitForEvent(
    input: CdpWaitForEventInput,
    ctx: BrowserOperationContext
  ): Promise<BrowserProtocolEvent> {
    ctx.abortSignal.throwIfAborted()
    const options = protocolWaitInput(input)
    requireOpenSite(ctx)
    // 不给 after 就从现在起等新来的：先记下此刻的最后一个序号。
    const after =
      options.after ?? (await ctx.browser.readProtocolEvents({ method: options.method })).last
    return waitForProtocolEvent({
      method: options.method,
      after,
      timeoutMs: options.timeoutMs ?? BrowserWaitLimits.defaultMs,
      abortSignal: ctx.abortSignal,
      readEvents: (query) => ctx.browser.readProtocolEvents(query),
    })
  }

  public async reset(ctx: BrowserOperationContext): Promise<void> {
    ctx.abortSignal.throwIfAborted()
    requireOpenSite(ctx)
    await ctx.browser.resetProtocolSession()
  }
}

/** 整个进程只有一份的 CDP 操作；空间把它挂在代码面的 `cdp` 命名空间上。 */
export const cdpOperations: CdpOperationsApi = new CdpOperations()
