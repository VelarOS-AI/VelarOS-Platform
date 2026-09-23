// Platform Kernel 统一持有与宿主无关的远程节点实现。
// 监听端管路:端口探测 + 升级路径把关。除此之外不含任何协议语义。
import { createServer, type Server } from 'node:http'

import type { WebSocket } from 'ws'
import { WebSocketServer } from 'ws'

import { isNull, isString } from '@velaros-ai/core'

import { RemoteNodeSocketPath } from '../../contract/constants'
import type { RemoteNodeListener, RemoteNodeListenerOptions } from '../../types/remote'
import { isNodeError } from '../fs'
import { RemoteNodeMaxFrameBytes } from '../wire/remote-node'

/** 把一次 `listen` 包成 promise:绑上了给实际端口,绑不上按原样上抛 errno 错误。 */
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
        reject(new Error('远程节点服务端没有绑上 TCP 端口'))
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
  options: RemoteNodeListenerOptions
): Promise<RemoteNodeListener> {
  const { bindHost, portStart, portEnd } = options
  if (!Number.isInteger(portStart) || !Number.isInteger(portEnd) || portStart > portEnd) {
    throw new Error('远程节点的端口区间不合法')
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
  throw new Error(`${portStart}-${portEnd} 区间里没有可用的远程节点端口`)
}
