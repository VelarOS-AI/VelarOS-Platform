// 域：wire 上的帧与信封形状。
//
// 这些类型手写在这里，zod schema 留在 `utils/wire/`，并用 `satisfies z.ZodType<…>` 反向守：
// 类型是人读的单源，schema 是运行期校验，两边对不上编译期就报错（方案 §3.5 第 1 条）。
// wire 形态与 ABI 形态刻意不合并：wire 上缺席一律写成 `null`，ABI 上写成可选字段。
import type {
  KernelModuleIsolation,
  KernelRpcMethod,
  RemoteNodeCloseCode,
} from '../contract/constants.js'

import type { KernelEvent } from './kernel.js'

/** wire 上的隔离形态，取值与 ABI 的 {@link KernelModuleIsolation} 同一张表。 */
export type CapabilityIsolation = KernelModuleIsolation

/** wire 上的能力令牌：只有身份与版本，没有编译期服务类型。 */
export interface CapabilityToken {
  readonly id: string
  readonly version: string
}

/** wire 上的能力依赖声明；缺席的版本范围写成 `null`。 */
export interface CapabilityRequirement {
  readonly id: string
  readonly versionRange: Nullable<string>
}

/** wire 上的作用域句柄；缺席的 `kind` 写成 `null`。 */
export interface ScopeRef {
  readonly id: string
  readonly ownerModuleId: string
  readonly kind: Nullable<string>
}

/** wire 上的资源句柄；缺席的字段一律写成 `null`。 */
export interface ResourceRef {
  readonly id: string
  readonly ownerModuleId: string
  readonly scope: Nullable<ScopeRef>
  readonly mediaType: Nullable<string>
}

/** wire 上的模块发现描述符，比 ABI 清单多一个目录修订号。 */
export interface KernelModuleDescriptor {
  readonly id: string
  readonly version: string
  readonly apiVersion: number
  readonly provides: CapabilityToken[]
  readonly requires: CapabilityRequirement[]
  readonly optionalRequires: CapabilityRequirement[]
  readonly permissions: string[]
  readonly isolation: CapabilityIsolation
  readonly catalogRevision: string
}

/** 连接建立时守护进程上报的握手。 */
export interface KernelHandshake {
  readonly protocolVersion: number
  readonly kernelVersion: string
  readonly modules: KernelModuleDescriptor[]
}

/** 握手判定结果：接受，或带升级指引的拒绝。 */
export type KernelProtocolNegotiation =
  | {
      status: 'accepted'
      localVersion: number
      peerVersion: number
    }
  | {
      status: 'rejected'
      /** `peer-too-old`：须对端升级；`peer-too-new`：须本端升级。 */
      reason: 'peer-too-old' | 'peer-too-new'
      localVersion: number
      peerVersion: number
      /** 面向操作者的升级指引（哪一侧该升到哪个版本）。 */
      guidance: string
    }

/** 通用能力调用请求；`input` 的精确形状归各能力协议，内核只校验外层信封。 */
export interface CapabilityCallRequest {
  readonly protocolVersion: number
  readonly callId: string
  /** 经 `capability.session.open` 绑定过这件能力的会话。 */
  readonly sessionId: string
  readonly capabilityId: string
  readonly operation: string
  readonly scope: Nullable<ScopeRef>
  readonly input?: unknown
}

/** wire 上的失败信封；`retryable` 给传输层重试策略读，不给模型读。 */
export interface CapabilityCallError {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
  readonly details: Nullable<Record<string, unknown>>
}

/** 调用成功。 */
export interface CapabilityCallSuccess {
  readonly protocolVersion: number
  readonly callId: string
  readonly status: 'ok'
  readonly output?: unknown
}

/** 调用失败。 */
export interface CapabilityCallFailure {
  readonly protocolVersion: number
  readonly callId: string
  readonly status: 'error'
  readonly error: CapabilityCallError
}

/** 调用的终态帧。 */
export type CapabilityCallResponse = CapabilityCallSuccess | CapabilityCallFailure

