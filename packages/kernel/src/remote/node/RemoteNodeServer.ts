// Platform Kernel 统一持有与宿主无关的远程节点实现。
// Node 侧监听端:把注入进来的 Kernel 能力面暴露给**唯一一台**已配对的远端 Client。
//
// 宪章 §15 原则三反过来读同样成立:Node 不是宿主的一半,它是宿主伸到另一台机器上的一只手。
// 因此本文件里没有会话、没有 Agent 主干、没有任何主动向 Client 发起的请求——只有握手、派发,
// 与一条单向的清单推送。
//
// 分工:端口管路见 `listener.ts`,配对节奏见 `pairing.ts`,调用与终态记账见 `call-runner.ts`;
// 本文件只剩连接状态机与生命周期。
import type { Server } from 'node:http'
import type { Socket } from 'node:net'

import { type RawData, WebSocket, type WebSocketServer } from 'ws'

import {
  isNotNull,
  isNull,
  isNumber,
  isPresent,
  isRecord,
  Log,
  toNullable,
} from '@velaros-ai/core'
import { type TimerLease, TimerScope } from '@velaros-ai/core/utils/TimerScope'
import {
  type RemoteNodeAuthenticate,
  RemoteNodeCloseCode,
  type RemoteNodeCloseCodeValue,
  type RemoteNodeHello,
  type RemoteNodeIdentity,
  RemoteNodeIdleTimeoutMs,
  type RemoteNodeManifest,
  type RemoteNodePair,
  type RemoteNodePlatform,
  RemoteNodePlatformSchema,
  RemoteNodeProtocolVersion,
  type RemoteNodeResult,
} from '@velaros-ai/kernel/contracts/protocol'

import {
  createChallenge,
  createEpoch,
  createNodeId,
  verifyChallengeSignature,
} from '../shared/crypto'
import { decodeClientFrame, sendFrame } from '../shared/frames'

import { RemoteNodeCallRunner } from './call-runner'
import type {
  RemoteNodePairedCredential,
  RemoteNodeServerOptions,
  RemoteNodeServerStatus,
} from './contracts'
import { listenRemoteNode } from './listener'
import { RemoteNodePairingGate } from './pairing'

const log = Log.tag('RemoteNodeServer')

const DefaultBindHost = '127.0.0.1'
const DefaultPortStart = 43_180
const DefaultPortEnd = 43_190
const DefaultMaxConcurrentInvocations = 4
/** WebSocket 关闭原因受帧头限制(< 123 字节),超长会被 `ws` 直接抛出。 */
const MaxCloseReasonLength = 100

type RemoteNodeConnectionPhase =
  | 'hello'
  | 'pair'
  | 'pairing'
  | 'authenticate'
  | 'ready'
  | 'closed'

interface RemoteNodeConnection {
  readonly socket: WebSocket
  /** 每连接一枚,签名不可跨连接重放。 */
  readonly challenge: string
  phase: RemoteNodeConnectionPhase
  clientId: Nullable<string>
  clientName: Nullable<string>
  idle: Nullable<TimerLease>
}

function resolveNodePlatform(): RemoteNodePlatform {
  const parsed = RemoteNodePlatformSchema.safeParse(process.platform)
  if (!parsed.success) {
    throw new Error(`Remote node does not support platform ${process.platform}`)
  }
  return parsed.data
}

/**
 * 从一帧解不开的报文里捞出「这是一帧版本不符的 hello」。
 *
 * 必要之恶:`RemoteNodeClientFrameSchema` 用 `z.literal` 把版本钉死,版本不符的 hello 连
 * discriminated union 都进不去,只会得到一句「不匹配 schema」。要给对端一个明确的升级方向,
 * 只能在这里对原文做一次窄范围窥视——窥视结果只用于报错,不参与任何授权判断。
 */
function readMismatchedHelloVersion(raw: RawData): Nullable<number> {
  let value: unknown
  try {
    value = JSON.parse(raw.toString()) as unknown
  } catch (error) {
    log.debug('Remote node frame is not valid JSON', { error })
    return null
  }
  if (!isRecord(value) || value.type !== 'hello') return null
  const version = value.protocolVersion
  return isNumber(version) && version !== RemoteNodeProtocolVersion ? version : null
}

