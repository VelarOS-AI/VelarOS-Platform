import { isNonBlankString, isNotNull, optionalWhen } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { Log } from '@velaros-ai/core/logger'

import { BrowserErrorCodes } from '../../contract/constants.js'
import type {
  CdpBrowserPageDriverTransport,
  CdpDomDescribeNodeResponse,
  CdpDomFrameOwnerResponse,
  CdpDomResolveNodeResponse,
  CdpPageGetFrameTreeResponse,
  CdpRuntimeEvaluateResponse,
  CdpSessionFrame,
  CdpTargetAttachedEvent,
  CdpTargetDetachedEvent,
} from '../../types/cdp.js'
import {
  cdpFrameTreeOrigin,
  flattenCdpFrameTree,
  readRuntimeEvaluateValue,
} from '../../utils/cdp/driver'

/**
 * 外部浏览器页面的框架，含跨进程的 iframe：列框架树、在某个子框架里跑脚本。
 *
 * 跨源 iframe 在 Chrome 里是另一个进程的 target，驱动那条连接的 Page.getFrameTree 看不到它。第一次要框架时在那条连接上开
 * Target.setAutoAttach（flatten，不停在调试器上），挂出来的 iframe 子会话记在表里：之后新出现的自动挂上、没了就划掉，子会话里再套的也一层层挂。
 * 在子框架里跑脚本与内嵌页面的 WebFrameMain.executeJavaScript 同一口径——框架自己的主世界，页面的 JavaScript 对象都看得见：
 * 子会话的顶层框架直接在那条会话上 Runtime.evaluate；同一进程里的子框架先经 DOM 取到它的 document，再在它上面 Runtime.callFunctionOn。
 */
export interface CdpFrameSessionsApi {
  /** 顶层与各层 iframe（含跨进程的）一维列出，每个框架带上它归哪条会话。 */
  listFrames(): Promise<CdpSessionFrame[]>
  /** 在一个子框架自己的主世界里跑一段表达式，交回它的值；框架已经不在了抛 BROWSER_FRAME_NOT_FOUND。 */
  evaluateInFrame(frame: CdpSessionFrame, script: string, userGesture: boolean): Promise<unknown>
  /** 退订、忘掉挂出来的子会话。 */
  dispose(): void
}

export class CdpFrameSessions implements CdpFrameSessionsApi {
  private readonly log = Log.tag('CdpFrameSessions')
  /** 挂出来的 iframe 子会话，按挂上的先后。 */
  private readonly sessions = new Set<string>()
  private readonly unsubscribers: Array<() => void> = []
  private attaching: Nullable<Promise<void>> = null

  constructor(private readonly transport: CdpBrowserPageDriverTransport) {}

  public async listFrames(): Promise<CdpSessionFrame[]> {
    await this.ensureAttached()
    const root = await this.transport.send<CdpPageGetFrameTreeResponse>('Page.getFrameTree')
    const topOrigin = cdpFrameTreeOrigin(root.frameTree)
    const frames: CdpSessionFrame[] = flattenCdpFrameTree(root.frameTree).map((info, index) => ({
      info,
      session: null,
      sessionRoot: index === 0,
    }))
    for (const session of this.sessions) {
      const tree = await this.readSessionFrameTree(session)
      if (!isNotNull(tree)) continue
      frames.push(
        ...flattenCdpFrameTree(tree, topOrigin).map((info, index) => ({
          info,
          session,
          sessionRoot: index === 0,
        }))
      )
    }
    return frames
  }

  public async evaluateInFrame(
    frame: CdpSessionFrame,
    script: string,
    userGesture: boolean
  ): Promise<unknown> {
    const session = optionalWhen(isNonBlankString, frame.session)
    if (frame.sessionRoot) {
      const response = await this.transport.send<CdpRuntimeEvaluateResponse>(
        'Runtime.evaluate',
        { expression: script, awaitPromise: true, returnByValue: true, userGesture },
        session
      )
      return readRuntimeEvaluateValue(response)
    }

    const objectId = await this.resolveFrameDocument(frame, session)
    try {
      // 包在同一行里：script 的第一行还是求值源码的第一行，报错时的行号照旧能换算回 script 里的行号。
      const response = await this.transport.send<CdpRuntimeEvaluateResponse>(
        'Runtime.callFunctionOn',
        {
          objectId,
          functionDeclaration: `async function () { return await (${script}\n) }`,
          awaitPromise: true,
          returnByValue: true,
          userGesture,
        },
        session
      )
      return readRuntimeEvaluateValue(response)
    } finally {
      void this.transport.send('Runtime.releaseObject', { objectId }, session).catch(() => {
        // arch-guard:silent-catch-ok 框架可能已经跟着页面没了：句柄随它一起释放，没有什么要做的。
      })
    }
  }