/** 会话要绑定的一条能力；`operations` 为 `null` 表示该能力下的全部操作。 */
export interface CapabilityRequireItem {
  readonly capabilityId: string
  readonly operations: Nullable<string[]>
  readonly scope: Nullable<ScopeRef>
}

/** 打开能力会话：一次声明本连接需要的能力集。 */
export interface CapabilitySessionOpenRequest {
  readonly protocolVersion: number
  readonly requires: CapabilityRequireItem[]
}

/** 会话打开成功，回执里带上真正绑成的能力集。 */
export interface CapabilitySessionOpenSuccess {
  readonly protocolVersion: number
  readonly status: 'ok'
  readonly sessionId: string
  readonly requires: CapabilityRequireItem[]
}

/** 会话打开失败。 */
export interface CapabilitySessionOpenFailure {
  readonly protocolVersion: number
  readonly status: 'error'
  readonly error: CapabilityCallError
}

/** 会话打开的应答。 */
export type CapabilitySessionOpenResponse =
  CapabilitySessionOpenSuccess | CapabilitySessionOpenFailure

/** 关闭能力会话。 */
export interface CapabilitySessionCloseRequest {
  readonly protocolVersion: number
  readonly sessionId: string
}

/** 关闭能力会话的应答。 */
export interface CapabilitySessionCloseResponse {
  readonly protocolVersion: number
  readonly closed: boolean
}

/** mod pack 的来源分档。 */
export type KernelModPackKind = 'system' | 'user' | 'contrib'

/** mod pack 在 wire 上的描述。 */
export interface KernelModPackDescriptor {
  readonly id: string
  readonly kind: KernelModPackKind
  readonly version: string
  readonly enabled: boolean
  readonly provides: string[]
  readonly specifier: string
}

/** 列出全部 mod pack。 */
export interface ModsListRequest {
  readonly protocolVersion: number
}

/** mod pack 列表。 */
export interface ModsListResponse {
  readonly protocolVersion: number
  readonly packs: KernelModPackDescriptor[]
}

/** 启停一个 mod pack。 */
export interface ModsSetEnabledRequest {
  readonly protocolVersion: number
  readonly id: string
  readonly enabled: boolean
}

/** 启停结果；`reloadRequired` 表示要重启守护进程才生效。 */
export interface ModsSetEnabledResponse {
  readonly protocolVersion: number
  readonly ok: boolean
  readonly reloadRequired: boolean
}

/** 从目录安装一个 mod pack。 */
export interface ModsInstallFromDirectoryRequest {
  readonly protocolVersion: number
  readonly directory: string
}

/** 安装结果。 */
export interface ModsInstallFromDirectoryResponse {
  readonly protocolVersion: number
  readonly pack: KernelModPackDescriptor
  readonly reloadRequired: boolean
}

/** mod 信封里 module 段声明的一枚能力令牌；不写版本时按 `1.0.0` 补齐。 */
export interface VelarosModCapabilityToken {
  readonly id: string
  readonly version: string
}

/** mod 信封里 module 段声明的一条能力依赖。 */
export interface VelarosModCapabilityRequirement {
  readonly id: string
  readonly versionRange?: string
}

/**
 * mod 信封里内核拥有的那一段。
 *
 * `provides` 里只放真正可调用的能力 id：域路由看的是有没有兄弟节，
 * 绝不许把能力 id 当成 pack 标记来用。
 */
export interface VelarosModModuleSection {
  readonly id: string
  readonly version: string
  readonly apiVersion: number
  readonly provides: VelarosModCapabilityToken[]
  readonly requires: VelarosModCapabilityRequirement[]
  readonly optionalRequires: VelarosModCapabilityRequirement[]
  readonly permissions: string[]
  readonly isolation: CapabilityIsolation
  readonly entry?: string
  readonly exportName?: string
}

/**
 * 唯一的公开 mod 清单信封。
 *
 * 内核只校验 `module` 段；别的段对内核是不透明载荷，由各自的域主人在路由之后自己校验。
 */