/** 无头能力节点的监听端:一条 WebSocket,一台已配对 Client,零会话权威。 */
export class RemoteNodeServer {
  private timers = new TimerScope({ name: 'RemoteNodeServer' })
  private readonly now: () => number
  private readonly node: RemoteNodeIdentity
  private readonly connections = new Set<RemoteNodeConnection>()
  private readonly networkSockets = new Set<Socket>()
  private pairing: RemoteNodePairingGate
  private runner: RemoteNodeCallRunner
  private manifest: RemoteNodeManifest
  private credential: Nullable<RemoteNodePairedCredential> = null
  private ready: Nullable<RemoteNodeConnection> = null
  private unsubscribeManifest: Nullable<() => void> = null
  private httpServer?: Server
  private webSocketServer?: WebSocketServer
  private endpoint?: string

  public constructor(private readonly options: RemoteNodeServerOptions) {
    this.now = options.now ?? Date.now
    this.manifest = options.manifestSource.current()
    this.pairing = this.createPairingGate()
    this.runner = this.createCallRunner()
    this.node = {
      nodeId: options.nodeId ?? createNodeId(),
      nodeName: options.nodeName,
      platform: resolveNodePlatform(),
      arch: process.arch,
      nodeVersion: options.nodeVersion,
      // 每次进程启动重新生成:Client 一旦发现 epoch 变了,就知道在途调用的结果永远不会再来。
      epoch: createEpoch(),
    }
  }

  public async start(): Promise<RemoteNodeServerStatus> {
    if (isPresent(this.endpoint)) return this.getStatus()
    if (this.timers.isDisposed) {
      this.timers = new TimerScope({ name: 'RemoteNodeServer' })
      this.pairing = this.createPairingGate()
      this.runner = this.createCallRunner()
    }
    // 凭据一次性读进内存:握手路径因此全同步,不会出现「已收 hello 但还没决定 paired」的窗口。
    this.credential = await this.options.credentialStore.load()
    const listener = await listenRemoteNode({
      bindHost: this.options.bindHost ?? DefaultBindHost,
      portStart: this.options.portStart ?? DefaultPortStart,
      portEnd: this.options.portEnd ?? DefaultPortEnd,
      onConnection: (socket) => this.accept(socket),
      onNetworkSocket: (socket) => {
        this.networkSockets.add(socket)
        socket.once('close', () => this.networkSockets.delete(socket))
      },
    })
    this.httpServer = listener.httpServer
    this.webSocketServer = listener.webSocketServer
    this.endpoint = listener.endpoint
    // 订阅放在监听之后且与之同 tick:监听抛错时不留悬空订阅,而这一 tick 内还没有任何连接能
    // 到达,不存在漏掉一次清单变更的窗口。
    this.manifest = this.options.manifestSource.current()
    this.unsubscribeManifest = this.options.manifestSource.onChange((manifest) => {
      this.manifest = manifest
      const ready = this.ready
      if (isNull(ready)) return
      sendFrame(ready.socket, { type: 'manifest_changed', manifest })
    })
    return this.getStatus()
  }

  /** 开一次配对窗口,返回给宿主展示的六位码。 */
  public startPairing(): RemoteNodeServerStatus {
    if (!isPresent(this.endpoint)) throw new Error('Remote node server is not started')
    this.pairing.open()
    return this.getStatus()
  }

  /** 解除配对:斩断在线连接,并丢掉终态回放缓存(它属于上一段信任关系)。 */
  public async unpair(): Promise<void> {
    const ready = this.ready
    if (isNotNull(ready)) {
      this.closeConnection(ready, RemoteNodeCloseCode.Unauthorized, 'Credential cleared')
    }
    this.credential = null
    this.runner.forgetCompleted()
    await this.options.credentialStore.clear()
  }