  public dispose(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe()
    this.unsubscribers.splice(0, this.unsubscribers.length)
    this.sessions.clear()
  }

  /** 第一次要框架时开自动挂接；开不起来（传输不报事件、浏览器不支持）就只有驱动那条连接上的框架。 */
  private ensureAttached(): Promise<void> {
    this.attaching ??= this.attach().catch((error) => {
      this.log.debug('跨进程 iframe 的子会话挂不上，框架只列驱动那条连接上的', {
        error: AppError.from(error).message,
      })
    })
    return this.attaching
  }

  private async attach(): Promise<void> {
    if (!this.transport.onAnyEvent) return
    this.unsubscribers.push(
      this.transport.onAnyEvent((method, params) => this.handleEvent(method, params))
    )
    await this.autoAttach(undefined)
  }

  /** 在一条会话上开自动挂接：Chrome 在回包之前就把已有的 iframe 挂好、事件发完，所以回包到了表就是全的。 */
  private autoAttach(session: Optional<string>): Promise<unknown> {
    return this.transport.send(
      'Target.setAutoAttach',
      {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
        filter: [{ type: 'iframe', exclude: false }],
      },
      session
    )
  }

  private handleEvent(method: string, params: unknown): void {
    if (method === 'Target.attachedToTarget') {
      const { sessionId, targetInfo } = params as CdpTargetAttachedEvent
      if (!isNonBlankString(sessionId) || targetInfo?.type !== 'iframe') return
      this.sessions.add(sessionId)
      void this.autoAttach(sessionId).catch((error) => {
        this.log.debug('iframe 子会话里再套的 iframe 挂不上', {
          error: AppError.from(error).message,
        })
      })
      return
    }
    if (method === 'Target.detachedFromTarget') {
      const { sessionId } = params as CdpTargetDetachedEvent
      if (isNonBlankString(sessionId)) this.sessions.delete(sessionId)
    }
  }

  /** 读一条子会话上的框架树；子会话刚好没了就是 null。 */
  private async readSessionFrameTree(session: string): Promise<unknown> {
    try {
      const response = await this.transport.send<CdpPageGetFrameTreeResponse>(
        'Page.getFrameTree',
        {},
        session
      )
      return response.frameTree
    } catch (error) {
      this.log.debug('iframe 子会话的框架树读不到，多半跟着页面没了', {
        error: AppError.from(error).message,
      })
      return null
    }
  }

  /** 同一进程里的子框架：经它的宿主元素取到它的 document，交回 document 在框架主世界里的对象句柄。 */
  private async resolveFrameDocument(
    frame: CdpSessionFrame,
    session: Optional<string>
  ): Promise<string> {
    const missing = (error?: unknown): AppError =>
      new AppError(
        BrowserErrorCodes.frameNotFound,
        `框架 ${frame.info.id}（${frame.info.url}）已经不在页面里了（页面跳转之后旧 id 作废）：重新 frames()。`,
        error
      )
    try {
      const owner = await this.transport.send<CdpDomFrameOwnerResponse>(
        'DOM.getFrameOwner',
        { frameId: frame.info.id },
        session
      )
      const described = await this.transport.send<CdpDomDescribeNodeResponse>(
        'DOM.describeNode',
        { backendNodeId: owner.backendNodeId },
        session
      )
      const resolved = await this.transport.send<CdpDomResolveNodeResponse>(
        'DOM.resolveNode',
        { backendNodeId: described.node?.contentDocument?.backendNodeId },
        session
      )
      const objectId = resolved.object?.objectId
      if (!isNonBlankString(objectId)) throw missing()
      return objectId
    } catch (error) {
      if (AppError.from(error).code === BrowserErrorCodes.frameNotFound) throw error
      throw missing(error)
    }
  }
}
