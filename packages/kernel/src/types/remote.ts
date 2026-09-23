// Platform Kernel 统一持有与宿主无关的远程节点实现。
// 域:远程节点两端的包内工作类型——在途调用、连接记录、握手与关闭判决、监听句柄、清单投影产物。
//
// 注入面的端口(凭据存储、能力派发、清单来源、审计与活动落点、socket)留在 `remote-client.ts`
// 与 `remote-node.ts`;本文件只放两侧实现自己在用的形状,不参与对外合同。
//
// wire 帧形状一律从 `./wire.js` 取:两端相认的那份契约只有一个出处,本文件不复制任何字段。
import type { Server } from 'node:http'
import type { Socket } from 'node:net'

import type { WebSocket, WebSocketServer } from 'ws'

import type { TimerLease } from '@velaros-ai/core/utils/TimerScope'

import type {
  RemoteNodeClientFailure,
  RemoteNodeCredentials,
  RemoteNodeInvokeRequest,
  RemoteNodeSession,
} from './remote-client.js'
import type {
  RemoteNodeAuthenticate,
  RemoteNodeChallenge,
  RemoteNodeInvoke,
  RemoteNodeManifest,
  RemoteNodeOperationDescriptor,
  RemoteNodePair,
} from './wire.js'

/**
 * 设备身份 = Ed25519 密钥对。
 *
 * 配对时 Client 只交出公钥;私钥永不上线,也永不进日志或协议帧。这是本传输与插件桥
 * (长期 bearer token 每次连接明文重发)的关键差别——跨机链路上不存在可重放的长期秘密。
 */
export interface RemoteNodeKeyPair {
  /** DER/SPKI 的 base64 公钥;配对时交给 Node 长期保存。 */
  readonly publicKey: string
  /** DER/PKCS8 的 base64 私钥;只在本进程与凭据存储之间流动。 */
  readonly privateKey: string
}

/** 一帧的解码结果:成功带帧,失败带一句可读因由(因由只进日志,不回给对端当协议内容)。 */
export type FrameDecodeResult<TFrame> =
  { readonly ok: true; readonly frame: TFrame } | { readonly ok: false; readonly reason: string }

/**
 * 关闭码判决:还试不试。
 *
 * 默认姿态是重连;`stop` 是例外,每一条例外都要说得出为什么重连没有意义。
 */
export type RemoteNodeCloseAction =
  | { readonly kind: 'reconnect' }
  | {
      readonly kind: 'stop'
      /** 停手因由,原样上抛给调用方与 `onStopped` 监听者。 */
      readonly error: RemoteNodeClientFailure
      /** 停手同时该不该把本机凭据一并清掉(Node 已经不认它了)。 */
      readonly clearCredentials: boolean
    }

/** 收到一枚 challenge 后的三选一:补签名、走配对、停手。 */
export type RemoteNodeHandshakeStep =
  | { readonly kind: 'authenticate'; readonly frame: RemoteNodeAuthenticate }
  | {
      readonly kind: 'pair'
      readonly frame: RemoteNodePair
      /** 本轮新生成的密钥对;`paired` 到达后才由调用方落盘,配对没成就丢弃。 */
      readonly keyPair: RemoteNodeKeyPair
    }
  | { readonly kind: 'stop'; readonly error: RemoteNodeClientFailure }

/** 握手判定的全部入参:一枚 challenge、本机现有凭据、人给的一次性配对码。 */
export interface RemoteNodeHandshakeInput {
  /** Node 发来的 challenge 帧,含对端协议版本、身份与是否认得本机。 */
  readonly challenge: RemoteNodeChallenge
  /** 本机已存的设备凭据;没有(或读坏了)就是 `null`,按未配对处理。 */
  readonly credentials: Nullable<RemoteNodeCredentials>
  /** 人现场输入的六位配对码;缺席时无法配对,判定会给出 `stop`。 */
  readonly pairingCode: LooseOptional<string>
}

