import type { KernelServiceHealth } from '@velaros-ai/core/kernel/contracts'
import {
  type KernelHandshake,
  KernelProtocolVersion,
  type ModsInstallFromDirectoryResponse,
  type ModsListResponse,
  type ModsSetEnabledResponse,
} from '@velaros-ai/core/kernel/protocol'

import {
  type CapabilitySession,
  type OpenCapabilitySessionInput,
  openCapabilitySessionOnTransport,
} from './CapabilitySession'
import type {
  KernelClientEventHandler,
  KernelClientTransport,
  KernelEventSubscription,
} from './transport'

/**
 * Product-facing Kernel client.
 *
 * Surface is intentionally narrow:
 * - connection: handshake / health / dispose
 * - capability bind: openCapabilitySession → CapabilitySession.call / dispose
 * - mod management: list / enable / install
 * - events: subscribe
 *
 * Identity session/run registry and raw capability.call are wire/transport
 * concerns — not product APIs on this class.
 */
export class KernelClient {
  public constructor(private readonly transport: KernelClientTransport) {}

  public handshake(): Promise<KernelHandshake> {
    return this.transport.handshake()
  }

  public health(): Promise<KernelServiceHealth> {
    return this.transport.health()
  }

  /**
   * Bind the required capabilities for this consumer scenario.
   *
   * The returned session is the only supported way to invoke capabilities;
   * dispose closes the server-side binding.
   */
  public openCapabilitySession(
    input: OpenCapabilitySessionInput,
  ): Promise<CapabilitySession> {
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
