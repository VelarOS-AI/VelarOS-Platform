// 域:远程能力节点(Remote Node)的 wire 契约。
//
// 宪章 §15 原则一:进程边界是部署决策,承载位 = module descriptor 的 isolation 轴。
// `isolation: 'remote'` 的 provider 住在另一台机器上,由宿主注入的 isolation adapter
// 负责传输;本文件只定义两端之间的帧形状,不含任何实现。
//
// 宪章 §5 wire 裁决①「版本双轴」:本协议是 **transport 绑定版本轴**,与
// KernelProtocolVersion(契约语义轴)独立演进,两者不合并。
//
// 角色不对称,别读反:
//   Client = 完整宿主(Desktop/Workbench),持 Kernel、Agent 主干与会话权威。
//   Node   = 无头能力提供者,零会话权威、零 Agent 主干(宪章 §15 原则三)。
// 因此 Node 永不发起调用,只应答;所有 invoke 由 Client 发出。
import { z } from 'zod'

import { ScopeRefSchema } from './capability'

/**
 * Remote Node transport 绑定版本。
 *
 * 与 KernelProtocolVersion 是两根轴。帧形状、握手与重连细节变化提升本号;
 * 能力调用信封的语义变化提升 KernelProtocolVersion。两端只接受完全相同的本号。
 */
export const RemoteNodeProtocolVersion = 1

/** 单帧上限:截图类输出走同一条连接,故按图片体量给,不按文本给。 */
export const RemoteNodeMaxFrameBytes = 32 * 1_024 * 1_024

/** 配对码有效期与失败锁定,和插件桥同一套人机节奏。 */
export const RemoteNodePairingLifetimeMs = 5 * 60 * 1_000
export const RemoteNodePairingMaxFailures = 5
export const RemoteNodePairingLockoutMs = 30 * 1_000

/** 心跳:Client 主动发,Node 侧据此判活。 */
export const RemoteNodeHeartbeatIntervalMs = 15 * 1_000
export const RemoteNodeIdleTimeoutMs = 60 * 1_000

export const RemoteNodePlatformSchema = z.enum(['darwin', 'linux', 'win32'])
export type RemoteNodePlatform = z.infer<typeof RemoteNodePlatformSchema>

/**
 * 节点身份。
 *
 * `epoch` 每次 Node 进程启动重新生成:Client 一旦发现 epoch 变了,就知道对端重启过,
 * 在途调用的结果永远不会再来——必须按「结果未知」上抛,不能静默当成功或失败。
 */
export const RemoteNodeIdentitySchema = z.strictObject({
  nodeId: z.string().min(1),
  nodeName: z.string().min(1),
  platform: RemoteNodePlatformSchema,
  arch: z.string().min(1),
  nodeVersion: z.string().min(1),
  epoch: z.string().min(1),
})
export type RemoteNodeIdentity = z.infer<typeof RemoteNodeIdentitySchema>

/** 能力操作:名字 + 该操作声明的权限位(Client 侧 broker 据此逐权限判定)。 */
export const RemoteNodeOperationDescriptorSchema = z.strictObject({
  name: z.string().min(1),
  permissions: z.array(z.string().min(1)),
})
export type RemoteNodeOperationDescriptor = z.infer<
  typeof RemoteNodeOperationDescriptorSchema
>

/**
 * 远端能力描述符。
 *
 * Client 用它在本地 Kernel 注册 `isolation: 'remote'` 的代理模块;`moduleId` 与
 * `capabilityId` 是 **Node 侧的原名**,命名空间化由 Client 在注册时施加,不在 wire 上做。
 */
export const RemoteNodeCapabilityDescriptorSchema = z.strictObject({
  moduleId: z.string().min(1),
  capabilityId: z.string().min(1),
  version: z.string().min(1),
  operations: z.array(RemoteNodeOperationDescriptorSchema).min(1),
})
export type RemoteNodeCapabilityDescriptor = z.infer<
  typeof RemoteNodeCapabilityDescriptorSchema
>

/**
 * 远端工具描述符:把一个能力操作投影成 Agent 主干可注册的工具。
 *
 * Node 侧广播 schema 而不是让 Client 静态假设,是为了容忍两端 Platform 版本轻微错位:
 * 目录以 Node 实际拥有的为准。
 */
export const RemoteNodeToolDescriptorSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  category: z.string().min(1).nullable(),
  readOnly: z.boolean(),
  capabilityId: z.string().min(1),
  operation: z.string().min(1),
})
export type RemoteNodeToolDescriptor = z.infer<
  typeof RemoteNodeToolDescriptorSchema
