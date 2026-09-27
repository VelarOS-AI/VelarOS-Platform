import { AppError } from '@velaros-ai/core/error'

import { BrowserErrorCodes } from '../../contract/constants.js'
import type { BrowserProtocolChannel } from '../../contract/requires.js'
import { protocolFailure } from '../../utils/cdp/protocol.js'

import type { CdpWebSocketTransportApi } from './CdpWebSocketTransport'

/**
 * 外部浏览器上模型自己的一条 CDP 会话：同一条浏览器级连接上、挂到这一页的第二条 flatten 会话。
 *
 * Chrome 让一个页面挂多条会话，每条会话各有各的域开关、事件订阅、仿真与 Fetch 拦截，驱动自己那条会话不受影响。
 * 模型在这条会话上 `Target.setAutoAttach`（flatten）挂出来的子会话按 sessionId 路由，别的会话发不过去；会话一脱开，Chrome 撤掉它做过的一切。
 */
export class CdpProtocolChannel implements BrowserProtocolChannel {
  private closed = false

  constructor(private readonly transport: CdpWebSocketTransportApi) {
    transport.onClose(() => {
      this.closed = true
    })
  }

  public async send(
    method: string,
    params: Optional<Record<string, unknown>>,
    sessionId?: string
  ): Promise<unknown> {
    if (this.closed)
      throw new AppError(
        BrowserErrorCodes.protocolFailed,
        `${method}：CDP 会话已经断开，再发一条会重新连。`
      )
    try {
      return await this.transport.send(method, params ?? {}, sessionId)
    } catch (error) {
      if (AppError.from(error).code === 'TIMEOUT') throw error
      throw protocolFailure(method, error)
    }
  }

  public onEvent(
    listener: (method: string, params: unknown, sessionId: Optional<string>) => void
  ): () => void {
    return this.transport.onAnyEvent(listener)
  }

  public onClose(listener: () => void): () => void {
    return this.transport.onClose(listener)
  }

  public close(): Promise<void> {
    if (!this.closed) {
      this.closed = true
      this.transport.dispose()
    }
    return Promise.resolve()
  }
}
