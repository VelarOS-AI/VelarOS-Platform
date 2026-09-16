import type { KernelClientTransport } from '../../contract/requires'
import type { OpenCapabilitySessionInput } from '../../types/client'
import type {
  CapabilityCallRequest,
  CapabilityCallResponse,
  CapabilityRequireItem,
  CapabilitySessionCloseResponse,
  CapabilitySessionOpenRequest,
  CapabilitySessionOpenResponse,
} from '../../types/wire'
import { KernelClientError } from '../../utils/errors'
import { KernelProtocolVersion } from '../../utils/wire/version'

/**
 * 一条绑好的能力会话，对应消费方的一个使用场景。
 *
 * 实例由 `KernelClient.openCapabilitySession` 交出来，一条会话对应服务端的一次绑定：调用必须
 * 走会话，内核才能按开会话时声明的 requires 集合逐条把关。
 */
export interface CapabilitySessionApi {
  /** 服务端给这条会话发的 id，调用时随每一帧带上去。 */
  readonly sessionId: string
  /** 开会话时实际绑上的能力清单；只有这些能力调得动。 */
  readonly requires: readonly CapabilityRequireItem[]
  /** 在这条会话上调一次能力；`signal` 中止时以 AbortError 结束。会话已经关掉时直接抛错，不再上线。 */
  call(
    request: Omit<CapabilityCallRequest, 'sessionId'>,
    signal?: AbortSignal,
  ): Promise<CapabilityCallResponse>
  /** 关掉服务端的绑定；重复关是空操作，回应里的 `closed` 会是 false。 */
  dispose(): Promise<CapabilitySessionCloseResponse>
}

export class CapabilitySession implements CapabilitySessionApi {
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
      throw new Error(`能力会话 "${this.sessionId}" 已经关掉了，重新开一条再调`)
    }
  }
}

/**
 * 在一条传输上开出能力会话：把 requires 集合报上去，拿回服务端绑定的那条会话。
 *
 * 服务端拒绝时抛 KernelClientError，码原样来自失败信封（拿不到能力一般是 CAPABILITY_NOT_GRANTED）。
 */
export async function openCapabilitySessionOnTransport(
  transport: KernelClientTransport,
  input: OpenCapabilitySessionInput,
): Promise<CapabilitySessionApi> {
  const response: CapabilitySessionOpenResponse =
    await transport.openCapabilitySession({
      protocolVersion: KernelProtocolVersion,
      requires: [...input.requires],
    } satisfies CapabilitySessionOpenRequest)
  if (response.status === 'error') {
    throw new KernelClientError({
      code: response.error.code,
      message: response.error.message,
      retryable: response.error.retryable,
      rpcError: response.error,
    })
  }
  return new CapabilitySession(
    transport,
    response.sessionId,
    response.requires,
  )
}
