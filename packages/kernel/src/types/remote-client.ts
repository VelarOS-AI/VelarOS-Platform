import type {
  RemoteNodeClientCredentialStore as RemoteNodeCredentialStore,
  RemoteNodeSocketFactory,
} from '../contract/requires.js'

export type { RemoteNodeClientCredentialStore as RemoteNodeCredentialStore } from '../contract/requires.js'
// Platform Kernel 统一持有与宿主无关的远程节点实现。
// 域:远程能力节点 Client 侧的本地契约面——可替换端口、失败分档与事件形状。
//
// wire 帧形状冻结在 `types/wire.ts` 的 remote-node 帧,本文件一个字都不改;
// 这里只声明**本机这一侧**的缝:socket 实现、凭据落盘、调用请求与失败语义。
//
// 值得读两遍的只有 `resultUnknown`:它把「没执行」与「可能已半执行」分成两档。跨机调用里
// 构建、代码签名这类动作一旦落在后者,重试就不是无害动作——把两者混成一个"失败"上抛,
// 等于让调用方在不知情的情况下做第二次签名。
import type { RemoteNodeClientErrorCode } from '../contract/constants'

import type { ScopeRef } from './kernel.js'
import type {
  RemoteNodeError,
  RemoteNodeIdentity,
  RemoteNodeManifest,
  RemoteNodePlatform,
} from './wire.js'





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

/**
 * 客户端失败的只读形状。
 *
 * 与实现里的 `RemoteNodeClientError` 同构:`types/` 不许引实现层的错误类,判决表、停手通知与
 * 健康投影因此都按这个形状交接;运行期流过的仍是那个错误实例,`instanceof` 照旧成立。
 */
export interface RemoteNodeClientFailure extends Error {
  /** 失败码;见 `contract/constants.ts` 的 `RemoteNodeClientErrorCodes`。 */
  readonly code: string
  /** 这次失败重试有没有意义。 */
  readonly retryable: boolean
  /** 调用已上过线但拿不到终态:重试可能造成第二次副作用。 */
  readonly resultUnknown: boolean
  /** Node 侧回的失败信封原样;链路故障(还没上线)时是 `null`。 */
  readonly nodeError: Nullable<RemoteNodeError>
}

export type RemoteNodeProgressListener = (event: unknown) => void
export type RemoteNodeManifestListener = (manifest: RemoteNodeManifest) => void
export type RemoteNodeStateListener = (
  state: RemoteNodeConnectionState,
) => void
export type RemoteNodeStopListener = (error: RemoteNodeClientFailure) => void
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

export interface RemoteNodeClientErrorInit {
  readonly code: RemoteNodeClientErrorCode
  readonly message: string
  readonly retryable: boolean
  /** 调用已上过线但拿不到终态:重试可能造成第二次副作用。 */
  readonly resultUnknown: boolean
  readonly nodeError?: LooseOptional<RemoteNodeError>
  readonly cause?: unknown
}

/** 建一份客户端凭据存储要的东西;三项都不给时落在缺省目录下。 */
export interface RemoteNodeClientCredentialStoreOptions {
  /** 远端主机的 slug(`RemoteNodeProjectionApi.hostSlug`);一台主机一份文件,互不影响。 */
  readonly hostSlug: string
  /** 家目录覆盖;不给就用当前用户的家目录。 */
  readonly home?: string
  /** 直接指定凭据文件路径;给了就不再按 slug 算落点。 */
  readonly path?: string
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