  public getStatus(): RemoteNodeServerStatus {
    if (!isPresent(this.endpoint)) throw new Error('Remote node server is not started')
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

  public async stop(): Promise<void> {
    this.pairing.cancel()
    this.unsubscribeManifest?.()
    this.unsubscribeManifest = null
    this.runner.abortAll('Remote node server stopped')
    for (const connection of [...this.connections]) {
      this.closeConnection(connection, RemoteNodeCloseCode.Transient, 'Node stopped')
    }
    this.connections.clear()
    this.ready = null
    this.timers.dispose()
    for (const client of this.webSocketServer?.clients ?? []) client.terminate()
    for (const socket of this.networkSockets) socket.destroy()
    this.networkSockets.clear()
    // noServer 模式下 `ws` 不持监听句柄;上面把升级后的 TCP socket 全销毁之后,close 只是翻转
    // 内存状态,等它的可选回调在不同 Node 兼容运行时上并不可靠。
    this.webSocketServer?.close()
    this.httpServer?.closeAllConnections()
    this.httpServer?.close()
    this.webSocketServer = undefined
    this.httpServer = undefined
    this.endpoint = undefined
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
      maxConcurrent: this.options.maxConcurrentInvocations ?? DefaultMaxConcurrentInvocations,
      deliver: (clientId, result) => this.deliver(clientId, result),
    })
  }

  private accept(socket: WebSocket): void {
    // 停机与升级完成之间存在极窄的竞态窗口;此时不能再向已释放的 TimerScope 注册任何东西。
    if (this.timers.isDisposed) {
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
        log.error('Remote node pairing failed', { error })
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
        RemoteNodeCloseCode.Unauthorized,
      )
      return
    }
    if (frame.type === 'invoke') {
      this.runner.submit(
        frame,
        clientId,
        connection.clientName ?? clientId,
        this.manifest.revision,
      )
      return
    }
    this.runner.cancel(frame)
  }

  private handleHello(connection: RemoteNodeConnection, frame: RemoteNodeHello): void {
    if (connection.phase !== 'hello') {
      this.fatal(
        connection,
        'UNAUTHORIZED',
        'Remote node handshake has already advanced past hello',
        RemoteNodeCloseCode.Unauthorized,
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

  private async handlePair(
    connection: RemoteNodeConnection,
    frame: RemoteNodePair,
  ): Promise<void> {
    const clientId = connection.clientId
    // 已配对的 clientId 不接受再次配对:换设备 / 换密钥必须先由宿主 `unpair()`,免得一枚泄漏的
    // 配对码就能把已有凭据顶掉。
    if (connection.phase !== 'pair' || isNull(clientId)) {
      this.fatal(
        connection,
        'UNAUTHORIZED',
        'Remote node pairing is not expected on this connection',
        RemoteNodeCloseCode.Unauthorized,
      )
      return
    }
    connection.phase = 'pairing'
    if (!this.pairing.accept(frame.pairingCode)) {
      this.fatal(
        connection,
        'UNAUTHORIZED',
        'Remote node pairing code is invalid, expired, or locked out',
        RemoteNodeCloseCode.Unauthorized,
      )
      return
    }
    const credential: RemoteNodePairedCredential = {
      clientId,
      publicKey: frame.publicKey,
      clientName: connection.clientName ?? clientId,
      pairedAt: this.now(),
    }
    try {
      await this.options.credentialStore.save(credential)
    } catch (error) {
      log.error('Remote node credential could not be persisted', { error })
      this.fatal(
        connection,
        'PAIRING_FAILED',
        'Remote node credential could not be persisted',
        RemoteNodeCloseCode.Transient,
      )
      return
    }
    this.credential = credential
    this.pairing.close()
    sendFrame(connection.socket, { type: 'paired', node: this.node })
    this.grantReady(connection)
  }

  private handleAuthenticate(
    connection: RemoteNodeConnection,
    frame: RemoteNodeAuthenticate,
  ): void {
    const credential = this.credential
    // 允许 ready 之后再补一帧 authenticate(Client 若在 `paired` 之后仍习惯性补签),验签通过按
    // 幂等吞掉。宽容只针对**多余的帧**,不针对错误的签名:签不过照样斩断。
    const expected = connection.phase === 'authenticate' || connection.phase === 'ready'
    if (
      !expected
      || isNull(credential)
      || credential.clientId !== connection.clientId
      || !verifyChallengeSignature(credential.publicKey, connection.challenge, frame.signature)
    ) {
      this.fatal(
        connection,
        'UNAUTHORIZED',
        'Remote node challenge signature was rejected',
        RemoteNodeCloseCode.Unauthorized,
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
    connection.idle = this.timers.after(RemoteNodeIdleTimeoutMs, () => {
      // 空闲超时是链路判决而非权限判决,所以给 Transient:Client 可以立刻重连。
      this.closeConnection(connection, RemoteNodeCloseCode.Transient, 'Idle timeout')
    }, { label: 'remote-node-idle', unref: true })
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
      RemoteNodeCloseCode.ProtocolMismatch,
    )
  }

  private fatal(
    connection: RemoteNodeConnection,
    code: string,
    message: string,
    closeCode: RemoteNodeCloseCodeValue,
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
    reason: string,
  ): void {
    connection.phase = 'closed'
    connection.idle?.cancel()
    connection.idle = null
    if (this.ready === connection) this.ready = null
    if (connection.socket.readyState === WebSocket.OPEN) {
      connection.socket.close(code, reason.slice(0, MaxCloseReasonLength))
    }
  }
}
