import { createServer, type Server } from 'node:http'
import type { Socket } from 'node:net'

import { type WebSocket,WebSocketServer } from 'ws'

import { ExternalAgentBridgeProtocolDescriptor } from '../protocol/external-agent-bridge'

export const ExternalAgentBridgeLoopbackHost = '127.0.0.1'
export const ExternalAgentBridgeDefaultPortStart = 43_137
export const ExternalAgentBridgeDefaultPortEnd = 43_147
export const ExternalAgentBridgeMaxSocketPayloadBytes = 32 * 1_024 * 1_024

export function isExternalAgentBridgeExtensionOrigin(origin: unknown): origin is string {
  return typeof origin === 'string' && /^chrome-extension:\/\/[a-p]{32}$/u.test(origin)
}

export interface ExternalAgentBridgeLoopbackServerOptions {
  readonly portStart?: number
  readonly portEnd?: number
  readonly socketPath?: string
  readonly maxPayloadBytes?: number
  readonly onConnection: (socket: WebSocket) => void
  readonly onError?: (error: Error) => void
}

/**
 * External Agent Bridge 的公共 loopback transport owner。
 *
 * 只负责 127.0.0.1 端口选择、Origin/path admission、Upgrade、socket 追踪和释放；
 * 配对、凭据、设备/Session 与工具执行全部通过产品回调留在宿主。
 */
export class ExternalAgentBridgeLoopbackServer {
  private server: Server | null = null
  private webSocketServer: WebSocketServer | null = null
  private readonly networkSockets = new Set<Socket>()
  private endpointValue: string | null = null

  public constructor(private readonly options: ExternalAgentBridgeLoopbackServerOptions) {}

  public get endpoint(): string | null {
    return this.endpointValue
  }

  public async start(): Promise<string> {
    if (this.endpointValue) return this.endpointValue
    const portStart = this.options.portStart ?? ExternalAgentBridgeDefaultPortStart
    const portEnd = this.options.portEnd ?? ExternalAgentBridgeDefaultPortEnd
    if (!Number.isInteger(portStart) || !Number.isInteger(portEnd) || portStart > portEnd) {
      throw new Error('Invalid External Agent Bridge port range')
    }
    for (let port = portStart; port <= portEnd; port += 1) {
      const started = await this.tryStart(port)
      if (started) return started
    }
    throw new Error(`No External Agent Bridge port is available in ${portStart}-${portEnd}`)
  }

  public close(): void {
    for (const client of this.webSocketServer?.clients ?? []) client.terminate()
    for (const socket of this.networkSockets) socket.destroy()
    this.networkSockets.clear()
    // noServer 模式没有独立 listening handle，不能依赖 close callback 收尾。
    this.webSocketServer?.close()
    this.server?.closeAllConnections()
    this.server?.close()
    this.webSocketServer = null
    this.server = null
    this.endpointValue = null
  }

  private async tryStart(port: number): Promise<string | null> {
    const socketPath = this.options.socketPath ?? ExternalAgentBridgeProtocolDescriptor.socketPath
    const webSocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: this.options.maxPayloadBytes ?? ExternalAgentBridgeMaxSocketPayloadBytes,
    })
    const server = createServer((_request, response) => {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('Not found')
    })
    server.on('connection', (socket) => {
      this.networkSockets.add(socket)
      socket.once('close', () => this.networkSockets.delete(socket))
    })
    server.on('clientError', (error, socket) => {
      this.options.onError?.(error)
      if (!socket.destroyed) socket.destroy()
    })
    server.on('upgrade', (request, socket, head) => {
      socket.on('error', (error) => this.options.onError?.(error))
      const requestPath = request.url?.split('?', 1)[0] ?? '/'
      if (requestPath !== socketPath || !isExternalAgentBridgeExtensionOrigin(request.headers.origin)) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        return
      }
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit('connection', webSocket, request)
      })
    })
    webSocketServer.on('error', (error) => this.options.onError?.(error))
    webSocketServer.on('connection', this.options.onConnection)

    const listening = await new Promise<boolean>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException): void => {
        server.off('listening', onListening)
        if (error.code === 'EADDRINUSE') resolve(false)
        else reject(error)
      }
      const onListening = (): void => {
        server.off('error', onError)
        resolve(true)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, ExternalAgentBridgeLoopbackHost)
    }).catch((error) => {
      webSocketServer.close()
      server.close()
      throw error
    })
    if (!listening) {
      webSocketServer.close()
      server.close()
      return null
    }
    const address = server.address()
    if (!address || typeof address === 'string') {
      webSocketServer.close()
      server.close()
      throw new Error('External Agent Bridge did not bind a TCP port')
    }
    this.server = server
    this.webSocketServer = webSocketServer
    this.endpointValue = `ws://${ExternalAgentBridgeLoopbackHost}:${address.port}${socketPath}`
    return this.endpointValue
  }
}
