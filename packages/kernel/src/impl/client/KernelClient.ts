import type { KernelEventSubscription } from '../../contract/provides'
import type { KernelClientEventHandler, KernelClientTransport } from '../../contract/requires'
import type { OpenCapabilitySessionInput } from '../../types/client'
import type { KernelServiceHealth } from '../../types/kernel.js'
import type {
  KernelHandshake,
  ModsInstallFromDirectoryResponse,
  ModsListResponse,
  ModsSetEnabledResponse,
} from '../../types/wire'
import { KernelProtocolVersion } from '../../utils/wire/version'

import {
  type CapabilitySessionApi,
  openCapabilitySessionOnTransport,
} from './CapabilitySession'

/**
 * 产品面的内核客户端：一台内核连接上，产品真正要用的那几件事。
 *
 * 实例由产品自己拿一条传输构造（或由 `kernelDaemons.connect` 交出来）。面故意收得很窄：连接
 * （握手、健康、回收）、绑能力（开会话之后经会话调用）、管 mod（列出、启停、装）、订事件。
 * 身份会话/运行登记与裸的 `capability.call` 是 wire 与传输的事，不是产品面。
 */
export interface KernelClientApi {
  /** 握手：拿到对端的协议版本、内核版本与能力清单；连不上时抛 KernelClientError。 */
  handshake(): Promise<KernelHandshake>
  /** 取内核服务的健康快照（每个模块的状态）；连不上时抛 KernelClientError。 */
  health(): Promise<KernelServiceHealth>
  /** 按本场景要用的能力绑一条会话；调能力只有这一条路，`dispose` 关掉服务端的绑定。被拒时抛 KernelClientError，码原样来自服务端。 */
  openCapabilitySession(
    input: OpenCapabilitySessionInput,
  ): Promise<CapabilitySessionApi>
  /** 列出对端已知的全部 mod 与它们的启停状态。 */
  listMods(): Promise<ModsListResponse>
  /** 启用或停用一个 mod；对端不认这个 id 时回应是失败信封，不抛。 */
  setModEnabled(id: string, enabled: boolean): Promise<ModsSetEnabledResponse>
  /** 从一个本机目录安装 mod；目录不合法时回应是失败信封，不抛。 */
  installModFromDirectory(
    directory: string,
  ): Promise<ModsInstallFromDirectoryResponse>
  /** 订阅一类内核事件，返回可关闭的句柄；断线重连后订阅由传输自己补回来。 */
  subscribe(
    eventType: string,
    handler: KernelClientEventHandler,
  ): Promise<KernelEventSubscription>
  /** 关掉这条客户端连接：在途请求一律以 TRANSPORT_CLOSED 落空，订阅全部作废。 */
  dispose(): void | Promise<void>
}

export class KernelClient implements KernelClientApi {
  public constructor(private readonly transport: KernelClientTransport) {}

  public handshake(): Promise<KernelHandshake> {
    return this.transport.handshake()
  }

  public health(): Promise<KernelServiceHealth> {
    return this.transport.health()
  }

  public openCapabilitySession(
    input: OpenCapabilitySessionInput,
  ): Promise<CapabilitySessionApi> {
    return openCapabilitySessionOnTransport(this.transport, input)
  }

  public listMods(): Promise<ModsListResponse> {
    return this.transport.listMods({ protocolVersion: KernelProtocolVersion })
  }

  public setModEnabled(
    id: string,
    enabled: boolean,
  ): Promise<ModsSetEnabledResponse> {
    return this.transport.setModEnabled({
      protocolVersion: KernelProtocolVersion,
      id,
      enabled,
    })
  }

  public installModFromDirectory(
    directory: string,
  ): Promise<ModsInstallFromDirectoryResponse> {
    return this.transport.installModFromDirectory({
      protocolVersion: KernelProtocolVersion,
      directory,
    })
  }

  public subscribe(
    eventType: string,
    handler: KernelClientEventHandler,
  ): Promise<KernelEventSubscription> {
    return this.transport.subscribe(eventType, handler)
  }

  public dispose(): void | Promise<void> {
    return this.transport.dispose()
  }
}
