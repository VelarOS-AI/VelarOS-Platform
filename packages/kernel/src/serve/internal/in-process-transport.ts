import { isUndefined } from '@velaros-ai/core'
import type {
  KernelClientEventHandler,
  KernelClientTransport,
  KernelEventSubscription,
} from '@velaros-ai/kernel/client'
import type {
  KernelServiceHealth,
  OpenKernelSessionInput,
  StartKernelRunInput,
} from '@velaros-ai/kernel/contracts'
import type { KernelRegistration } from '@velaros-ai/kernel/contracts/abi'
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
} from '@velaros-ai/kernel/contracts/protocol'
import { KernelProtocolVersion } from '@velaros-ai/kernel/contracts/protocol'
import { CapabilitySessionLedger } from '@velaros-ai/kernel/runtime'

/**
 * Minimal server surface the in-process transport needs.
 */
export interface InProcessKernelService {
  handshake(): KernelHandshake
  health(): Promise<KernelServiceHealth>
  evaluateCapabilitySessionOpen(request: unknown): Promise<
    | { readonly status: 'ok'; readonly request: CapabilitySessionOpenRequest }
    | Extract<CapabilitySessionOpenResponse, { status: 'error' }>
  >
  handleCapabilityCall(
    request: unknown,
    signal?: AbortSignal,
  ): Promise<CapabilityCallResponse>
  openSession(input: OpenKernelSessionInput): KernelSessionIdentity
  getSession(sessionId: string): KernelSessionIdentity | undefined
  listSessions(): readonly KernelSessionIdentity[]
  closeSession(sessionId: string): boolean
  startRun(input: StartKernelRunInput): KernelRunIdentity
  getRun(runId: string): KernelRunIdentity | undefined
  listRuns(): readonly KernelRunIdentity[]
  finishRun(runId: string): boolean
  subscribe(type: string, handler: KernelClientEventHandler): KernelRegistration
  listMods?(): ReadonlyArray<ModsListResponse['packs'][number]>
  setModEnabled?(
    id: string,
    enabled: boolean,
  ): Promise<{ ok: boolean; reloadRequired: boolean }>
  installModFromDirectory?(
    directory: string,
  ): Promise<{
    pack: ModsListResponse['packs'][number]
    reloadRequired: boolean
  }>
}

/**
 * Local transport with the same serialization-free semantics as an RPC hop.
 *
 * Capability sessions are connection-scoped to this transport instance.
 */
export class InProcessKernelTransport implements KernelClientTransport {
  private readonly sessions = new CapabilitySessionLedger()

  public constructor(private readonly service: InProcessKernelService) {}

  public handshake(): Promise<KernelHandshake> {
    return Promise.resolve(this.service.handshake())
  }

  public health(): Promise<KernelServiceHealth> {
    return this.service.health()
  }

  public async openCapabilitySession(
    request: CapabilitySessionOpenRequest,
  ): Promise<CapabilitySessionOpenResponse> {
    const evaluated = await this.service.evaluateCapabilitySessionOpen(request)
    if (evaluated.status === 'error') return evaluated
    const session = this.sessions.open(evaluated.request.requires)
    return {
      protocolVersion: KernelProtocolVersion,
      status: 'ok',
      sessionId: session.sessionId,
      requires: evaluated.request.requires,
    }
  }

  public closeCapabilitySession(
    request: CapabilitySessionCloseRequest,
  ): Promise<CapabilitySessionCloseResponse> {
    return Promise.resolve({
      protocolVersion: KernelProtocolVersion,
      closed: this.sessions.close(request.sessionId),
    })
  }

  public async call(
    request: CapabilityCallRequest,
    signal?: AbortSignal,
  ): Promise<CapabilityCallResponse> {
    if (!this.sessions.covers(request)) return {
        protocolVersion: KernelProtocolVersion,
        callId: request.callId,
        status: 'error',
        error: {
          code: 'CAPABILITY_NOT_GRANTED',
          message:
            `Capability "${request.capabilityId}" is not bound on session "${request.sessionId}"`,
          retryable: false,
          details: null,
        },
      }
    return this.service.handleCapabilityCall(request, signal)
  }

  public openSession(
    input: OpenKernelSessionInput,
  ): Promise<KernelSessionIdentity> {
    return Promise.resolve(this.service.openSession(input))
  }

  public getSession(
    sessionId: string,
  ): Promise<KernelSessionIdentity | undefined> {
    return Promise.resolve(this.service.getSession(sessionId))
  }

  public listSessions(): Promise<readonly KernelSessionIdentity[]> {
    return Promise.resolve(this.service.listSessions())
  }

  public closeSession(sessionId: string): Promise<boolean> {
    return Promise.resolve(this.service.closeSession(sessionId))
  }

  public startRun(input: StartKernelRunInput): Promise<KernelRunIdentity> {
    return Promise.resolve(this.service.startRun(input))
  }

  public getRun(runId: string): Promise<KernelRunIdentity | undefined> {
    return Promise.resolve(this.service.getRun(runId))
  }

  public listRuns(): Promise<readonly KernelRunIdentity[]> {
    return Promise.resolve(this.service.listRuns())
  }

  public finishRun(runId: string): Promise<boolean> {
    return Promise.resolve(this.service.finishRun(runId))
  }

  public async listMods(request: ModsListRequest): Promise<ModsListResponse> {
    void request
    return {
      protocolVersion: KernelProtocolVersion,
      packs: [...(this.service.listMods?.() ?? [])],
    }
  }

  public async setModEnabled(
    request: ModsSetEnabledRequest,
  ): Promise<ModsSetEnabledResponse> {
    const result = await this.service.setModEnabled?.(
      request.id,
      request.enabled,
    )
    return {
      protocolVersion: KernelProtocolVersion,
      ok: !!result?.ok,
      reloadRequired: !!result?.reloadRequired,
    }
  }

  public async installModFromDirectory(
    request: ModsInstallFromDirectoryRequest,
  ): Promise<ModsInstallFromDirectoryResponse> {
    const result = await this.service.installModFromDirectory?.(request.directory)
    if (isUndefined(result)) {
      throw Object.assign(new Error('Mod catalog is not available'), {
        code: 'MODS_UNAVAILABLE',
      })
    }
    return {
      protocolVersion: KernelProtocolVersion,
      pack: result.pack,
      reloadRequired: result.reloadRequired,
    }
  }

  public subscribe(
    eventType: string,
    handler: KernelClientEventHandler,
  ): Promise<KernelEventSubscription> {
    return Promise.resolve(this.service.subscribe(eventType, handler))
  }

  public dispose(): void {
    this.sessions.clear()
  }
}
