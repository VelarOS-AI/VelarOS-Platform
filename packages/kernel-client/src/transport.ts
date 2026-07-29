import type { KernelEvent } from '@velaros-ai/kernel-sdk'

import type { KernelServiceHealth } from './contracts/health'
import type {
  OpenKernelSessionInput,
  StartKernelRunInput,
} from './contracts/identity-inputs'
import type {
  CapabilityCallRequest,
  CapabilityCallResponse,
  CapabilitySessionCloseRequest,
  CapabilitySessionCloseResponse,
  CapabilitySessionOpenRequest,
  CapabilitySessionOpenResponse,
  KernelHandshake,
  KernelRunIdentity,
  KernelSessionIdentity,
  ModsInstallFromDirectoryRequest,
  ModsInstallFromDirectoryResponse,
  ModsListRequest,
  ModsListResponse,
  ModsSetEnabledRequest,
  ModsSetEnabledResponse,
} from './protocol'

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
 * of calling these methods directly — especially capability and identity wires.
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

  // --- Identity wire (RPC: session.*, run.*) — NOT a product KernelClient API ---
  // Kernel-internal ownership registry only; no capability grants.
  openSession(input: OpenKernelSessionInput): Promise<KernelSessionIdentity>
  getSession(sessionId: string): Promise<KernelSessionIdentity | undefined>
  listSessions(): Promise<readonly KernelSessionIdentity[]>
  closeSession(sessionId: string): Promise<boolean>
  startRun(input: StartKernelRunInput): Promise<KernelRunIdentity>
  getRun(runId: string): Promise<KernelRunIdentity | undefined>
  listRuns(): Promise<readonly KernelRunIdentity[]>
  finishRun(runId: string): Promise<boolean>

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
