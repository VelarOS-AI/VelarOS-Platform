// Platform Kernel owns the host-neutral remote-node implementation.
// 域:Node 侧(无头能力提供者)向宿主索取的注入端口。
//
// 宪章 §15 原则三:Node 零会话权威——它不认识会话、不持 Agent 主干,只把本机能力面摊开给
// 唯一一台已配对的 Client。因此本文件的端口全是「被调」方向:没有任何允许 Node 主动向
// Client 发起请求的回调形状,清单变更也只是单向推送而不是问答。
import type {
  RemoteNodeError,
  RemoteNodeIdentity,
  RemoteNodeManifest,
  ScopeRef,
} from '@velaros-ai/kernel/contracts/protocol'

/**
 * WebSocket 升级路径。
 *
 * 两端硬编码同一常量,不做发现也不做协商:路径不是安全边界(真正的门是 challenge 签名),
 * 它只负责把本进程里可能并存的其它 HTTP 面区分开。
 */
export const RemoteNodeSocketPath = '/v1/remote-node/ws'

/**
 * 一次能力派发的入参。
 *
 * `input` 保持 `unknown`:Node 侧不认识任何能力的具体入参形状,校验是被派发能力自己的事,
 * 传输层多解释一层只会产生第二份会漂移的 schema。
 */
export interface RemoteNodeCapabilityInvokeRequest {
  readonly capabilityId: string
  readonly operation: string
  readonly scope: Nullable<ScopeRef>
  readonly input: unknown
}

/**
 * 派发结果。
 *
 * 只有 `success` / `denied` 两态——`denied` 是**派发后**的策略事实(权限判定拒绝),要如实
 * 回给模型;传输层故障与异常由 Server 侧统一翻成 wire 上的 `error`,不占用本端口的态位。
 */
export interface RemoteNodeCapabilityInvokeResult {
  readonly status: 'success' | 'denied'
  readonly output?: unknown
  readonly error?: { readonly code: string, readonly message: string }
}

/** 能力派发端口:把 wire 上的调用交给宿主 Kernel,`signal` 承载取消与超时。 */
export interface RemoteNodeCapabilityInvoker {
  invoke(
    request: RemoteNodeCapabilityInvokeRequest,
    signal: AbortSignal,
  ): Promise<RemoteNodeCapabilityInvokeResult>
}

/**
 * 清单来源。
 *
 * `current()` 必须是同步的:握手末尾要在同一个 tick 内把清单塞进 `ready` 帧,中间插入 await
 * 会让「授予能力面」与「宣告能力面」之间出现可观测的空窗。
 */
export interface RemoteNodeManifestSource {
  current(): RemoteNodeManifest
  onChange(listener: (manifest: RemoteNodeManifest) => void): () => void
}

/** 已配对客户端的长期凭据。私钥永不上线,Node 侧只存公钥。 */
export interface RemoteNodePairedCredential {
  readonly clientId: string
  readonly publicKey: string
  readonly clientName: string
  readonly pairedAt: number
}

/**
 * 凭据持久化端口。
 *
 * `load()` 语义是**失败即未配对**:任何读取或校验失败都返回 `null` 而不是抛,让 Node 退回到
 * 「需要重新配对」这一最小权限状态,而不是带着半个凭据继续服务。
 */
export interface RemoteNodeCredentialStore {
  load(): Promise<Nullable<RemoteNodePairedCredential>>
  save(credential: RemoteNodePairedCredential): Promise<void>
  clear(): Promise<void>
}

/**
 * 审计行。
 *
 * 字段表是**封闭**的,且刻意不含 `input` / `output` / `scope`:跨机链路上流过的载荷可能是 PIN、
 * token 或截图,审计的职责是回答「谁在什么时候调了什么、结果如何」,不是留存证据副本。
 * 新增字段前先问一遍它是否可能携带调用方载荷。
 */
export interface RemoteNodeAuditEntry {
  readonly at: number
  readonly callId: string
  readonly clientId: string
  readonly capabilityId: string
  readonly operation: string
  readonly status: 'success' | 'error' | 'denied'
  readonly durationMs: number
  readonly errorCode: Nullable<string>
}

/**
 * 审计落盘端口。
 *
 * 返回 `void` 而不是 Promise 是有意的:审计写盘绝不能进入调用路径的关键路径,更不能因为磁盘
 * 满或权限错误把一次正常的能力调用带塌。实现方自行排队并吞掉自身故障(降级为告警)。
 */
export interface RemoteNodeAuditSink {
  record(entry: RemoteNodeAuditEntry): void
}

/**
 * A local, product-facing execution stream. Unlike the security audit, this
 * stream may carry inputs and outputs so an embedding product can project a
 * remote call into its own private session history. The transport never
 * persists these values itself.
 */
export type RemoteNodeActivityEvent =
  | {
      readonly type: 'started'
      readonly at: number
      readonly callId: string
      readonly clientId: string
      readonly clientName: string
      readonly capabilityId: string
      readonly operation: string
      readonly input: unknown
    }
  | {
      readonly type: 'finished'
      readonly at: number
      readonly callId: string
      readonly clientId: string
      readonly clientName: string
      readonly capabilityId: string
      readonly operation: string
      readonly status: 'success' | 'error' | 'denied'
      readonly durationMs: number
      readonly output?: unknown
      readonly error: Nullable<RemoteNodeError>
    }

export interface RemoteNodeActivitySink {
  record(event: RemoteNodeActivityEvent): void
}

/** 宿主装配 `RemoteNodeServer` 时必须交出来的全部东西。 */
export interface RemoteNodeServerOptions {
  readonly nodeName: string
  readonly nodeVersion: string
  readonly manifestSource: RemoteNodeManifestSource
  readonly invoker: RemoteNodeCapabilityInvoker
  readonly credentialStore: RemoteNodeCredentialStore
  readonly audit: RemoteNodeAuditSink
  /** Optional live projection for an embedding product's private session UI. */
  readonly activity?: RemoteNodeActivitySink
  readonly nodeId?: string
  /** 绑定地址。默认只回环;跨机监听必须由宿主显式放开,不做静默的全网暴露。 */
  readonly bindHost?: string
  readonly portStart?: number
  readonly portEnd?: number
  readonly maxConcurrentInvocations?: number
  /** 确定性测试缝;生产环境自生成六位码。 */
  readonly pairingCode?: string
  readonly now?: () => number
}

export interface RemoteNodeServerStatus {
  readonly endpoint: string
  readonly node: RemoteNodeIdentity
  readonly manifestRevision: string
  readonly pairingCode: Nullable<string>
  readonly pairingExpiresAt: Nullable<number>
  readonly pairedClientId: Nullable<string>
  readonly connectedClientId: Nullable<string>
  readonly inFlightCalls: number
}
