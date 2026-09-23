import type {
  RemoteNodeActivitySink,
  RemoteNodeAuditSink,
  RemoteNodeCapabilityInvoker,
  RemoteNodeManifestSource,
  RemoteNodeServerCredentialStore as RemoteNodeCredentialStore,
} from '../contract/requires.js'

export type { RemoteNodeServerCredentialStore as RemoteNodeCredentialStore } from '../contract/requires.js'
// Platform Kernel 统一持有与宿主无关的远程节点实现。
// 域:Node 侧(无头能力提供者)向宿主索取的注入端口。
//
// 宪章 §15 原则三:Node 零会话权威——它不认识会话、不持 Agent 主干,只把本机能力面摊开给
// 唯一一台已配对的 Client。因此本文件的端口全是「被调」方向:没有任何允许 Node 主动向
// Client 发起请求的回调形状,清单变更也只是单向推送而不是问答。
import type { RemoteNodeError, RemoteNodeIdentity, ScopeRef } from './wire.js'

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
  readonly error?: { readonly code: string; readonly message: string }
}

/** 已配对客户端的长期凭据。私钥永不上线,Node 侧只存公钥。 */
export interface RemoteNodePairedCredential {
  readonly clientId: string
  readonly publicKey: string
  readonly clientName: string
  readonly pairedAt: number
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
 * 面向产品的本地执行流。
 *
 * 与安全审计相反,这条流**可以**带 input / output:嵌入方要把一次远程调用投影进自己的私有会话
 * 历史。传输层自己永不持久化这些值,落不落盘由产品决定。
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

/** 宿主装配 `RemoteNodeServer` 时必须交出来的全部东西。 */
export interface RemoteNodeServerOptions {
  readonly nodeName: string
  readonly nodeVersion: string
  readonly manifestSource: RemoteNodeManifestSource
  readonly invoker: RemoteNodeCapabilityInvoker
  readonly credentialStore: RemoteNodeCredentialStore
  readonly audit: RemoteNodeAuditSink
  /** 可选的实时投影口:嵌入方拿它把远程调用画进自己的私有会话界面。 */
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
