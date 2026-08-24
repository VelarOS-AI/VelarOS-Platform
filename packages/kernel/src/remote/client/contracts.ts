// Platform Kernel 统一持有与宿主无关的远程节点实现。
// 域:远程能力节点 Client 侧的本地契约面——可替换端口、失败分档与事件形状。
//
// wire 帧形状冻结在 `@velaros-ai/kernel/contracts/protocol` 的 remote-node,本文件一个字都不改;
// 这里只声明**本机这一侧**的缝:socket 实现、凭据落盘、调用请求与失败语义。
//
// 值得读两遍的只有 `resultUnknown`:它把「没执行」与「可能已半执行」分成两档。跨机调用里
// 构建、代码签名这类动作一旦落在后者,重试就不是无害动作——把两者混成一个"失败"上抛,
// 等于让调用方在不知情的情况下做第二次签名。
import { toNullable } from '@velaros-ai/core'
import type { ScopeRef } from '@velaros-ai/kernel/contracts/abi'
import type {
  RemoteNodeError,
  RemoteNodeIdentity,
  RemoteNodeManifest,
  RemoteNodePlatform,
} from '@velaros-ai/kernel/contracts/protocol'

/**
 * 客户端兜底超时相对 wire `deadlineMs` 的宽限。
 *
 * 有意让 Node 侧看门狗先到期:那一侧超时会回一帧确定的 `error`,而客户端超时只能给出
 * 「结果未知」。宽限存在的意义是让确定的判决正常胜出,客户端计时器只当链路彻底哑掉时的兜底。
 */
export const RemoteNodeClientDeadlineGraceMs = 5_000

/** 调用方未指定时的 wire 截止时长。 */
export const RemoteNodeClientDefaultDeadlineMs = 120_000

/** 重连退避:首跳、上限与抖动比例。 */
export const RemoteNodeReconnectInitialDelayMs = 500
export const RemoteNodeReconnectMaxDelayMs = 30_000
export const RemoteNodeReconnectJitterRatio = 0.25

/**
 * socket 端口。
 *
 * 只声明本传输真正用到的方法,形状对齐 `ws` 的 EventEmitter 面(Electron 主进程没有可用的
 * DOM WebSocket)。收窄成端口是为了让测试替身与未来的 TLS/代理实现可以整体换掉。
 */
export interface RemoteNodeSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
  on(event: 'open', listener: () => void): unknown
  on(event: 'message', listener: (data: unknown) => void): unknown
  on(event: 'close', listener: (code: number, reason: unknown) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  removeAllListeners(): unknown
}

export type RemoteNodeSocketFactory = (url: string) => RemoteNodeSocket

/**
 * 设备凭据。
 *
 * `privateKey` 只在本进程与落盘之间流动:它永不进日志、永不进协议帧,也不随任何诊断导出。
 * `node` 是配对当时记下的身份,仅用于展示;判活与 epoch 比对一律以每次 `ready` 的实时值为准。
 */
export interface RemoteNodeCredentials {
  readonly clientId: string
  readonly privateKey: string
  readonly publicKey: string
  readonly node: RemoteNodeIdentity
}

/**
 * 凭据存储端口。
 *
 * 刻意只有三个动作:Desktop 后续换 Electron `safeStorage` 时只需换实现,调用点零改动。
 * `load` 在缺席与损坏时都返回 `null`——损坏等同未配对,重新走人工配对仪式,不半信半疑地用。
 */
export interface RemoteNodeCredentialStore {
  load(): Promise<Nullable<RemoteNodeCredentials>>
  save(credentials: RemoteNodeCredentials): Promise<void>
  clear(): Promise<void>
}

/** 连接态。`stopped` 是终态:只有 dispose 与重建能离开它。 */
export type RemoteNodeConnectionState =
  | 'idle'
  | 'connecting'
  | 'reconnecting'
  | 'ready'
  | 'stopped'

/** 一次成功握手后的会话面。`node.epoch` 变化即对端重启。 */
export interface RemoteNodeSession {
  readonly node: RemoteNodeIdentity
  readonly manifest: RemoteNodeManifest
}

