import { createServer, type Server } from 'node:http'
import type { Socket } from 'node:net'

import { type WebSocket, WebSocketServer } from 'ws'

import { isString } from '@velaros-ai/core'

import { ExternalAgentBridgeLimits } from '../../contract/constants.js'
import { ExternalAgentBridgeProtocolDescriptor } from '../../utils/wire/external-agent-bridge'

/** 只在本机回环地址上监听，等价于 `ExternalAgentBridgeLimits.host`。 */
export const ExternalAgentBridgeLoopbackHost: string = ExternalAgentBridgeLimits.host
/** 端口扫描起点（含），等价于 `ExternalAgentBridgeLimits.portRangeStart`。 */
export const ExternalAgentBridgeDefaultPortStart: number = ExternalAgentBridgeLimits.portRangeStart
/** 端口扫描终点（含），等价于 `ExternalAgentBridgeLimits.portRangeEnd`。 */
export const ExternalAgentBridgeDefaultPortEnd: number = ExternalAgentBridgeLimits.portRangeEnd
/** 单帧字节上限，等价于 `ExternalAgentBridgeLimits.maxSocketPayloadBytes`。 */
export const ExternalAgentBridgeMaxSocketPayloadBytes: number = ExternalAgentBridgeLimits.maxSocketPayloadBytes

export function isExternalAgentBridgeExtensionOrigin(origin: unknown): origin is string {
  return isString(origin) && /^chrome-extension:\/\/[a-p]{32}$/u.test(origin)
}

/** 建 `ExternalAgentBridgeLoopbackServer` 时一次性交的参数：端口范围、握手路径、单帧上限和两个回调；建好之后不再变。 */
export interface ExternalAgentBridgeLoopbackServerOptions {
  /** 端口扫描的起点（含），缺省 `ExternalAgentBridgeDefaultPortStart`；`start()` 从这里往上逐个试，谁先空着用谁。 */
  readonly portStart?: number
  /** 端口扫描的终点（含），缺省 `ExternalAgentBridgeDefaultPortEnd`；扫到这里还全被占就抛错。必须 >= `portStart`，否则 `start()` 直接拒。 */
  readonly portEnd?: number
  /** WebSocket 握手只认这一个 URL path，缺省 `ExternalAgentBridgeProtocolDescriptor.socketPath`；其余路径的 Upgrade 一律回 403。改它等于换协议端点，客户端要跟着改。 */
  readonly socketPath?: string
  /** 单条 WebSocket 消息的字节上限，缺省 `ExternalAgentBridgeMaxSocketPayloadBytes`（32 MB）；超了由 ws 关连接，不会进 `onConnection` 那条流。 */
  readonly maxPayloadBytes?: number
  /** 一条连接通过 Origin 和 path 校验、升级成功后回调，把 socket 交给宿主；配对、凭据校验、设备/会话绑定和工具执行全在这条回调之后由宿主做。 */
  readonly onConnection: (socket: WebSocket) => void
  /** 传输层出错时回调（HTTP clientError、socket error、WebSocketServer error）；只用来记日志或上报，服务器自己会销毁坏掉的 socket，不调用方也不影响运行。 */
  readonly onError?: (error: Error) => void
}

/**
 * 外部 Agent 桥的 loopback 传输层：在 127.0.0.1 上挑一个空端口起 HTTP 服务，只放行来自 Chrome 扩展 Origin、且打在约定 path 上的 WebSocket Upgrade，其余一律 403。
 *
 * 实现是 `ExternalAgentBridgeLoopbackServer`，宿主进程持一个；只管端口选择、准入、升级、socket 追踪和释放，配对、凭据、设备/会话与工具执行全部经 `onConnection` 回调留在宿主那边。
 */
export interface ExternalAgentBridgeLoopbackServerApi {
  /** 当前监听地址，形如 `ws://127.0.0.1:<port><socketPath>`，发给客户端去连；没 `start()` 或已 `close()` 时是 null。 */
  readonly endpoint: Nullable<string>
  /** 起服务：在 `portStart`–`portEnd` 里逐个试，第一个没被占的就绑上并返回它的 endpoint；已经在跑就原样返回当前 endpoint（可重复调）。端口范围非法、或整段都被占时抛错。 */
  start(): Promise<string>
  /** 停服务：踢掉全部 WebSocket 客户端、销毁还挂着的 TCP socket、关掉两层 server，并把 `endpoint` 清成 null。可重复调；关完还能再 `start()` 重新选端口。 */
  close(): void
}

export class ExternalAgentBridgeLoopbackServer implements ExternalAgentBridgeLoopbackServerApi {
  private server: Nullable<Server> = null
  private webSocketServer: Nullable<WebSocketServer> = null
  private readonly networkSockets = new Set<Socket>()
  private endpointValue: Nullable<string> = null

  public constructor(private readonly options: ExternalAgentBridgeLoopbackServerOptions) {}

  public get endpoint(): Nullable<string> {
    return this.endpointValue
  }

  public async start(): Promise<string> {
    if (this.endpointValue) return this.endpointValue
    const portStart = this.options.portStart ?? ExternalAgentBridgeDefaultPortStart
    const portEnd = this.options.portEnd ?? ExternalAgentBridgeDefaultPortEnd
    if (!Number.isInteger(portStart) || !Number.isInteger(portEnd) || portStart > portEnd) {
      throw new Error('External Agent Bridge 端口区间非法：portStart 与 portEnd 必须都是整数，且 portStart 不能大于 portEnd。')
    }
    for (let port = portStart; port <= portEnd; port += 1) {
      const started = await this.tryStart(port)
      if (started) return started
    }
    throw new Error(`External Agent Bridge 在 ${portStart}-${portEnd} 区间里找不到可用端口：这些端口都被占着，先腾出一个或把区间调大。`)
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

  private async tryStart(port: number): Promise<Nullable<string>> {
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
    if (!address || isString(address)) {
      webSocketServer.close()
      server.close()
      throw new Error('External Agent Bridge 没能绑上 TCP 端口：server.address() 返回的不是网络地址，这次监听用不了，已回滚。')
    }
    this.server = server
    this.webSocketServer = webSocketServer
    this.endpointValue = `ws://${ExternalAgentBridgeLoopbackHost}:${address.port}${socketPath}`
    return this.endpointValue
  }
}
