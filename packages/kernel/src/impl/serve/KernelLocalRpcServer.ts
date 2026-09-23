import { chmod, unlink } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'

import { isBlank, isNotUndefined, isUndefined, Log } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { KernelRpcLimits } from '../../contract/constants'
import type { KernelRegistration } from '../../contract/provides'
import type { KernelRpcEndpoint } from '../../types/kernel'
import type { KernelRpcEventFrame, KernelRpcRequest, KernelRpcSuccess } from '../../types/wire'
import { KernelClientError } from '../../utils/errors'
import { isNodeError } from '../../utils/fs'
import {
  closeKernelRpcServer,
  createDefaultKernelRpcEndpoint,
  kernelRpcTokensMatch,
  listenOnKernelRpcEndpoint,
  removeStaleKernelRpcSocket,
  resolveBoundKernelRpcEndpoint,
  sendKernelRpcFrame,
} from '../../utils/rpc/endpoint'
import {
  decodeKernelRpcRequest,
  readKernelRpcRequestId,
  readRequiredKernelRpcId,
  requireNonEmptyString,
  requireRecord,
  rpcFailure,
  toKernelRpcFailure,
} from '../../utils/rpc/frames'
import { capabilityCallFailure, readCapabilityCallId } from '../../utils/serve/service'
import {
  CapabilityCallRequestSchema,
  type CapabilityCallResponse,
  CapabilitySessionCloseRequestSchema,
  type CapabilitySessionCloseResponse,
  type CapabilitySessionOpenResponse,
} from '../../utils/wire/capability'
import {
  ModsInstallFromDirectoryRequestSchema,
  ModsListRequestSchema,
  ModsSetEnabledRequestSchema,
} from '../../utils/wire/mods'
import { KernelProtocolVersion } from '../../utils/wire/version'

import { CapabilitySessionLedger } from './CapabilitySessionLedger'
import type { KernelServiceApi } from './KernelService'

const log = Log.tag('KernelLocalRpcServer')

/** 起一个本机 RPC 服务端要交进来的东西。 */
export interface KernelLocalRpcServerOptions {
  /** 每一帧请求都要带上的认证令牌；少于 32 个字符直接抛错。 */
  readonly authToken: string
  /** 监听哪个端点；不给就按平台选一个缺省端点。 */
  readonly endpoint?: KernelRpcEndpoint
  /** 单帧字节上限；超过就回 `FRAME_TOO_LARGE` 并断开。不给取合同里的上限。 */
  readonly maxFrameBytes?: number
  /** 这个服务端代理的内核服务面。 */
  readonly service: KernelServiceApi
}

/** 一条连接的在途状态：socket、订阅表、在途调用的中止器、会话账本与半行缓冲。 */
export interface KernelLocalRpcServerConnection {
  /** 这条连接的 socket。 */
  readonly socket: Socket
  /** 订阅 id → 退订句柄。 */
  readonly subscriptions: Map<string, KernelRegistration>
  /** 请求 id → 中止器，`capability.cancel` 靠它中止在途调用。 */
  readonly controllers: Map<string, AbortController>
  /** 这条连接自己的能力会话账本；断开即全部作废。 */
  readonly sessions: CapabilitySessionLedger
  /** 还没读到换行的半行数据。 */
  buffer: string
}

/**
 * 本机 sidecar 的换行分隔 JSON RPC 服务端；实例归守护进程。
 *
 * 缺省走 unix domain socket；Windows 用一个只绑回环的 TCP 端点，真正绑上的端口在启动后返回。
 */
export interface KernelLocalRpcServerApi {
  /** 先起服务面，再监听端点；已在监听就回现有端点，已回收则抛错。中途失败会回收服务面并清掉 socket。 */
  start(): Promise<KernelRpcEndpoint>
  /** 回真正绑上的端点；还没启动时抛错。 */
  getEndpoint(): KernelRpcEndpoint
  /** 断开全部连接、关掉监听、回收服务面、清掉 socket 文件；重复调用无副作用。 */
  dispose(): Promise<void>
}

/** 本机 sidecar 的 RPC 服务端。 */
export class KernelLocalRpcServer implements KernelLocalRpcServerApi {
  /** 令牌至少这么长；短令牌猜得出来，宁可起不来也不将就。 */
  private static readonly MinimumAuthTokenLength = 32

  private readonly server: Server
  private readonly connections = new Set<KernelLocalRpcServerConnection>()
  private readonly maxFrameBytes: number
  private readonly requestedEndpoint: KernelRpcEndpoint
  private resolvedEndpoint?: KernelRpcEndpoint
  private state: 'idle' | 'listening' | 'disposed' = 'idle'

