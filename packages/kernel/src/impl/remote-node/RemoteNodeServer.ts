// Platform Kernel 统一持有与宿主无关的远程节点实现。
// Node 侧监听端:把注入进来的 Kernel 能力面暴露给**唯一一台**已配对的远端 Client。
//
// 宪章 §15 原则三反过来读同样成立:Node 不是宿主的一半,它是宿主伸到另一台机器上的一只手。
// 因此本文件里没有会话、没有 Agent 主干、没有任何主动向 Client 发起的请求——只有握手、派发,
// 与一条单向的清单推送。
//
// 分工:端口管路见 `utils/remote/listener.ts`,配对节奏见 `./RemoteNodePairingGate`,
// 调用与终态记账见 `./RemoteNodeCallRunner`;
// 本文件只剩连接状态机与生命周期。
import type { Server } from 'node:http'
import type { Socket } from 'node:net'

import { type RawData, WebSocket, type WebSocketServer } from 'ws'

import { isNotNull, isNull, isPresent, Log, toNullable } from '@velaros-ai/core'
import { AppError, createAbortError } from '@velaros-ai/core/error'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import { RemoteNodeLimits } from '../../contract/constants'
import type { RemoteNodeConnection } from '../../types/remote'
import type {
  RemoteNodePairedCredential,
  RemoteNodeServerOptions,
  RemoteNodeServerStatus,
} from '../../types/remote-node'
import { isNodeError } from '../../utils/fs'
import {
  createChallenge,
  createEpoch,
  createNodeId,
  verifyChallengeSignature,
} from '../../utils/remote/crypto'
import { decodeClientFrame, sendFrame } from '../../utils/remote/frames'
import { readMismatchedHelloVersion, resolveRemoteNodePlatform } from '../../utils/remote/handshake'
import { listenRemoteNode } from '../../utils/remote/listener'
import { KernelTuning } from '../../utils/tuning'
import {
  type RemoteNodeAuthenticate,
  RemoteNodeCloseCode,
  type RemoteNodeCloseCodeValue,
  type RemoteNodeHello,
  type RemoteNodeIdentity,
  RemoteNodeIdleTimeoutMs,
  type RemoteNodeManifest,
  type RemoteNodePair,
  RemoteNodeProtocolVersion,
  type RemoteNodeResult,
} from '../../utils/wire/remote-node'

import { RemoteNodeCallRunner } from './RemoteNodeCallRunner'
import { RemoteNodePairingGate } from './RemoteNodePairingGate'

const log = Log.tag('RemoteNodeServer')

/**
 * 无头能力节点的监听端。
 *
 * 一个进程一个实例,由宿主持有。一条 WebSocket、一台已配对 Client、零会话权威:
 * 它不认识会话、不持 Agent 主干,只把本机能力面摊给对端。
 */
export interface RemoteNodeServerApi {
  /** 开监听并读入凭据,兑现当前服务状态;已启动时直接回现状。端口区间全占时抛。 */
  start(): Promise<RemoteNodeServerStatus>
  /** 开一次配对窗口,返回含六位码的状态;服务端还没启动时抛。 */
  startPairing(): RemoteNodeServerStatus
  /** 解除配对:斩断在线连接、丢终态回放缓存、清掉落盘凭据。 */
  unpair(): Promise<void>
  /** 当前服务状态(端点、身份、清单修订号、配对与连接情况);还没启动时抛。 */
  getStatus(): RemoteNodeServerStatus
  /** 停机:收配对窗、退清单订阅、中止在途调用、断开全部连接并释放端口。 */
  stop(): Promise<void>
}

/** 无头能力节点的监听端:一条 WebSocket,一台已配对 Client,零会话权威。 */
export class RemoteNodeServer implements RemoteNodeServerApi {
  /** 默认只绑回环;跨机监听必须由宿主显式放开。 */
  private static readonly DefaultBindHost = '127.0.0.1'