/** 开监听要的全部参数:绑定地址、端口区间,以及两条连接回调。 */
export interface RemoteNodeListenerOptions {
  /**
   * 绑定地址。
   *
   * 默认只回环;要让另一台机器连上来必须由宿主**显式**放开——把「跨机」做成默认值,等于让一次
   * 无人留意的安装把本机能力面挂到局域网上。
   */
  readonly bindHost: string
  /** 端口区间起点,占用了就顺延到下一个。 */
  readonly portStart: number
  /** 端口区间终点,含端点;整段都占用则监听失败。 */
  readonly portEnd: number
  /** 升级成功后交出一条 WebSocket;协议语义全在调用方。 */
  readonly onConnection: (socket: WebSocket) => void
  /** 交出底层 TCP socket,供停机时强制销毁,避免句柄留住进程。 */
  readonly onNetworkSocket: (socket: Socket) => void
}

/** 监听成功后的句柄:两个 server 与本机视角的自指地址。 */
export interface RemoteNodeListener {
  /** 承载升级的 HTTP server;停机时由调用方关闭。 */
  readonly httpServer: Server
  /** `noServer` 模式的 WebSocket server;不持监听句柄。 */
  readonly webSocketServer: WebSocketServer
  /** `ws://<bindHost>:<实际端口><协议路径>`;bindHost 是 0.0.0.0 时不是对端可达地址。 */
  readonly endpoint: string
}

/** 一条能力的本地名 ↔ 远端原名映射,外加该能力的操作与权限声明。 */
export interface RemoteNodeCapabilityBinding {
  /** 命名空间化后的本机模块 id。 */
  readonly localModuleId: string
  /** 命名空间化后的本机能力 id;工具与权限闸都按它走。 */
  readonly localCapabilityId: string
  /** Node 侧原始模块 id。 */
  readonly remoteModuleId: string
  /** Node 侧原始能力 id;帧上线时换回它。 */
  readonly remoteCapabilityId: string
  /** 远端声明的能力版本,原样搬进本机 capability token。 */
  readonly version: string
  /** 该能力的操作表,含每个操作要闸的权限位。 */
  readonly operations: readonly RemoteNodeOperationDescriptor[]
}

/**
 * 命名空间化后的工具描述符。
 *
 * `name` 形如 `<hostSlug>:<toolName>`:模型看得见是哪台机器在干活,同名工具也不会在目录里打架。
 * `capabilityId` 是**本地**能力 id——工具调用要经本机 Kernel 的权限闸,不能拿原名直连 socket。
 */
export interface RemoteNodeToolProjection {
  /** 模型看到的工具名,已带主机前缀。 */
  readonly name: string
  /** Node 侧原始工具名;只用于展示与回溯,不参与本机注册。 */
  readonly remoteName: string
  /** 工具说明,原样取自远端清单。 */
  readonly description: string
  /** 入参 schema,原样取自远端清单。 */
  readonly inputSchema: Readonly<Record<string, unknown>>
  /** 工具分类;远端没给就是 `null`。 */
  readonly category: Nullable<string>
  /** 只读工具标记,交给主干决定要不要免确认。 */
  readonly readOnly: boolean
  /** 本机能力 id,调用一律经它过本机权限闸。 */
  readonly capabilityId: string
  /** 远端能力 id,帧上线时换回它。 */
  readonly remoteCapabilityId: string
  /** 能力上的操作名,两侧同名。 */
  readonly operation: string
}

/** 投影一份清单要的入参:人给的主机名与 Node 下发的清单。 */
export interface RemoteNodeProjectionInput {
  /** 用户给这台机器起的名字;只用来生成 slug 与展示,不参与鉴权。 */
  readonly hostName: string
  /** Node 在 `ready` / `manifest_changed` 里下发的能力清单。 */
  readonly manifest: RemoteNodeManifest
}

/** 远端能力的进度事件载荷;经本机事件总线播给订阅方。 */
export interface RemoteNodeProgressEvent {
  /** 本机能力 id。 */
  readonly capabilityId: string
  /** 能力上的操作名。 */
  readonly operation: string
  /** Node 原样推上来的进度载荷,本层不解释。 */
  readonly event: unknown
}