export interface VelarosModEnvelope {
  readonly module: VelarosModModuleSection
  readonly agent?: unknown
  readonly ui?: unknown
}

/** 解析 mod 信封时给出的一条诊断。 */
export interface VelarosModManifestDiagnostic {
  /** 诊断码，外面按它判断，不按文字。 */
  readonly code: string
  /** 给人看的一句话。 */
  readonly message: string
  /** 出问题的字段路径。 */
  readonly path?: string
  /** 出问题的 mod id。 */
  readonly modId?: string
  /** 这份清单是从哪里读来的。 */
  readonly origin?: string
}

/** mod 信封的解析结果：成功给信封，失败给诊断。 */
export type VelarosModEnvelopeParseResult =
  | { readonly ok: true; readonly envelope: VelarosModEnvelope }
  | { readonly ok: false; readonly diagnostics: readonly VelarosModManifestDiagnostic[] }

/** 远程节点所在的操作系统。 */
export type RemoteNodePlatform = 'darwin' | 'linux' | 'win32'

/**
 * 节点身份。
 *
 * `epoch` 每次 Node 进程启动重新生成：Client 一旦发现 epoch 变了，就知道对端重启过，
 * 在途调用的结果永远不会再来——必须按「结果未知」上抛，不能静默当成功或失败。
 */
export interface RemoteNodeIdentity {
  readonly nodeId: string
  readonly nodeName: string
  readonly platform: RemoteNodePlatform
  readonly arch: string
  readonly nodeVersion: string
  readonly epoch: string
}

/** 一条能力操作：名字加它声明的权限位。 */
export interface RemoteNodeOperationDescriptor {
  readonly name: string
  readonly permissions: string[]
}

/** 远端能力描述符；`moduleId` 与 `capabilityId` 是 Node 侧原名，命名空间化只发生在 Client。 */
export interface RemoteNodeCapabilityDescriptor {
  readonly moduleId: string
  readonly capabilityId: string
  readonly version: string
  readonly operations: RemoteNodeOperationDescriptor[]
}

/** 远端工具描述符：把一条能力操作投影成 Agent 主干能注册的工具。 */
export interface RemoteNodeToolDescriptor {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly category: Nullable<string>
  readonly readOnly: boolean
  readonly capabilityId: string
  readonly operation: string
}

/** 节点能力清单；`revision` 是新鲜度门，携旧 revision 的调用一律拒绝。 */
export interface RemoteNodeManifest {
  readonly revision: string
  readonly capabilities: RemoteNodeCapabilityDescriptor[]
  readonly tools: RemoteNodeToolDescriptor[]
}

/** 远程节点的错误信封。 */
export interface RemoteNodeError {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
}

/** 首帧：未配对时也要带 `clientId`，但只有签名通过才授予能力。 */
export interface RemoteNodeHello {
  readonly type: 'hello'
  readonly protocolVersion: number
  readonly clientId: string
  readonly clientName: string
  readonly platform: RemoteNodePlatform
}

/** 配对：一次性人工仪式，Client 交出公钥，私钥永不上线。 */
export interface RemoteNodePair {
  readonly type: 'pair'
  readonly pairingCode: string
  readonly publicKey: string
}

/** 认证：对 Node 下发的 challenge 做签名，每次连接一枚新 challenge。 */
export interface RemoteNodeAuthenticate {
  readonly type: 'authenticate'
  readonly signature: string
}

/** 能力调用；`callId` 全局唯一，Node 侧据此幂等去重。 */
export interface RemoteNodeInvoke {
  readonly type: 'invoke'
  readonly callId: string
  readonly manifestRevision: string
  readonly capabilityId: string
  readonly operation: string
  readonly scope: Nullable<ScopeRef>
  readonly input?: unknown
  readonly deadlineMs: number
}

/** 取消在途调用；best-effort，Node 侧 abort 后仍会回一帧终态。 */
export interface RemoteNodeCancel {
  readonly type: 'cancel'
  readonly callId: string
  readonly reason: string
}