  public constructor(private readonly options: KernelLocalRpcServerOptions) {
    if (options.authToken.length < KernelLocalRpcServer.MinimumAuthTokenLength) {
      throw new AppError(
        'VALIDATION',
        `Kernel RPC 的认证令牌至少要 ${KernelLocalRpcServer.MinimumAuthTokenLength} 个字符`
      )
    }
    this.maxFrameBytes = options.maxFrameBytes ?? KernelRpcLimits.maxFrameBytes
    if (!Number.isInteger(this.maxFrameBytes) || this.maxFrameBytes <= 0) {
      throw new AppError('VALIDATION', 'maxFrameBytes 必须是正整数')
    }
    this.requestedEndpoint = options.endpoint ?? createDefaultKernelRpcEndpoint()
    if (this.requestedEndpoint.kind === 'tcp' && this.requestedEndpoint.host !== '127.0.0.1') {
      throw new AppError('VALIDATION', 'Kernel 的 TCP RPC 端点只能绑回环地址')
    }
    this.server = createServer((socket) => this.accept(socket))
  }

  public async start(): Promise<KernelRpcEndpoint> {
    switch (this.state) {
      case 'disposed':
        throw new AppError('CLOSED', '已回收的 Kernel RPC 服务端不能再启动')
      case 'listening':
        return this.getEndpoint()
      case 'idle':
        break
    }

    await this.options.service.start()
    try {
      if (this.requestedEndpoint.kind === 'unix') {
        await removeStaleKernelRpcSocket(this.requestedEndpoint.path)
      }
      await listenOnKernelRpcEndpoint(this.server, this.requestedEndpoint)
      this.resolvedEndpoint = resolveBoundKernelRpcEndpoint(this.server, this.requestedEndpoint)
      if (this.resolvedEndpoint.kind === 'unix') {
        // socket 就是进内核的门：只给属主读写。
        await chmod(this.resolvedEndpoint.path, 0o600)
      }
      this.state = 'listening'
      return this.resolvedEndpoint
    } catch (error) {
      await this.options.service.dispose().catch((cleanupError) => {
        log.warn('RPC 启动出错后回收 Kernel 服务面时又失败了', { error: cleanupError })
      })
      await this.cleanupSocketPath()
      throw error
    }
  }

  public getEndpoint(): KernelRpcEndpoint {
    if (isUndefined(this.resolvedEndpoint)) {
      throw new AppError('UNAVAILABLE', 'Kernel RPC 服务端还没启动')
    }
    return this.resolvedEndpoint
  }

  public async dispose(): Promise<void> {
    if (this.state === 'disposed') return
    this.state = 'disposed'
    for (const context of [...this.connections]) {
      this.closeConnection(context)
      context.socket.destroy()
    }
    this.connections.clear()
    try {
      await closeKernelRpcServer(this.server)
    } finally {
      try {
        await this.options.service.dispose()
      } finally {
        await this.cleanupSocketPath()
      }
    }
  }

  /** 接一条新连接，挂上读、错与关的处理。 */
  private accept(socket: Socket): void {
    socket.setEncoding('utf8')
    const context: KernelLocalRpcServerConnection = {
      socket,
      subscriptions: new Map(),
      controllers: new Map(),
      sessions: new CapabilitySessionLedger(),
      buffer: '',
    }
    this.connections.add(context)
    socket.on('data', (chunk: string) => this.read(context, chunk))
    socket.on('error', () => undefined)
    socket.on('close', () => this.closeConnection(context))
  }

  /** 断开一条连接：中止在途调用、退订、清会话，并把它从连接表里摘掉。 */
  private closeConnection(context: KernelLocalRpcServerConnection): void {
    for (const controller of context.controllers.values()) controller.abort()
    context.controllers.clear()
    for (const registration of context.subscriptions.values()) {
      registration.dispose()
    }
    context.subscriptions.clear()
    context.sessions.clear()
    this.connections.delete(context)
  }

  /** 按换行切帧；单帧或缓冲超过上限就断开这条连接。 */
  private read(context: KernelLocalRpcServerConnection, chunk: string): void {
    context.buffer += chunk

    let newlineIndex = context.buffer.indexOf('\n')
    while (newlineIndex >= 0) {
      const line = context.buffer.slice(0, newlineIndex)
      context.buffer = context.buffer.slice(newlineIndex + 1)
      if (Buffer.byteLength(line, 'utf8') > this.maxFrameBytes) {
        this.rejectOversizedFrame(context)
        return
      }
      if (!isBlank(line.trim())) {
        void this.handleLine(context, line)
      }
      newlineIndex = context.buffer.indexOf('\n')
    }
    if (Buffer.byteLength(context.buffer, 'utf8') > this.maxFrameBytes) {
      this.rejectOversizedFrame(context)
    }
  }