>

/**
 * 节点能力清单。
 *
 * `revision` = 清单内容的稳定摘要,充当新鲜度门:Node 侧任一开关变化都会换 revision,
 * 携旧 revision 的调用一律拒绝(与 surface-protocol 的 catalogRevision 同一纪律)。
 */
export const RemoteNodeManifestSchema = z.strictObject({
  revision: z.string().min(1),
  capabilities: z.array(RemoteNodeCapabilityDescriptorSchema),
  tools: z.array(RemoteNodeToolDescriptorSchema),
})
export type RemoteNodeManifest = z.infer<typeof RemoteNodeManifestSchema>

/** 错误信封;`retryable` 是给传输层重试策略读的,不是给模型读的。 */
export const RemoteNodeErrorSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string(),
  retryable: z.boolean(),
})
export type RemoteNodeError = z.infer<typeof RemoteNodeErrorSchema>

// ---------------------------------------------------------------------------
// Client → Node
// ---------------------------------------------------------------------------

/**
 * 首帧。未配对时 `clientId` 仍需携带(Node 用它判断是新设备还是已知设备),
 * 但只有 challenge 签名通过才授予任何能力。
 */
export const RemoteNodeHelloSchema = z.strictObject({
  type: z.literal('hello'),
  protocolVersion: z.literal(RemoteNodeProtocolVersion),
  clientId: z.string().min(1),
  clientName: z.string().min(1),
  platform: RemoteNodePlatformSchema,
})
export type RemoteNodeHello = z.infer<typeof RemoteNodeHelloSchema>

/**
 * 配对:一次性人工仪式。Client 交出**公钥**,私钥永不上线。
 *
 * 配对码只在这一帧出现;之后的每次连接都是 challenge 签名,不再有共享秘密穿过网络。
 */
export const RemoteNodePairSchema = z.strictObject({
  type: z.literal('pair'),
  pairingCode: z.string().regex(/^\d{6}$/u),
  publicKey: z.string().min(1),
})
export type RemoteNodePair = z.infer<typeof RemoteNodePairSchema>

/** 认证:对 Node 下发的 challenge 做签名。每次连接一枚新 challenge,防重放。 */
export const RemoteNodeAuthenticateSchema = z.strictObject({
  type: z.literal('authenticate'),
  signature: z.string().min(1),
})
export type RemoteNodeAuthenticate = z.infer<
  typeof RemoteNodeAuthenticateSchema
>

/**
 * 能力调用。
 *
 * `callId` 由 Client 生成且全局唯一(UUID),Node 侧据此做**幂等去重**:同一 callId
 * 重复到达只执行一次,重复请求回放已有结果。这是重连后安全重试的前提。
 * `manifestRevision` 是新鲜度门。`deadlineMs` 到期 Node 侧自行 abort 并回 error。
 */
export const RemoteNodeInvokeSchema = z.strictObject({
  type: z.literal('invoke'),
  callId: z.string().min(1),
  manifestRevision: z.string().min(1),
  capabilityId: z.string().min(1),
  operation: z.string().min(1),
  scope: ScopeRefSchema.nullable(),
  input: z.unknown(),
  deadlineMs: z.number().int().positive(),
})
export type RemoteNodeInvoke = z.infer<typeof RemoteNodeInvokeSchema>

/** 取消在途调用。best-effort:Node 侧 abort 后仍会回一帧终态 result。 */
export const RemoteNodeCancelSchema = z.strictObject({
  type: z.literal('cancel'),
  callId: z.string().min(1),
  reason: z.string(),
})
export type RemoteNodeCancel = z.infer<typeof RemoteNodeCancelSchema>

export const RemoteNodePingSchema = z.strictObject({
  type: z.literal('ping'),
  at: z.number().int().nonnegative(),
})
export type RemoteNodePing = z.infer<typeof RemoteNodePingSchema>

export const RemoteNodeClientFrameSchema = z.discriminatedUnion('type', [
  RemoteNodeHelloSchema,
  RemoteNodePairSchema,
  RemoteNodeAuthenticateSchema,
  RemoteNodeInvokeSchema,
  RemoteNodeCancelSchema,
  RemoteNodePingSchema,
])
export type RemoteNodeClientFrame = z.infer<typeof RemoteNodeClientFrameSchema>

// ---------------------------------------------------------------------------
// Node → Client
// ---------------------------------------------------------------------------

