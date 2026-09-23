/** CDP 传输层里用不着实例状态的那部分：JSON-RPC 报文的判定与解析。 */

import { AppError } from '@velaros-ai/core/error'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type { CdpJsonRpcMessage, CdpWebSocketLike } from '../../types/cdp.js'
import { BrowserTuning } from '../tuning'

/** 解析一条 CDP 的 JSON-RPC 报文；解析不了就给一条报错。 */
export function parseMessage(rawData: string): Nullable<CdpJsonRpcMessage> | AppError {
  try {
    return JSON.parse(rawData) as CdpJsonRpcMessage
  } catch (error) {
    return new AppError('VALIDATION', '收到无法解析的 CDP JSON-RPC 消息。', error)
  }
}

/** 没有注入 socket 工厂时，用运行时自带的 WebSocket 建一条连接。 */
export function createDefaultSocket(url: string): CdpWebSocketLike {
  const WebSocketCtor = globalThis.WebSocket
  if (!WebSocketCtor) {
    throw new AppError('PLATFORM', '当前运行时不支持 WebSocket，无法连接 CDP。')
  }

  return new WebSocketCtor(url) as CdpWebSocketLike
}

/**
 * 现连一条 CDP WebSocket：连上、超时或出错都在这里结算，调用方拿到的要么是一条可用 socket，
 * 要么是一个说清楚原因的 `AppError`。
 */
export function openCdpWebSocket(
  url: string,
  options: {
    createSocket?: LooseOptional<(url: string) => CdpWebSocketLike>
    timeoutMs?: LooseOptional<number>
  } = {}
): Promise<CdpWebSocketLike> {
  const createSocket = options.createSocket ?? createDefaultSocket
  const socket = createSocket(url)
  const timeoutMs = options.timeoutMs ?? BrowserTuning.cdp.commandTimeoutMs
  const timers = new TimerScope({ name: 'openCdpWebSocket' })

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.removeEventListener('open', handleOpen)
      socket.removeEventListener('error', handleError)
      socket.removeEventListener('close', handleClose)
      timeout.cancel()
      timers.dispose()
    }
    const handleOpen = () => {
      cleanup()
      resolve(socket)
    }
    const handleError = () => {
      cleanup()
      reject(new AppError('NETWORK', `无法连接浏览器 CDP WebSocket：${url}`))
    }
    const handleClose = () => {
      cleanup()
      reject(new AppError('NETWORK', `浏览器 CDP WebSocket 连接已关闭：${url}`))
    }
    const timeout = timers.after(
      timeoutMs,
      () => {
        cleanup()
        reject(new AppError('TIMEOUT', `连接浏览器 CDP WebSocket 超时：${url}`))
      },
      { label: 'openCdpWebSocket' }
    )

    socket.addEventListener('open', handleOpen)
    socket.addEventListener('error', handleError)
    socket.addEventListener('close', handleClose)
  })
}