  /** 回一帧「超长」失败并断开：超限的连接不值得继续读下去，回执里点明上限是多少。 */
  private rejectOversizedFrame(context: KernelLocalRpcServerConnection): void {
    sendKernelRpcFrame(
      context.socket,
      rpcFailure(
        'invalid-frame',
        'FRAME_TOO_LARGE',
        `RPC 帧超过了 ${this.maxFrameBytes} 字节的上限`
      )
    )
    context.socket.destroy()
  }

  /** 解一帧、验令牌、派发、回响应；任何失败都折成失败帧写回去。 */
  private async handleLine(context: KernelLocalRpcServerConnection, line: string): Promise<void> {
    let raw: unknown
    try {
      raw = JSON.parse(line) as unknown
    } catch (error) {
      log.debug('挡下一帧不是合法 JSON 的 Kernel RPC', { error })
      sendKernelRpcFrame(
        context.socket,
        rpcFailure('invalid-frame', 'INVALID_JSON', 'RPC 帧不是合法的 JSON')
      )
      return
    }

    let request: KernelRpcRequest
    try {
      request = decodeKernelRpcRequest(raw)
    } catch (error) {
      log.debug('挡下一帧不合协议的 Kernel RPC 请求', { error })
      sendKernelRpcFrame(context.socket, toKernelRpcFailure(readKernelRpcRequestId(raw), error))
      return
    }
    if (!kernelRpcTokensMatch(request.authToken, this.options.authToken)) {
      sendKernelRpcFrame(
        context.socket,
        rpcFailure(request.requestId, 'UNAUTHORIZED', 'Kernel RPC 认证失败')
      )
      return
    }

    const controller = request.method === 'capability.call' ? new AbortController() : undefined
    if (isNotUndefined(controller)) {
      context.controllers.set(request.requestId, controller)
    }
    try {
      const result = await this.dispatch(context, request, controller?.signal)
      const response: KernelRpcSuccess = {
        type: 'response',
        requestId: request.requestId,
        status: 'ok',
        result,
      }
      if (!sendKernelRpcFrame(context.socket, response)) {
        sendKernelRpcFrame(
          context.socket,
          rpcFailure(request.requestId, 'RESPONSE_SERIALIZATION_FAILED', 'RPC 的结果序列化不了')
        )
      }
    } catch (error) {
      log.caught('Kernel RPC 请求失败', error, { method: request.method })
      sendKernelRpcFrame(context.socket, toKernelRpcFailure(request.requestId, error))
    } finally {
      context.controllers.delete(request.requestId)
    }
  }

  /** 按方法名把请求派给对应的处理。 */
  private dispatch(
    context: KernelLocalRpcServerConnection,
    request: KernelRpcRequest,
    signal?: AbortSignal
  ): unknown | Promise<unknown> {
    switch (request.method) {
      case 'handshake':
        return this.options.service.handshake()
      case 'health':
        return this.options.service.health()
      case 'capability.session.open':
        return this.openCapabilitySession(context, request.params)
      case 'capability.session.close': {
        const parsed = CapabilitySessionCloseRequestSchema.safeParse(request.params)
        if (!parsed.success) {
          throw new KernelClientError({
            code: 'INVALID_PARAMS',
            message: '关闭能力会话的请求不符合 Kernel 协议 v2',
          })
        }
        return {
          protocolVersion: KernelProtocolVersion,
          closed: context.sessions.close(parsed.data.sessionId),
        } satisfies CapabilitySessionCloseResponse
      }
      case 'capability.call':
        return this.callCapability(context, request.params, signal)
      case 'capability.cancel': {
        // 中止一次在途调用；回它当时在不在途。
        const controller = context.controllers.get(
          readRequiredKernelRpcId(request.params, 'requestId')
        )
        controller?.abort()
        return isNotUndefined(controller)
      }
      case 'events.subscribe':
        return this.subscribe(context, request)
      case 'events.unsubscribe': {
        // 退订；回它当时在不在订阅表里。
        const subscriptionId = readRequiredKernelRpcId(request.params, 'subscriptionId')
        const registration = context.subscriptions.get(subscriptionId)
        if (isUndefined(registration)) return false
        registration.dispose()
        context.subscriptions.delete(subscriptionId)
        return true
      }
      case 'mods.list':
        return this.listMods(request.params)
      case 'mods.setEnabled':
        return this.setModEnabled(request.params)
      case 'mods.installFromDirectory':
        return this.installModFromDirectory(request.params)
    }
  }

