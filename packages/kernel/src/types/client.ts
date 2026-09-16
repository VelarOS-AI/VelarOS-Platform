// 域：瘦客户端的工作类型（能力会话入参、socket 传输的构造入参、在途请求与本地订阅记录）。
//
// 连接契约本身（`KernelClientTransport` 与它的事件回调）在 `client-transport.ts`；这里只放
// 客户端自己在用的数据形状。
import type { KernelClientEventHandler } from '../contract/requires'

import type { KernelRpcEndpoint } from './kernel.js'
import type { CapabilityRequireItem } from './wire.js'

/** 开一条能力会话时声明的东西：这个场景要绑哪些能力。 */
export interface OpenCapabilitySessionInput {
  /** 本场景要绑定的能力清单；会话开出来之后只有这些能力调得动。 */
  readonly requires: readonly CapabilityRequireItem[]
}

/** 一条 socket 传输的构造入参：连哪儿、拿什么令牌、单帧多大算超限。 */
export interface SocketKernelTransportOptions {
  /** 连接时随每一帧发出去的认证令牌，取自守护进程发布的 descriptor。 */
  readonly authToken: string
  /** 守护进程的端点（unix socket 或 tcp）。 */
  readonly endpoint: KernelRpcEndpoint
  /** 单帧字节上限，超了就断开连接；缺席时用合同里对外承诺的上限。 */
  readonly maxFrameBytes?: number
}

/** 一条已经发出去、还没等到回应的请求；回应到达或连接断开时按它收尾。 */
export interface KernelClientPendingRequest {
  /** 收到成功回应时把结果交出去。 */
  readonly resolve: (result: unknown) => void
  /** 收到失败回应、连接断开或请求被取消时把错误交出去。 */
  readonly reject: (error: Error) => void
  /** 收尾：摘掉挂在取消信号上的监听，避免长连接上越积越多。 */
  readonly cleanup: () => void
}

/**
 * 一条订阅的本地记录。
 *
 * `subscriptionId` 是服务端发的，断线重连后会换一个，所以它是**可变字段**：本地记录才是
 * 订阅的身份，`dispose()` 关掉的始终是这条记录当前对应的那个服务端订阅。
 */
export interface KernelClientEventSubscriptionRecord {
  /** 订阅的事件类型，重连后照这个重新订一遍。 */
  readonly eventType: string
  /** 事件到达时调用的回调。 */
  readonly handler: KernelClientEventHandler
  /** 当前对应的服务端订阅 id；每次重连都会换。 */
  subscriptionId: string
  /** 这条订阅是不是已经被调用方关掉了；关掉之后不再重建、也不再回调。 */
  disposed: boolean
}