/**
 * 握手应答 + challenge。
 *
 * `paired` 告诉 Client 该走 `authenticate` 还是 `pair`。协议版本不匹配时 Node 仍先回
 * 本帧再关闭,好让 Client 报出明确的升级方向而不是"连接被拒"。
 */
export const RemoteNodeChallengeSchema = z.strictObject({
  type: z.literal('challenge'),
  protocolVersion: z.number().int().positive(),
  node: RemoteNodeIdentitySchema,
  challenge: z.string().min(1),
  paired: z.boolean(),
})
export type RemoteNodeChallenge = z.infer<typeof RemoteNodeChallengeSchema>

/** 配对成功。Client 据此把公钥/节点身份落盘,下次直接走 authenticate。 */
export const RemoteNodePairedSchema = z.strictObject({
  type: z.literal('paired'),
  node: RemoteNodeIdentitySchema,
})
export type RemoteNodePaired = z.infer<typeof RemoteNodePairedSchema>

/** 认证通过,授予能力面。清单随本帧一次性下发。 */
export const RemoteNodeReadySchema = z.strictObject({
  type: z.literal('ready'),
  node: RemoteNodeIdentitySchema,
  manifest: RemoteNodeManifestSchema,
})
export type RemoteNodeReady = z.infer<typeof RemoteNodeReadySchema>

/**
 * 清单变更主动推送(Node 侧开关被人改动时)。
 *
 * Client 收到后必须重注册工具面:旧 revision 的在途调用会被拒,这是设计而非故障。
 */
export const RemoteNodeManifestChangedSchema = z.strictObject({
  type: z.literal('manifest_changed'),
  manifest: RemoteNodeManifestSchema,
})
export type RemoteNodeManifestChanged = z.infer<
  typeof RemoteNodeManifestChangedSchema
>

/**
 * 调用终态。
 *
 * 三态与 Kernel 调用信封同构:`denied` 是权限拒绝(派发后),与传输层 error 分立——
 * 前者是策略事实要如实回给模型,后者是链路故障要触发重试。
 */
export const RemoteNodeResultSchema = z.strictObject({
  type: z.literal('result'),
  callId: z.string().min(1),
  status: z.enum(['success', 'error', 'denied']),
  output: z.unknown().optional(),
  error: RemoteNodeErrorSchema.nullable(),
})
export type RemoteNodeResult = z.infer<typeof RemoteNodeResultSchema>

/** 逐调用进度事件。长任务(构建/签名)靠它出声,不靠拉长超时。 */
export const RemoteNodeProgressSchema = z.strictObject({
  type: z.literal('progress'),
  callId: z.string().min(1),
  event: z.unknown(),
})
export type RemoteNodeProgress = z.infer<typeof RemoteNodeProgressSchema>

export const RemoteNodePongSchema = z.strictObject({
  type: z.literal('pong'),
  at: z.number().int().nonnegative(),
})
export type RemoteNodePong = z.infer<typeof RemoteNodePongSchema>

/** 连接级错误(认证失败、协议不符、帧超限)。发出后 Node 通常随即关闭连接。 */
export const RemoteNodeFatalSchema = z.strictObject({
  type: z.literal('fatal'),
  error: RemoteNodeErrorSchema,
})
export type RemoteNodeFatal = z.infer<typeof RemoteNodeFatalSchema>

export const RemoteNodeServerFrameSchema = z.discriminatedUnion('type', [
  RemoteNodeChallengeSchema,
  RemoteNodePairedSchema,
  RemoteNodeReadySchema,
  RemoteNodeManifestChangedSchema,
  RemoteNodeResultSchema,
  RemoteNodeProgressSchema,
  RemoteNodePongSchema,
  RemoteNodeFatalSchema,
])
export type RemoteNodeServerFrame = z.infer<typeof RemoteNodeServerFrameSchema>

/** 关闭码:4001 起是应用层语义,Client 据此决定是重连还是停手等人。 */
export const RemoteNodeCloseCode = {
  /** 协议版本不匹配——重连无用,必须升级某一端。 */
  ProtocolMismatch: 4001,
  /** 认证失败——重连无用,需要重新配对。 */
  Unauthorized: 4002,
  /** 被同一 Client 的新连接顶替——不重连。 */
  Replaced: 4003,
  /** 空闲超时或 Node 正常停机——可重连。 */
  Transient: 4004,
} as const
export type RemoteNodeCloseCodeValue =
  (typeof RemoteNodeCloseCode)[keyof typeof RemoteNodeCloseCode]