  /** `mods.list`：校验入参后列出仓库里的 pack。 */
  private listMods(params: unknown) {
    const parsed = ModsListRequestSchema.safeParse(
      params ?? {
        protocolVersion: KernelProtocolVersion,
      }
    )
    if (!parsed.success) {
      throw new KernelClientError({
        code: 'INVALID_PARAMS',
        message: 'mods.list 请求不符合 Kernel 协议 v2',
      })
    }
    return {
      protocolVersion: KernelProtocolVersion,
      packs: this.options.service.listMods(),
    }
  }

  /** `mods.setEnabled`：校验入参后开关一个 pack。 */
  private async setModEnabled(params: unknown) {
    const parsed = ModsSetEnabledRequestSchema.safeParse(params)
    if (!parsed.success) {
      throw new KernelClientError({
        code: 'INVALID_PARAMS',
        message: 'mods.setEnabled 请求不符合 Kernel 协议 v2',
      })
    }
    const result = await this.options.service.setModEnabled(parsed.data.id, parsed.data.enabled)
    return {
      protocolVersion: KernelProtocolVersion,
      ...result,
    }
  }

  /** `mods.installFromDirectory`：校验入参后从目录装一个 pack。 */
  private async installModFromDirectory(params: unknown) {
    const parsed = ModsInstallFromDirectoryRequestSchema.safeParse(params)
    if (!parsed.success) {
      throw new KernelClientError({
        code: 'INVALID_PARAMS',
        message: 'mods.installFromDirectory 请求不符合 Kernel 协议 v2',
      })
    }
    const result = await this.options.service.installModFromDirectory(parsed.data.directory)
    return {
      protocolVersion: KernelProtocolVersion,
      ...result,
    }
  }

  /** `capability.session.open`：服务面判准入，判过了在这条连接的账本上记一条。 */
  private async openCapabilitySession(
    context: KernelLocalRpcServerConnection,
    params: unknown
  ): Promise<CapabilitySessionOpenResponse> {
    const evaluated = await this.options.service.evaluateCapabilitySessionOpen(params)
    if (evaluated.status === 'error') return evaluated
    const session = context.sessions.open(evaluated.request.requires)
    return {
      protocolVersion: KernelProtocolVersion,
      status: 'ok',
      sessionId: session.sessionId,
      requires: evaluated.request.requires,
    }
  }

  /** `capability.call`：先核这条连接的会话覆不覆盖这次调用，过了才进服务面。 */
  private async callCapability(
    context: KernelLocalRpcServerConnection,
    params: unknown,
    signal?: AbortSignal
  ): Promise<CapabilityCallResponse> {
    const parsed = CapabilityCallRequestSchema.safeParse(params)
    if (!parsed.success)
      return capabilityCallFailure(
        readCapabilityCallId(params),
        'INVALID_REQUEST',
        '能力调用请求不符合 Kernel 协议 v2'
      )
    if (!context.sessions.covers(parsed.data))
      return capabilityCallFailure(
        parsed.data.callId,
        'CAPABILITY_NOT_GRANTED',
        `能力 "${parsed.data.capabilityId}" 没有绑定在会话 "${parsed.data.sessionId}" 上`
      )
    return this.options.service.handleCapabilityCall(parsed.data, signal)
  }

  /** `events.subscribe`：订阅一类事件，事件经这条连接以 event 帧推回去。 */
  private subscribe(
    context: KernelLocalRpcServerConnection,
    request: KernelRpcRequest
  ): { readonly subscriptionId: string } {
    const params = requireRecord(request.params)
    const eventType = requireNonEmptyString(params.eventType, 'eventType')
    const subscriptionId = request.requestId
    const registration = this.options.service.subscribe(eventType, (event) => {
      const frame: KernelRpcEventFrame = {
        type: 'event',
        subscriptionId,
        event,
      }
      sendKernelRpcFrame(context.socket, frame)
    })
    context.subscriptions.set(subscriptionId, registration)
    return { subscriptionId }
  }

  /** 清掉自己留下的 unix socket 文件；不是 unix 端点或文件已经没了就什么也不做。 */
  private async cleanupSocketPath(): Promise<void> {
    const endpoint = this.resolvedEndpoint ?? this.requestedEndpoint
    if (endpoint.kind !== 'unix') return
    await unlink(endpoint.path).catch((error: unknown) => {
      if (!isNodeError(error, 'ENOENT')) throw error
    })
  }
}