export type RemoteNodeProgressListener = (event: unknown) => void
export type RemoteNodeManifestListener = (manifest: RemoteNodeManifest) => void
export type RemoteNodeStateListener = (
  state: RemoteNodeConnectionState,
) => void
export type RemoteNodeStopListener = (error: RemoteNodeClientError) => void
export type RemoteNodeUnsubscribe = () => void

/**
 * 一次远端能力调用。
 *
 * `capabilityId` / `operation` 是 **Node 侧原名**:命名空间化只发生在 Kernel 注册面,
 * wire 上永远是原名(见 remote-node 契约对 capability descriptor 的说明)。
 */
export interface RemoteNodeInvokeRequest {
  readonly capabilityId: string
  readonly operation: string
  readonly scope?: LooseOptional<ScopeRef>
  readonly input: unknown
  readonly deadlineMs?: number
  readonly onProgress?: RemoteNodeProgressListener
}

export const RemoteNodeClientErrorCodes = {
  /** 对端重启,在途调用结果永远不会再来。 */
  NodeRestarted: 'NODE_RESTARTED',
  ProtocolMismatch: 'REMOTE_NODE_PROTOCOL_MISMATCH',
  Unauthorized: 'REMOTE_NODE_UNAUTHORIZED',
  /** 需要人工配对码才能继续(未配对,或本机凭据已丢)。 */
  PairingRequired: 'REMOTE_NODE_PAIRING_REQUIRED',
  /** 被同一 Client 的新连接顶替。 */
  Superseded: 'REMOTE_NODE_SUPERSEDED',
  Disposed: 'REMOTE_NODE_DISPOSED',
  CallTimeout: 'REMOTE_NODE_CALL_TIMEOUT',
  CallFailed: 'REMOTE_NODE_CALL_FAILED',
  /** Node 侧派发后被自己的策略拒绝——是策略事实,不是链路故障。 */
  CallDenied: 'REMOTE_NODE_CALL_DENIED',
} as const

export type RemoteNodeClientErrorCode =
  (typeof RemoteNodeClientErrorCodes)[keyof typeof RemoteNodeClientErrorCodes]

export interface RemoteNodeClientErrorInit {
  readonly code: RemoteNodeClientErrorCode
  readonly message: string
  readonly retryable: boolean
  /** 调用已上过线但拿不到终态:重试可能造成第二次副作用。 */
  readonly resultUnknown: boolean
  readonly nodeError?: LooseOptional<RemoteNodeError>
  readonly cause?: unknown
}

/**
 * Client 侧统一错误。
 *
 * 字段三元组(code / message / retryable)与 Kernel wire 错误信封同构,便于上层原样转投;
 * `resultUnknown` 是本传输独有的第四位,跨机链路上没有它就无法诚实描述"半执行"。
 */
export class RemoteNodeClientError extends Error {
  public readonly code: RemoteNodeClientErrorCode
  public readonly retryable: boolean
  public readonly resultUnknown: boolean
  public readonly nodeError: Nullable<RemoteNodeError>

  public constructor(init: RemoteNodeClientErrorInit) {
    super(init.message, { cause: init.cause })
    this.name = 'RemoteNodeClientError'
    this.code = init.code
    this.retryable = init.retryable
    this.resultUnknown = init.resultUnknown
    this.nodeError = toNullable(init.nodeError)
  }
}

export interface RemoteNodeClientOptions {
  /** Node 监听地址,如 `ws://192.168.1.20:8787`。 */
  readonly url: string
  /** 展示给 Node 侧的本机名字(配对界面上人要认得出)。 */
  readonly clientName: string
  readonly credentials: RemoteNodeCredentialStore
  /**
   * 一次性配对码。
   *
   * 只在首次配对(或本机凭据已丢)时需要;已配对连接一律走 challenge 签名,不再有共享秘密上线。
   */
  readonly pairingCode?: LooseOptional<string>
  readonly platform?: RemoteNodePlatform
  readonly socketFactory?: RemoteNodeSocketFactory
}
