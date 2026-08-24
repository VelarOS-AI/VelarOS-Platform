// Platform Kernel owns the host-neutral remote-node implementation.
// 域:跨机能力节点的 Client 侧连接——握手、判活、重连与会话状态。
//
// 在途调用簿在 `./pending-calls`,握手判定表在 `./handshake`;本文件只管这条链路本身。
//
// ## 不变量(改这些会破什么)
//  - **epoch 是重连后唯一的可信性判据**:同 epoch 才允许按 callId 幂等重放(Node 侧回放已有
//    结果);epoch 变了说明对端重启,已上线的调用一律按 `NODE_RESTARTED` 上抛。把它降级成
//    普通失败,等于让一次可能已半完成的构建/签名看起来像"没跑过"。
//  - **重连是默认姿态**:只有 ProtocolMismatch / Unauthorized / Replaced 三种关闭码停手——
//    前两者重连无用(要升级或重新配对),后者重连会和顶替者互踢。其余一律退避重连。
//  - **判活靠静默时长,不靠 close 事件**:网络层消失时 close 可能永远不来,卡在握手上的连接
//    更是一声不吭。心跳定时器从 socket 打开就跑,ping 则等到就绪后才发。
//  - **私钥只在内存与凭据存储之间流动**:不进日志、不进帧、不进诊断导出。
import {
  isNull,
  isPresent,
  isTrue,
  Log,
  toNullable,
} from '@velaros-ai/core'
import { type TimerLease, TimerScope } from '@velaros-ai/core/utils/TimerScope'
import {
  type RemoteNodeCancel,
  type RemoteNodeChallenge,
  RemoteNodeHeartbeatIntervalMs,
  RemoteNodeIdleTimeoutMs,
  type RemoteNodeInvoke,
  type RemoteNodeManifest,
  type RemoteNodePaired,
  type RemoteNodePlatform,
  RemoteNodeProtocolVersion,
  type RemoteNodeReady,
  type RemoteNodeServerFrame,
} from '@velaros-ai/kernel/contracts/protocol'

import { createClientId, type RemoteNodeKeyPair } from '../shared/crypto'
import { decodeServerFrame, sendFrame } from '../shared/frames'

import {
  computeReconnectDelayMs,
  planRemoteNodeCloseAction,
} from './close-policy'
import {
  RemoteNodeClientError,
  RemoteNodeClientErrorCodes,
  type RemoteNodeClientOptions,
  type RemoteNodeConnectionState,
  type RemoteNodeCredentials,
  type RemoteNodeInvokeRequest,
  type RemoteNodeManifestListener,
  type RemoteNodeSession,
  type RemoteNodeSocket,
  type RemoteNodeSocketFactory,
  type RemoteNodeStateListener,
  type RemoteNodeStopListener,
  type RemoteNodeUnsubscribe,
} from './contracts'
import { planRemoteNodeHandshake } from './handshake'
import { createAbortError, RemoteNodePendingCalls } from './pending-calls'
import { createRemoteNodeWebSocket } from './ws-socket'

const log = Log.tag('RemoteNodeClient')

interface ReadyWaiter {
  readonly resolve: (session: RemoteNodeSession) => void
  readonly reject: (error: Error) => void
}

/**
 * 一条到远程能力节点的长连接。
 *
 * 生命周期:`connect()` 点火并在首次 `ready` 兑现;此后断线由本对象自行退避重连,调用方
 * 不需要(也不应该)重建实例——重建会丢掉在途调用簿与 epoch 记忆。
 */
export class RemoteNodeClient {
  private readonly timers = new TimerScope({ name: 'RemoteNodeClient' })
  private readonly calls: RemoteNodePendingCalls
  private readonly readyWaiters = new Set<ReadyWaiter>()
  private readonly manifestListeners = new Set<RemoteNodeManifestListener>()
  private readonly stateListeners = new Set<RemoteNodeStateListener>()
  private readonly stopListeners = new Set<RemoteNodeStopListener>()
  private readonly socketFactory: RemoteNodeSocketFactory
  private readonly platform: RemoteNodePlatform
  private socket: Nullable<RemoteNodeSocket> = null
  private session: Nullable<RemoteNodeSession> = null
  private credentials: Nullable<RemoteNodeCredentials> = null
  /** 本轮配对生成的密钥对;`paired` 到达前不落盘,失败即丢弃。 */
  private pairingKeyPair: Nullable<RemoteNodeKeyPair> = null
  private clientId: Nullable<string> = null
  private state: RemoteNodeConnectionState = 'idle'
  private stopError: Nullable<RemoteNodeClientError> = null
  private heartbeat: Nullable<TimerLease> = null
  private reconnect: Nullable<TimerLease> = null
  private lastFrameAt = 0
  private attempt = 0
  private started = false
  private disposed = false

