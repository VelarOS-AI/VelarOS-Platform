import type {
  CapabilityCallRequest,
  CapabilityCallResponse,
  CapabilitySessionCloseRequest,
  CapabilitySessionCloseResponse,
  CapabilitySessionOpenRequest,
  CapabilitySessionOpenResponse,
} from '../utils/wire/capability'
import type { KernelHandshake } from '../utils/wire/handshake'
import type {
  ModsInstallFromDirectoryRequest,
  ModsInstallFromDirectoryResponse,
  ModsListRequest,
  ModsListResponse,
  ModsSetEnabledRequest,
  ModsSetEnabledResponse,
} from '../utils/wire/mods'

import type { KernelEvent } from './abi-events'
import type { KernelServiceHealth } from './service-health'

export interface KernelEventSubscription {
  dispose(): void | Promise<void>
}

export type KernelClientEventHandler = (
  event: KernelEvent,
) => void | Promise<void>

/**
 * Full wire transport contract for Kernel RPC implementations.
 *
 * This is the **transport-implementor** surface (Unix socket, in-process adapter,
 * future authenticated remote). Products should use {@link KernelClient} instead
 * of calling these methods directly — especially the capability wire.
 */
export interface KernelClientTransport {
  // --- Connection ---
  handshake(): Promise<KernelHandshake>
  health(): Promise<KernelServiceHealth>

  // --- Capability wire (RPC: capability.session.open/close, capability.call) ---
  // Product path: KernelClient.openCapabilitySession → CapabilitySession.call/dispose
  openCapabilitySession(
    request: CapabilitySessionOpenRequest,
  ): Promise<CapabilitySessionOpenResponse>
  closeCapabilitySession(
    request: CapabilitySessionCloseRequest,
  ): Promise<CapabilitySessionCloseResponse>
  call(
    request: CapabilityCallRequest,
    signal?: AbortSignal,
  ): Promise<CapabilityCallResponse>

  // --- ModStore wire (RPC: mods.*) ---
  listMods(request: ModsListRequest): Promise<ModsListResponse>
  setModEnabled(request: ModsSetEnabledRequest): Promise<ModsSetEnabledResponse>
  installModFromDirectory(
    request: ModsInstallFromDirectoryRequest,
  ): Promise<ModsInstallFromDirectoryResponse>

  // --- Events ---
  subscribe(
    eventType: string,
    handler: KernelClientEventHandler,
  ): Promise<KernelEventSubscription>

  dispose(): void | Promise<void>
}
