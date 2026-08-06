// 监听端管路:端口探测 + 升级路径把关。除此之外不含任何协议语义。
import { createServer, type Server } from 'node:http'
import type { Socket } from 'node:net'

import type { WebSocket } from 'ws'
import { WebSocketServer } from 'ws'

import { isNull, isString } from '@velaros-ai/core'
import { RemoteNodeMaxFrameBytes } from '@velaros-ai/kernel/contracts/protocol'

import { RemoteNodeSocketPath } from './contracts'

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}

export interface RemoteNodeListenerOptions {
  /**
   * 绑定地址。
   *
   * 默认只回环;要让另一台机器连上来必须由宿主**显式**放开——把「跨机」做成默认值,等于让一次
   * 无人留意的安装把本机能力面挂到局域网上。
   */
  readonly bindHost: string
  readonly portStart: number
  readonly portEnd: number
  readonly onConnection: (socket: WebSocket) => void
  readonly onNetworkSocket: (socket: Socket) => void
}

export interface RemoteNodeListener {
  readonly httpServer: Server
  readonly webSocketServer: WebSocketServer
  readonly endpoint: string
}

function listenServer(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      const address = server.address()
      if (isNull(address) || isString(address)) {
        reject(new Error('Remote node server did not bind a TCP port'))
        return
      }
      resolve(address.port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

/** 在端口区间里逐个试,EADDRINUSE 顺延,其它错误直接上抛。 */
export async function listenRemoteNode(
  options: RemoteNodeListenerOptions,
): Promise<RemoteNodeListener> {
  const { bindHost, portStart, portEnd } = options
  if (!Number.isInteger(portStart) || !Number.isInteger(portEnd) || portStart > portEnd) {
    throw new Error('Invalid remote node port range')
  }
  for (let port = portStart; port <= portEnd; port += 1) {
    const webSocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: RemoteNodeMaxFrameBytes,
    })
    const server = createServer((_request, response) => {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('Not found')
    })
    server.on('connection', (socket) => options.onNetworkSocket(socket))
    server.on('upgrade', (request, socket, head) => {
      // 这里**没有** Origin 校验,是判断不是疏漏:Origin 是浏览器语义,对端是由密钥认证的原生
      // Client,唯一的门是 challenge 签名。拿 Origin 当门只会给「伪造一个头就进来」留错觉。
      const pathname = new URL(request.url ?? '/', 'http://remote-node.invalid').pathname
      if (pathname !== RemoteNodeSocketPath) {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit('connection', webSocket, request)
      })
    })
    webSocketServer.on('connection', (socket: WebSocket) => options.onConnection(socket))
    try {
      const actualPort = await listenServer(server, bindHost, port)
      return {
        httpServer: server,
        webSocketServer,
        // bindHost 若是 0.0.0.0,这里给出的只是「本机视角的自指地址」,不是给对端用的可达地址。
        endpoint: `ws://${bindHost}:${actualPort}${RemoteNodeSocketPath}`,
      }
    } catch (error) {
      webSocketServer.close()
      server.close()
      if (!isNodeError(error, 'EADDRINUSE')) throw error
    }
  }
  throw new Error(`No remote node port is available in ${portStart}-${portEnd}`)
}