  public constructor(private readonly options: RemoteNodeClientOptions) {
    this.socketFactory = options.socketFactory ?? createRemoteNodeWebSocket
    this.platform = options.platform ?? resolveHostPlatform()
    this.calls = new RemoteNodePendingCalls(this.timers, {
      send: (frame) => this.write(frame),
      // 只有就绪时才交出摘要;其余状态返回 null,调用留在簿里排队。
      currentRevision: () => this.state === 'ready'
        ? toNullable(this.session?.manifest.revision)
        : null,
    })
  }

  public get connectionState(): RemoteNodeConnectionState {
    return this.state
  }

  public get currentSession(): Nullable<RemoteNodeSession> {
    return this.session
  }

  /** 停手因由;非空即表示本实例已进入终态,不会再自行重连。 */
  public get stopReason(): Nullable<RemoteNodeClientError> {
    return this.stopError
  }

  /**
   * 点火并等待首次 `ready`。
   *
   * 重复调用共享同一条连接:已就绪直接返回当前会话,未就绪则挂在同一批 waiter 上。
   */
  public async connect(): Promise<RemoteNodeSession> {
    if (this.disposed) throw this.disposedError()
    if (isPresent(this.stopError)) throw this.stopError
    if (isPresent(this.session) && this.state === 'ready') return this.session

    const waiter = new Promise<RemoteNodeSession>((resolve, reject) => {
      this.readyWaiters.add({ resolve, reject })
    })
    if (!this.started) {
      this.started = true
      this.credentials = await this.options.credentials.load()
      this.clientId = this.credentials?.clientId ?? createClientId()
      this.openSocket()
    }
    return waiter
  }

  /** 发起一次远端能力调用;`capabilityId` 用 Node 侧原名。 */
  public async invoke(
    request: RemoteNodeInvokeRequest,
    signal?: LooseOptional<AbortSignal>,
  ): Promise<unknown> {
    if (this.disposed) throw this.disposedError()
    if (isPresent(this.stopError)) throw this.stopError
    if (isTrue(signal?.aborted)) throw createAbortError()
    return this.calls.track(request, signal)
  }

  /** 清单变更(含重连后发现 revision 已变);Agent 主干据此重注册工具面。 */
  public onManifestChanged(
    listener: RemoteNodeManifestListener,
  ): RemoteNodeUnsubscribe {
    this.manifestListeners.add(listener)
    return () => this.manifestListeners.delete(listener)
  }

  public onStateChanged(
    listener: RemoteNodeStateListener,
  ): RemoteNodeUnsubscribe {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  /** 停手通知:协议不符 / 认证失败 / 被顶替——这三种都要人来处理,重连没有意义。 */
  public onStopped(listener: RemoteNodeStopListener): RemoteNodeUnsubscribe {
    this.stopListeners.add(listener)
    return () => this.stopListeners.delete(listener)
  }

  public dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const socket = this.socket
    this.socket = null
    this.session = null
    this.heartbeat = null
    this.reconnect = null
    this.timers.dispose()
    this.setState('stopped')
    const error = this.disposedError()
    this.rejectReadyWaiters(error)
    this.calls.failAll(error.code, error.message)
    this.detachSocket(socket)
    socket?.close(1000, 'Client disposed')
    this.manifestListeners.clear()
    this.stateListeners.clear()
    this.stopListeners.clear()
  }

  // -------------------------------------------------------------------------
  // 连接
  // -------------------------------------------------------------------------

  private openSocket(): void {
    if (this.disposed || isPresent(this.stopError)) return
    this.setState(this.attempt > 0 ? 'reconnecting' : 'connecting')

    let socket: RemoteNodeSocket
    try {
      socket = this.socketFactory(this.options.url)
    } catch (error) {
      log.warn('Remote node socket could not be created', {
        error,
        url: this.options.url,
      })
      this.scheduleReconnect()
      return
    }

    this.socket = socket
    socket.on('open', () => this.handleOpen(socket))
    socket.on('message', (data) => this.handleMessage(socket, data))
    socket.on('close', (code) => this.handleClose(socket, code))
    // error 之后 close 必到,重连统一由 close 驱动,这里只留诊断。
    socket.on('error', (error) => {
      log.debug('Remote node socket reported an error', {
        error,
        url: this.options.url,
      })
    })
  }

