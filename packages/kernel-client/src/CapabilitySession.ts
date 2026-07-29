import {
  type CapabilityCallRequest,
  type CapabilityCallResponse,
  type CapabilityRequireItem,
  type CapabilitySessionCloseResponse,
  type CapabilitySessionOpenRequest,
  type CapabilitySessionOpenResponse,
  KernelProtocolVersion,
} from './protocol'
import type { KernelClientTransport } from './transport'

export interface OpenCapabilitySessionInput {
  readonly requires: readonly CapabilityRequireItem[]
}

/**
 * Bound capability session for one consumer scenario.
 *
 * Calls must go through this session so the Kernel can enforce the requires
 * set declared at open time. Dispose closes the server-side binding.
 */
export class CapabilitySession {
  private disposed = false

  public constructor(
    private readonly transport: KernelClientTransport,
    public readonly sessionId: string,
    public readonly requires: readonly CapabilityRequireItem[],
  ) {}

  public call(
    request: Omit<CapabilityCallRequest, 'sessionId'>,
    signal?: AbortSignal,
  ): Promise<CapabilityCallResponse> {
    this.assertOpen()
    return this.transport.call({
      ...request,
      sessionId: this.sessionId,
    }, signal)
  }

  public async dispose(): Promise<CapabilitySessionCloseResponse> {
    if (this.disposed) return {
        protocolVersion: KernelProtocolVersion,
        closed: false,
      }
    this.disposed = true
    return this.transport.closeCapabilitySession({
      protocolVersion: KernelProtocolVersion,
      sessionId: this.sessionId,
    })
  }

  private assertOpen(): void {
    if (this.disposed) {
      throw new Error(`Capability session "${this.sessionId}" is disposed`)
    }
  }
}

export async function openCapabilitySessionOnTransport(
  transport: KernelClientTransport,
  input: OpenCapabilitySessionInput,
): Promise<CapabilitySession> {
  const response: CapabilitySessionOpenResponse =
    await transport.openCapabilitySession({
      protocolVersion: KernelProtocolVersion,
      requires: [...input.requires],
    } satisfies CapabilitySessionOpenRequest)
  if (response.status === 'error') {
    throw Object.assign(
      new Error(response.error.message),
      {
        name: 'CapabilitySessionOpenError',
        code: response.error.code,
        retryable: response.error.retryable,
        details: response.error.details,
        response,
      },
    )
  }
  return new CapabilitySession(
    transport,
    response.sessionId,
    response.requires,
  )
}