/** 按本机能力 id 找绑定;装配方从投影里摘下来交给隔离适配器。 */
export type RemoteNodeBindingResolver = (
  localCapabilityId: string
) => LooseOptional<RemoteNodeCapabilityBinding>

/**
 * 在途调用簿里的一条。
 *
 * `dispatched` 是 `resultUnknown` 的唯一依据:从没上线的调用失败了就是失败了,上过线却拿不到
 * 终态的必须按「可能已半执行」上抛。
 */
export interface RemoteNodePendingCall {
  /** 本次调用的唯一 id,重连后按它幂等重放。 */
  readonly callId: string
  /** 调用方给的原始请求,超时与取消的文案都从它取。 */
  readonly request: RemoteNodeInvokeRequest
  /** 兑现出口;只许经调用簿的 `settle` 走到。 */
  readonly resolve: (output: unknown) => void
  /** 拒绝出口;只许经调用簿的 `settle` 走到。 */
  readonly reject: (error: Error) => void
  /** 客户端侧截止时间的定时器租约,settle 时一并取消。 */
  readonly deadline: TimerLease
  /** 摘掉 AbortSignal 监听,避免调用结束后仍挂在调用方的 signal 上。 */
  readonly detach: () => void
  /** 首次派发时定型,重连后原样重放——Node 按 callId 幂等去重,回放已有结果。 */
  frame: Nullable<RemoteNodeInvoke>
  /** 这一帧写上线过没有。 */
  dispatched: boolean
}

/** 等首次 `ready` 的一对回调;`connect()` 的多次调用挂在同一批上。 */
export interface RemoteNodeReadyWaiter {
  /** 握手成功,交出本次会话。 */
  readonly resolve: (session: RemoteNodeSession) => void
  /** 连接进入终态,交出停手因由。 */
  readonly reject: (error: Error) => void
}

/** 一条连接在握手状态机里的位置;`closed` 是终态。 */
export type RemoteNodeConnectionPhase =
  'hello' | 'pair' | 'pairing' | 'authenticate' | 'ready' | 'closed'

/** Node 侧记的一条在线连接。 */
export interface RemoteNodeConnection {
  /** 这条连接的 socket。 */
  readonly socket: WebSocket
  /** 每连接一枚,签名不可跨连接重放。 */
  readonly challenge: string
  /** 握手进展;能力面只在 `ready` 之后存在。 */
  phase: RemoteNodeConnectionPhase
  /** 对端自报的 clientId;`hello` 之前是 `null`。 */
  clientId: Nullable<string>
  /** 对端自报的展示名;缺席时回落到 clientId。 */
  clientName: Nullable<string>
  /** 空闲判死的定时器租约,每收一帧重置。 */
  idle: Nullable<TimerLease>
}

/** Node 侧一次正在执行的能力调用。 */
export interface RemoteNodeInFlightCall {
  /** 调用 id,与终态回放缓存同键。 */
  readonly callId: string
  /** 发起方 clientId,终态只发给它当前那条 ready 连接。 */
  readonly clientId: string
  /** 发起方展示名,只进产品活动流,不进安全审计。 */
  readonly clientName: string
  /** 被调能力 id(Node 侧原名)。 */
  readonly capabilityId: string
  /** 被调操作名。 */
  readonly operation: string
  /** 收帧时刻;耗时从这里起算,不从开始执行起算。 */
  readonly startedAt: number
  /** 取消与超时的信号源,交给能力实现。 */
  readonly controller: AbortController
  /** 截止时间的定时器租约;终态落定时取消。 */
  deadline: Nullable<TimerLease>
  /** 已出过终态没有;一个 callId 只许有一帧终态。 */
  settled: boolean
}

/** 文件审计日志的落点;目录不存在时按 0700 自建。 */
export interface RemoteNodeFileAuditLogOptions {
  /** 审计文件所在目录,按 UTC 日切分文件。 */
  readonly directory: string
}