  /** WebSocket 关闭原因受帧头限制(< 123 字节),超长会被 `ws` 直接抛出。 */
  private static readonly MaxCloseReasonLength = 100
  private timers = new TimerScope({ name: 'RemoteNodeServer' })
  private readonly now: () => number
  private readonly node: RemoteNodeIdentity
  private readonly connections = new Set<RemoteNodeConnection>()
  private readonly networkSockets = new Set<Socket>()
  private pairing: RemoteNodePairingGate
  private runner: RemoteNodeCallRunner
  private manifest: RemoteNodeManifest
  private credential: Nullable<RemoteNodePairedCredential> = null
  private credentialGeneration = 0
  private credentialWrites: Promise<void> = Promise.resolve()
  private ready: Nullable<RemoteNodeConnection> = null
  private unsubscribeManifest: Nullable<() => void> = null
  private httpServer?: Server
  private webSocketServer?: WebSocketServer
  private endpoint?: string
  private starting: Nullable<Promise<RemoteNodeServerStatus>> = null
  private stopping: Nullable<Promise<void>> = null

  public constructor(private readonly options: RemoteNodeServerOptions) {
    this.now = options.now ?? Date.now
    this.manifest = options.manifestSource.current()
    this.pairing = this.createPairingGate()
    this.runner = this.createCallRunner()
    this.node = {
      nodeId: options.nodeId ?? createNodeId(),
      nodeName: options.nodeName,
      platform: resolveRemoteNodePlatform(),
      arch: process.arch,
      nodeVersion: options.nodeVersion,
      // 每次进程启动重新生成:Client 一旦发现 epoch 变了,就知道在途调用的结果永远不会再来。
      epoch: createEpoch(),
    }
  }

  public start(): Promise<RemoteNodeServerStatus> {
    if (this.stopping) return Promise.reject(new AppError('CLOSED', '远程节点服务端正在停止'))
    if (this.starting) return this.starting
    if (isPresent(this.endpoint)) return Promise.resolve(this.getStatus())
    if (this.timers.isDisposed) {
      this.timers = new TimerScope({ name: 'RemoteNodeServer' })
      this.pairing = this.createPairingGate()
      this.runner = this.createCallRunner()
    }
    const timers = this.timers
    const starting: Promise<RemoteNodeServerStatus> = Promise.resolve().then(async () => {
      try {
        return await this.startOnce(timers)
      } finally {
        if (this.starting === starting) this.starting = null
      }
    })
    this.starting = starting
    return starting
  }