  private handleOpen(socket: RemoteNodeSocket): void {
    if (this.socket !== socket) return
    this.startHeartbeat()
    sendFrame(socket, {
      type: 'hello',
      protocolVersion: RemoteNodeProtocolVersion,
      clientId: this.clientId ?? createClientId(),
      clientName: this.options.clientName,
      platform: this.platform,
    })
  }

  private handleMessage(socket: RemoteNodeSocket, data: unknown): void {
    if (this.socket !== socket) return
    // 任何一帧都算活口:pong 只是没别的话可说时的那一帧。
    this.lastFrameAt = Date.now()

    const decoded = decodeServerFrame(data)
    if (!decoded.ok) {
      log.warn('Discarding malformed remote node frame', {
        reason: decoded.reason,
      })
      return
    }
    this.handleFrame(decoded.frame)
  }

  private handleFrame(frame: RemoteNodeServerFrame): void {
    if (frame.type === 'challenge') {
      this.handleChallenge(frame)
      return
    }
    if (frame.type === 'paired') {
      this.handlePaired(frame)
      return
    }
    if (frame.type === 'ready') {
      this.handleReady(frame)
      return
    }
    if (frame.type === 'manifest_changed') {
      this.applyManifest(frame.manifest)
      return
    }
    if (frame.type === 'result') {
      this.calls.settleResult(frame)
      return
    }
    if (frame.type === 'progress') {
      this.calls.routeProgress(frame)
      return
    }
    if (frame.type === 'fatal') {
      // Node 随后会带着关闭码断开,判决由 handleClose 统一下;这里只留可读因由。
      log.warn('Remote node reported a fatal error', { error: frame.error })
    }
  }

  private handleChallenge(frame: RemoteNodeChallenge): void {
    const socket = this.socket
    if (isNull(socket)) return

    const step = planRemoteNodeHandshake({
      challenge: frame,
      credentials: this.credentials,
      pairingCode: this.options.pairingCode,
    })
    if (step.kind === 'stop') {
      this.stop(step.error)
      return
    }
    if (step.kind === 'pair') this.pairingKeyPair = step.keyPair
    sendFrame(socket, step.frame)
  }

  private handlePaired(frame: RemoteNodePaired): void {
    const keyPair = this.pairingKeyPair
    if (isNull(keyPair)) {
      log.warn('Remote node acknowledged a pairing this client did not start')
      return
    }
    this.pairingKeyPair = null
    const credentials: RemoteNodeCredentials = {
      clientId: this.clientId ?? createClientId(),
      node: frame.node,
      privateKey: keyPair.privateKey,
      publicKey: keyPair.publicKey,
    }
    this.credentials = credentials
    this.clientId = credentials.clientId
    void this.options.credentials.save(credentials).catch((error: unknown) => {
      // 落盘失败不影响本次连接,但下次启动会退回配对——必须让人看见。
      log.error('Remote node credentials could not be persisted', { error })
    })
  }

  private handleReady(frame: RemoteNodeReady): void {
    const previous = this.session
    this.session = { manifest: frame.manifest, node: frame.node }
    this.attempt = 0

    if (isPresent(previous) && previous.node.epoch !== frame.node.epoch) {
      this.calls.failRestarted()
    }
    this.setState('ready')
    this.resolveReadyWaiters(this.session)
    if (
      isPresent(previous)
      && previous.manifest.revision !== frame.manifest.revision
    ) {
      // 断线期间对端开关被改过;首次 ready 的清单由 connect() 兑现,这里只播"变更"。
      this.emitManifest(frame.manifest)
    }
    this.calls.flush()
  }

  private handleClose(socket: RemoteNodeSocket, code: number): void {
    if (this.socket !== socket) return
    this.detachSocket(socket)
    this.socket = null
    this.stopHeartbeat()
    if (this.disposed) return

    const action = planRemoteNodeCloseAction(code)
    if (action.kind === 'reconnect') {
      this.setState('reconnecting')
      this.scheduleReconnect()
      return
    }
    if (action.clearCredentials) {
      this.credentials = null
      void this.options.credentials.clear().catch((error: unknown) => {
        log.error('Remote node credentials could not be cleared', { error })
      })
    }
    this.stop(action.error)
  }