/** 心跳请求。 */
export interface RemoteNodePing {
  readonly type: 'ping'
  readonly at: number
}

/** Client 能发给 Node 的全部帧。 */
export type RemoteNodeClientFrame =
  | RemoteNodeHello
  | RemoteNodePair
  | RemoteNodeAuthenticate
  | RemoteNodeInvoke
  | RemoteNodeCancel
  | RemoteNodePing

/** 握手应答加 challenge；`paired` 告诉 Client 该走认证还是配对。 */
export interface RemoteNodeChallenge {
  readonly type: 'challenge'
  readonly protocolVersion: number
  readonly node: RemoteNodeIdentity
  readonly challenge: string
  readonly paired: boolean
}

/** 配对成功，Client 据此把公钥与节点身份落盘。 */
export interface RemoteNodePaired {
  readonly type: 'paired'
  readonly node: RemoteNodeIdentity
}

/** 认证通过，授予能力面，清单随本帧一次性下发。 */
export interface RemoteNodeReady {
  readonly type: 'ready'
  readonly node: RemoteNodeIdentity
  readonly manifest: RemoteNodeManifest
}

/** 清单变更的主动推送；Client 收到后必须重注册工具面。 */
export interface RemoteNodeManifestChanged {
  readonly type: 'manifest_changed'
  readonly manifest: RemoteNodeManifest
}

/** 调用终态；`denied` 是派发后的策略事实，与链路故障的 `error` 分立。 */
export interface RemoteNodeResult {
  readonly type: 'result'
  readonly callId: string
  readonly status: 'success' | 'error' | 'denied'
  readonly output?: unknown
  readonly error: Nullable<RemoteNodeError>
}

/** 逐调用的进度事件；长任务靠它出声，不靠拉长超时。 */
export interface RemoteNodeProgress {
  readonly type: 'progress'
  readonly callId: string
  readonly event?: unknown
}

/** 心跳应答。 */
export interface RemoteNodePong {
  readonly type: 'pong'
  readonly at: number
}

/** 连接级错误；发出后 Node 通常随即关闭连接。 */
export interface RemoteNodeFatal {
  readonly type: 'fatal'
  readonly error: RemoteNodeError
}

/** Node 能发给 Client 的全部帧。 */
export type RemoteNodeServerFrame =
  | RemoteNodeChallenge
  | RemoteNodePaired
  | RemoteNodeReady
  | RemoteNodeManifestChanged
  | RemoteNodeResult
  | RemoteNodeProgress
  | RemoteNodePong
  | RemoteNodeFatal

/** 远程节点 WebSocket 关闭码的取值；与常量表 `RemoteNodeCloseCodes` 同一张表。 */
export type RemoteNodeCloseCodeValue = RemoteNodeCloseCode

/** 本机 RPC 的请求帧。 */
export interface KernelRpcRequest {
  readonly type: 'request'
  readonly requestId: string
  readonly authToken: string
  readonly method: KernelRpcMethod
  readonly params: unknown
}

/** 本机 RPC 的失败信封。 */
export interface KernelRpcError {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
  readonly details: Nullable<Readonly<Record<string, unknown>>>
}

/** 本机 RPC 的成功应答。 */
export interface KernelRpcSuccess {
  readonly type: 'response'
  readonly requestId: string
  readonly status: 'ok'
  readonly result: unknown
}

/** 本机 RPC 的失败应答。 */
export interface KernelRpcFailure {
  readonly type: 'response'
  readonly requestId: string
  readonly status: 'error'
  readonly error: KernelRpcError
}

/** 本机 RPC 的应答帧。 */
export type KernelRpcResponse = KernelRpcSuccess | KernelRpcFailure

/** 本机 RPC 推给客户端的事件帧。 */
export interface KernelRpcEventFrame {
  readonly type: 'event'
  readonly subscriptionId: string
  readonly event: KernelEvent
}

/** 本机 RPC 服务端能发出的全部帧。 */
export type KernelRpcServerFrame = KernelRpcResponse | KernelRpcEventFrame