  private async startOnce(timers: TimerScope): Promise<RemoteNodeServerStatus> {
    this.assertStarting(timers)
    const generation = this.credentialGeneration
    // 凭据一次性读进内存:握手路径因此全同步,不会出现「已收 hello 但还没决定 paired」的窗口。
    // 已接纳的清除先落盘；读取途中解除配对则由同一信任代次阻止旧快照恢复。
    const credential = await this.credentialWrites.then(() => this.options.credentialStore.load())
    this.assertStarting(timers)
    if (generation === this.credentialGeneration) this.credential = credential
    const listener = await listenRemoteNode({
      bindHost: this.options.bindHost ?? RemoteNodeServer.DefaultBindHost,
      portStart: this.options.portStart ?? RemoteNodeLimits.defaultPortStart,
      portEnd: this.options.portEnd ?? RemoteNodeLimits.defaultPortEnd,
      onConnection: (socket) => this.accept(socket),
      onNetworkSocket: (socket) => {
        if (timers !== this.timers || timers.isDisposed || this.stopping) {
          socket.destroy()
          return
        }
        this.networkSockets.add(socket)
        socket.once('close', () => this.networkSockets.delete(socket))
      },
    })
    let unsubscribe: Nullable<() => void> = null
    try {
      this.assertStarting(timers)
      // 订阅与监听发布在同一 tick；发布前句柄仍归这次启动所有，停机不能漏掉迟到资源。
      this.manifest = this.options.manifestSource.current()
      this.assertStarting(timers)
      unsubscribe = this.options.manifestSource.onChange((changed) => {
        this.manifest = changed
        const ready = this.ready
        if (isNull(ready)) return
        sendFrame(ready.socket, { type: 'manifest_changed', manifest: changed })
      })
      this.assertStarting(timers)
      this.httpServer = listener.httpServer
      this.webSocketServer = listener.webSocketServer
      this.endpoint = listener.endpoint
      this.unsubscribeManifest = unsubscribe
      return this.getStatus()
    } catch (error) {
      const cleanup = await Promise.allSettled([
        Promise.resolve().then(() => {
          unsubscribe?.()
        }),
        this.closeListener(listener.httpServer, listener.webSocketServer),
      ])
      const cleanupErrors = cleanup.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      )
      if (cleanupErrors.length) {
        throw AppError.withFields(
          'UNAVAILABLE',
          '远程节点启动失败且监听清理失败',
          {
            startupFailure: error,
            cleanupErrors,
          },
          error
        )
      }
      throw error
    }
  }

  private assertStarting(timers: TimerScope): void {
    if (timers !== this.timers || timers.isDisposed || this.stopping) {
      throw createAbortError('Remote node server stopped during startup')
    }
  }

  /** 开一次配对窗口,返回给宿主展示的六位码。 */
  public startPairing(): RemoteNodeServerStatus {
    if (!isPresent(this.endpoint)) throw new AppError('UNAVAILABLE', '远程节点服务端还没启动')
    this.pairing.open()
    return this.getStatus()
  }

  /** 解除配对:斩断在线连接,并丢掉终态回放缓存(它属于上一段信任关系)。 */
  public async unpair(): Promise<void> {
    this.credentialGeneration++
    this.pairing.cancel()
    for (const connection of [...this.connections]) {
      this.closeConnection(connection, RemoteNodeCloseCode.Unauthorized, '凭据已清除')
    }
    this.credential = null
    this.runner.forgetCompleted()
    // 已接受的 save 即使不能取消，也必须先结束，再清除其真实落盘结果。
    await this.writeCredential(() => this.options.credentialStore.clear())
  }

  public getStatus(): RemoteNodeServerStatus {
    if (!isPresent(this.endpoint)) throw new AppError('UNAVAILABLE', '远程节点服务端还没启动')
    return {
      endpoint: this.endpoint,
      node: this.node,
      manifestRevision: this.manifest.revision,
      pairingCode: this.pairing.code,
      pairingExpiresAt: this.pairing.expiresAt,
      pairedClientId: toNullable(this.credential?.clientId),
      connectedClientId: toNullable(this.ready?.clientId),
      inFlightCalls: this.runner.inFlight,
    }
  }

  public stop(): Promise<void> {
    if (this.stopping) return this.stopping
    const stopping: Promise<void> = Promise.resolve().then(async () => {
      try {
        await this.stopOnce()
      } finally {
        if (this.stopping === stopping) this.stopping = null
      }
    })
    this.stopping = stopping
    return stopping
  }

  private async stopOnce(): Promise<void> {
    this.pairing.cancel()
    this.timers.dispose()
    const unsubscribe = this.unsubscribeManifest
    this.unsubscribeManifest = null
    this.runner.abortAll('Remote node server stopped')
    for (const connection of [...this.connections]) {
      this.closeConnection(connection, RemoteNodeCloseCode.Transient, 'Node stopped')
    }
    this.connections.clear()
    this.ready = null
    const closing = this.httpServer
      ? this.closeListener(this.httpServer, this.webSocketServer)
      : Promise.resolve()
    this.webSocketServer = undefined
    this.httpServer = undefined
    this.endpoint = undefined
    // 启动只核本代准入并自行清掉迟到 listener，不反过来等待 stop。
    const outcomes = await Promise.allSettled([
      this.starting,
      closing,
      Promise.resolve().then(() => {
        unsubscribe?.()
      }),
      // 排序尾等待已接纳写入物理结算；原 save/clear 错误仍归各自调用方。
      this.credentialWrites,
    ])
    const failures = outcomes.flatMap((result, index) =>
      result.status === 'rejected' &&
      !(index === 0 && result.reason instanceof Error && result.reason.name === 'AbortError')
        ? [result.reason]
        : []
    )
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) {
      throw AppError.withFields('UNAVAILABLE', '远程节点停止失败', { failures })
    }
  }

  private async closeListener(
    httpServer: Server,
    webSocketServer?: WebSocketServer
  ): Promise<void> {
    // 启动回滚和停机共用同一实例的 socket owner，迟到监听也不能留下原始连接。
    for (const socket of this.networkSockets) socket.destroy()
    this.networkSockets.clear()
    for (const client of webSocketServer?.clients ?? []) client.terminate()
    // noServer 的 ws 不持监听句柄，关闭其内存状态即可；HTTP close 的回调结算真实端口释放。
    webSocketServer?.close()
    httpServer.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error?: Error) => {
        if (error && !isNodeError(error, 'ERR_SERVER_NOT_RUNNING')) reject(error)
        else resolve()
      })
    })
  }

  private createPairingGate(): RemoteNodePairingGate {
    return new RemoteNodePairingGate({
      timers: this.timers,
      now: this.now,
      pairingCode: this.options.pairingCode,
    })
  }

  private createCallRunner(): RemoteNodeCallRunner {
    return new RemoteNodeCallRunner({
      invoker: this.options.invoker,
      audit: this.options.audit,
      activity: this.options.activity,
      timers: this.timers,
      now: this.now,
      maxConcurrent:
        this.options.maxConcurrentInvocations ?? KernelTuning.remoteNodeMaxConcurrentInvocations,
      deliver: (clientId, result) => this.deliver(clientId, result),
    })
  }

  private accept(socket: WebSocket): void {
    // 停机与升级完成之间存在极窄的竞态窗口;此时不能再向已释放的 TimerScope 注册任何东西。
    if (this.timers.isDisposed || this.stopping) {
      socket.close(RemoteNodeCloseCode.Transient, 'Node stopped')
      return
    }
    const connection: RemoteNodeConnection = {
      socket,
      challenge: createChallenge(),
      phase: 'hello',
      clientId: null,
      clientName: null,
      idle: null,
    }
    this.connections.add(connection)
    // 逐帧同步分发,**不**串成一条 promise 链:一旦串起来,ping 与 cancel 就会排在长调用后面,
    // 取消变成空话、心跳变成假死。被限流的只有能力执行,不是帧处理。
    socket.on('message', (data) => this.receive(connection, data))
    socket.on('error', (error) => log.debug('Remote node socket failed', { error }))
    socket.on('close', () => {
      connection.phase = 'closed'
      connection.idle?.cancel()
      connection.idle = null
      this.connections.delete(connection)
      if (this.ready === connection) this.ready = null
      // 在途调用**不**随断线中止:终态会进回放缓存,Client 重连后按同一 callId 重试即可拿到
      // 真实结果——这正是幂等缓存存在的理由。deadline 仍然兜底,不会无限挂着。
    })
    this.armIdle(connection)
  }

  private receive(connection: RemoteNodeConnection, data: RawData): void {
    if (connection.phase === 'closed') return
    this.armIdle(connection)
    const decoded = decodeClientFrame(data)
    if (!decoded.ok) {
      const mismatched = readMismatchedHelloVersion(data)
      if (isNotNull(mismatched)) {
        this.rejectProtocolVersion(connection, mismatched)
        return
      }
      log.debug('Remote node frame was rejected', { reason: decoded.reason })
      this.fatal(connection, 'FRAME_INVALID', decoded.reason, RemoteNodeCloseCode.Transient)
      return
    }
    const frame = decoded.frame
    if (frame.type === 'ping') {
      // `at` 原样回抛,Client 直接算 RTT,不需要两端时钟对齐。
      sendFrame(connection.socket, { type: 'pong', at: frame.at })
      return
    }
    if (frame.type === 'hello') {
      this.handleHello(connection, frame)
      return
    }
    if (frame.type === 'pair') {
      void this.handlePair(connection, frame).catch((error: unknown) => {
        log.error('远程节点配对失败', { error })
      })
      return
    }
    if (frame.type === 'authenticate') {
      this.handleAuthenticate(connection, frame)
      return
    }
    const clientId = connection.clientId
    // ready 之前收到 invoke / cancel 一律斩断,没有例外:能力面在签名通过之前不存在。
    if (connection.phase !== 'ready' || isNull(clientId)) {
      this.fatal(
        connection,
        'UNAUTHORIZED',
        'Remote node call arrived before the handshake completed',
        RemoteNodeCloseCode.Unauthorized
      )
      return
    }
    if (frame.type === 'invoke') {
      this.runner.submit(frame, clientId, connection.clientName ?? clientId, this.manifest.revision)
      return
    }
    this.runner.cancel(frame, clientId)
  }

  private handleHello(connection: RemoteNodeConnection, frame: RemoteNodeHello): void {
    if (connection.phase !== 'hello') {
      this.fatal(
        connection,
        'UNAUTHORIZED',
        'Remote node handshake has already advanced past hello',
        RemoteNodeCloseCode.Unauthorized
      )
      return
    }
    // `protocolVersion` 已被 `z.literal` 在解码时钉死;版本不符的 hello 走不到这里,由
    // `readMismatchedHelloVersion` 那条路径给出明确的升级方向。
    connection.clientId = frame.clientId
    connection.clientName = frame.clientName
    const credential = this.credential
    const paired = isNotNull(credential) && credential.clientId === frame.clientId
    connection.phase = paired ? 'authenticate' : 'pair'
    sendFrame(connection.socket, {
      type: 'challenge',
      protocolVersion: RemoteNodeProtocolVersion,
      node: this.node,
      challenge: connection.challenge,
      paired,
    })
  }

  private async handlePair(connection: RemoteNodeConnection, frame: RemoteNodePair): Promise<void> {
    const clientId = connection.clientId
    // 已配对的 clientId 不接受再次配对:换设备 / 换密钥必须先由宿主 `unpair()`,免得一枚泄漏的
    // 配对码就能把已有凭据顶掉。
    if (connection.phase !== 'pair' || isNull(clientId)) {
      this.fatal(
        connection,
        'UNAUTHORIZED',
        'Remote node pairing is not expected on this connection',
        RemoteNodeCloseCode.Unauthorized
      )
      return
    }
    connection.phase = 'pairing'
    if (!this.pairing.accept(frame.pairingCode)) {
      this.fatal(
        connection,
        'UNAUTHORIZED',
        'Remote node pairing code is invalid, expired, or locked out',
        RemoteNodeCloseCode.Unauthorized
      )
      return
    }
    // 码一旦被接受就立刻关窗:配对码是**一次性**的。原来关窗在 `await save()` 之后,落盘那段
    // 时间里同一个码还能被第二条连接再用一次。
    this.pairing.close()
    const generation = this.credentialGeneration
    const previousClientId = this.credential?.clientId
    const credential: RemoteNodePairedCredential = {
      clientId,
      publicKey: frame.publicKey,
      clientName: connection.clientName ?? clientId,
      pairedAt: this.now(),
    }
    try {
      await this.writeCredential(async () => {
        if (
          generation !== this.credentialGeneration ||
          connection.phase !== 'pairing' ||
          this.timers.isDisposed
        )
          return
        await this.options.credentialStore.save(credential)
      })
    } catch (error) {
      log.error('Remote node credential could not be persisted', { error })
      this.fatal(
        connection,
        'PAIRING_FAILED',
        'Remote node credential could not be persisted',
        RemoteNodeCloseCode.Transient
      )
      return
    }
    if (
      generation !== this.credentialGeneration ||
      connection.phase !== 'pairing' ||
      this.timers.isDisposed
    )
      return
    this.credential = credential
    // 换了配对对象:终态回放缓存属于上一段信任关系,和 `unpair()` 一样必须丢掉,
    // 否则新 Client 能拿旧 Client 的 callId 把别人的调用结果读出来。
    if (isPresent(previousClientId) && previousClientId !== clientId) {
      this.runner.forgetCompleted()
    }
    sendFrame(connection.socket, { type: 'paired', node: this.node })
    this.grantReady(connection)
  }

  /** 凭据写入只由本服务端排序；失败仍交给原调用方，后续清除不能被失败的 save 卡住。 */
  private writeCredential(write: () => Promise<void>): Promise<void> {
    const writing = this.credentialWrites.then(write)
    this.credentialWrites = writing.catch(() => undefined)
    return writing
  }

  private handleAuthenticate(
    connection: RemoteNodeConnection,
    frame: RemoteNodeAuthenticate
  ): void {
    const credential = this.credential
    // 允许 ready 之后再补一帧 authenticate(Client 若在 `paired` 之后仍习惯性补签),验签通过按
    // 幂等吞掉。宽容只针对**多余的帧**,不针对错误的签名:签不过照样斩断。
    const expected = connection.phase === 'authenticate' || connection.phase === 'ready'
    if (
      !expected ||
      isNull(credential) ||
      credential.clientId !== connection.clientId ||
      !verifyChallengeSignature(credential.publicKey, connection.challenge, frame.signature)
    ) {
      this.fatal(
        connection,
        'UNAUTHORIZED',
        'Remote node challenge signature was rejected',
        RemoteNodeCloseCode.Unauthorized
      )
      return
    }
    if (connection.phase === 'ready') return
    this.grantReady(connection)
  }

  private grantReady(connection: RemoteNodeConnection): void {
    const previous = this.ready
    // 顶替只发生在**认证之后**:否则任何人猜到 clientId 就能靠一帧 hello 把在线会话踢下线。
    if (isNotNull(previous) && previous !== connection) {
      this.closeConnection(previous, RemoteNodeCloseCode.Replaced, 'Replaced by a new connection')
    }
    connection.phase = 'ready'
    this.ready = connection
    sendFrame(connection.socket, {
      type: 'ready',
      node: this.node,
      manifest: this.manifest,
    })
  }

  /** 终态发给**当前**这条 ready 连接;断线期间产生的结果留在回放缓存里等重试来取。 */
  private deliver(clientId: string, result: RemoteNodeResult): void {
    const ready = this.ready
    if (isNull(ready) || ready.clientId !== clientId) return
    sendFrame(ready.socket, result)
  }

  private armIdle(connection: RemoteNodeConnection): void {
    connection.idle?.cancel()
    if (connection.phase === 'closed') return
    connection.idle = this.timers.after(
      RemoteNodeIdleTimeoutMs,
      () => {
        // 空闲超时是链路判决而非权限判决,所以给 Transient:Client 可以立刻重连。
        this.closeConnection(connection, RemoteNodeCloseCode.Transient, 'Idle timeout')
      },
      { label: 'remote-node-idle', unref: true }
    )
  }

  private rejectProtocolVersion(connection: RemoteNodeConnection, clientVersion: number): void {
    log.warn('Remote node client protocol version does not match', {
      clientVersion,
      nodeProtocolVersion: RemoteNodeProtocolVersion,
    })
    // 契约要求版本不符时仍先回一帧 challenge:Client 据此读到 Node 的版本号与身份,能报出明确的
    // 升级方向而不是只看到「连接被拒」。`paired` 一律 false——版本都对不上,谈不上认得它是谁。
    sendFrame(connection.socket, {
      type: 'challenge',
      protocolVersion: RemoteNodeProtocolVersion,
      node: this.node,
      challenge: connection.challenge,
      paired: false,
    })
    this.fatal(
      connection,
      'PROTOCOL_MISMATCH',
      `Node speaks remote node protocol ${RemoteNodeProtocolVersion}, client speaks ${clientVersion}`,
      RemoteNodeCloseCode.ProtocolMismatch
    )
  }

  private fatal(
    connection: RemoteNodeConnection,
    code: string,
    message: string,
    closeCode: RemoteNodeCloseCodeValue
  ): void {
    sendFrame(connection.socket, {
      type: 'fatal',
      // 只有 Transient 才值得重连;协议不符与认证失败重连一万次也是同一个结果。
      error: { code, message, retryable: closeCode === RemoteNodeCloseCode.Transient },
    })
    this.closeConnection(connection, closeCode, code)
  }

  private closeConnection(
    connection: RemoteNodeConnection,
    code: RemoteNodeCloseCodeValue,
    reason: string
  ): void {
    connection.phase = 'closed'
    connection.idle?.cancel()
    connection.idle = null
    if (this.ready === connection) this.ready = null
    if (connection.socket.readyState === WebSocket.OPEN) {
      connection.socket.close(code, reason.slice(0, RemoteNodeServer.MaxCloseReasonLength))
    }
  }
}

/** 建一台远程能力节点的 Node 侧服务端;宿主注入四个端口,本函数只负责把它们接到 wire 上。 */
export function createRemoteNodeServer(options: RemoteNodeServerOptions): RemoteNodeServerApi {
  return new RemoteNodeServer(options)
}