  private detachSocket(socket: LooseOptional<RemoteNodeSocket>): void {
    if (!isPresent(socket)) return
    socket.removeAllListeners()
  }

  private write(frame: RemoteNodeInvoke | RemoteNodeCancel): boolean {
    const socket = this.socket
    if (isNull(socket) || this.state !== 'ready') return false
    return sendFrame(socket, frame)
  }

  // -------------------------------------------------------------------------
  // 心跳与重连
  // -------------------------------------------------------------------------

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.lastFrameAt = Date.now()
    this.heartbeat = this.timers.every(
      RemoteNodeHeartbeatIntervalMs,
      () => this.onHeartbeatTick(),
      { label: 'remote-node.heartbeat', unref: true },
    )
  }

  private stopHeartbeat(): void {
    this.heartbeat?.cancel()
    this.heartbeat = null
  }

  /**
   * 判活一跳。
   *
   * 握手期间也跑:卡在 challenge 上的连接不会有 close 事件,只能靠静默时长判死。ping 则等到
   * 就绪后才发——授权前的帧对 Node 没有意义。
   */
  private onHeartbeatTick(): void {
    const socket = this.socket
    if (isNull(socket)) return
    const idleMs = Date.now() - this.lastFrameAt
    if (idleMs > RemoteNodeIdleTimeoutMs) {
      log.warn('Remote node connection went silent; dropping it', {
        idleMs,
        url: this.options.url,
      })
      this.stopHeartbeat()
      socket.close(1001, 'Idle timeout')
      return
    }
    if (this.state !== 'ready') return
    sendFrame(socket, { type: 'ping', at: Date.now() })
  }

  private scheduleReconnect(): void {
    if (this.disposed || isPresent(this.stopError)) return
    this.reconnect?.cancel()
    const delayMs = computeReconnectDelayMs(this.attempt)
    this.attempt += 1
    this.reconnect = this.timers.after(
      delayMs,
      () => {
        this.reconnect = null
        this.openSocket()
      },
      { label: 'remote-node.reconnect', unref: true },
    )
  }

  // -------------------------------------------------------------------------
  // 状态与事件
  // -------------------------------------------------------------------------

  private stop(error: RemoteNodeClientError): void {
    if (isPresent(this.stopError) || this.disposed) return
    this.stopError = error
    this.reconnect?.cancel()
    this.reconnect = null
    this.stopHeartbeat()
    const socket = this.socket
    this.socket = null
    this.session = null
    this.detachSocket(socket)
    socket?.close(1000, 'Client stopped')
    this.setState('stopped')
    this.rejectReadyWaiters(error)
    this.calls.failAll(error.code, error.message)
    log.warn('Remote node client stopped', {
      code: error.code,
      url: this.options.url,
    })
    for (const listener of [...this.stopListeners]) listener(error)
  }

  private applyManifest(manifest: RemoteNodeManifest): void {
    const session = this.session
    if (isNull(session)) return
    this.session = { manifest, node: session.node }
    this.emitManifest(manifest)
  }

  private emitManifest(manifest: RemoteNodeManifest): void {
    for (const listener of [...this.manifestListeners]) listener(manifest)
  }

  private setState(state: RemoteNodeConnectionState): void {
    if (this.state === state) return
    this.state = state
    for (const listener of [...this.stateListeners]) listener(state)
  }

  private resolveReadyWaiters(session: RemoteNodeSession): void {
    const waiters = [...this.readyWaiters]
    this.readyWaiters.clear()
    for (const waiter of waiters) waiter.resolve(session)
  }

  private rejectReadyWaiters(error: Error): void {
    const waiters = [...this.readyWaiters]
    this.readyWaiters.clear()
    for (const waiter of waiters) waiter.reject(error)
  }

  private disposedError(): RemoteNodeClientError {
    return new RemoteNodeClientError({
      code: RemoteNodeClientErrorCodes.Disposed,
      message: 'Remote node client is disposed',
      resultUnknown: false,
      retryable: false,
    })
  }
}

/** Node 侧只认三种平台;本机不在其列时按 darwin 上报,握手不该因为一个展示字段失败。 */
function resolveHostPlatform(): RemoteNodePlatform {
  const platform = process.platform
  if (platform === 'linux' || platform === 'win32') return platform
  return 'darwin'
}
