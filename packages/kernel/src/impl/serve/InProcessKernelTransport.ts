import { isUndefined } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { KernelRegistration } from '../../contract/provides'
import type { KernelEventSubscription } from '../../contract/provides'
import type { KernelClientEventHandler, KernelClientTransport } from '../../contract/requires'
import type { KernelServiceHealth } from '../../types/kernel.js'
import type {
  CapabilityCallRequest,
  CapabilityCallResponse,
  CapabilitySessionCloseRequest,
  CapabilitySessionCloseResponse,
  CapabilitySessionOpenRequest,
  CapabilitySessionOpenResponse,
} from '../../utils/wire/capability'
import type { KernelHandshake } from '../../utils/wire/handshake'
import type {
  ModsInstallFromDirectoryRequest,
  ModsInstallFromDirectoryResponse,
  ModsListRequest,
  ModsListResponse,
  ModsSetEnabledRequest,
  ModsSetEnabledResponse,
} from '../../utils/wire/mods'
import { KernelProtocolVersion } from '../../utils/wire/version'

import { CapabilitySessionLedger } from './CapabilitySessionLedger'

/** 进程内传输需要服务端提供的最小面；实例由建这条传输的那一处交进来。 */
export interface InProcessKernelTransportService {
  /** 回握手信息：协议版本、内核版本与当前模块目录。 */
  handshake(): KernelHandshake
  /** 回整机健康；服务面没启动时也答得出（`stopped`）。 */
  health(): Promise<KernelServiceHealth>
  /** 按目录与准入策略判一次「打开会话」：判过了回原请求，判不过回失败信封。本方法不记账。 */
  evaluateCapabilitySessionOpen(
    request: unknown
  ): Promise<
    | { readonly status: 'ok'; readonly request: CapabilitySessionOpenRequest }
    | Extract<CapabilitySessionOpenResponse, { status: 'error' }>
  >
  /** 执行一次能力调用；失败一律折成带码的失败信封回来，不抛。 */
  handleCapabilityCall(request: unknown, signal?: AbortSignal): Promise<CapabilityCallResponse>
  /** 订阅一类内核事件，返回退订句柄；服务面没启动时抛错。 */
  subscribe(type: string, handler: KernelClientEventHandler): KernelRegistration
  /** 列出 mod pack；没接 ModStore 的 Kernel 不提供这个方法。 */
  listMods?(): ReadonlyArray<ModsListResponse['packs'][number]>
  /** 开关一个 mod pack；没接 ModStore 的 Kernel 不提供这个方法。 */
  setModEnabled?(id: string, enabled: boolean): Promise<{ ok: boolean; reloadRequired: boolean }>
  /** 从目录装一个 mod pack；没接 ModStore 的 Kernel 不提供这个方法。 */
  installModFromDirectory?(directory: string): Promise<{
    pack: ModsListResponse['packs'][number]
    reloadRequired: boolean
  }>
}

export type { InProcessKernelTransportService as InProcessKernelService }

/**
 * 与一跳 RPC 语义相同、但不做序列化的本地传输；实例归装它的那个进程内宿主。
 *
 * 能力会话按这条传输实例记账：这一份账本作废，绑过的能力就全部失效。
 */
export interface InProcessKernelTransportApi extends KernelClientTransport {
  /** 回服务端的握手信息。 */
  handshake(): Promise<KernelHandshake>
  /** 回服务端的健康报告。 */
  health(): Promise<KernelServiceHealth>
  /** 打开一条能力会话：先让服务端判准入，判过了才在本地账本里记一条。 */
  openCapabilitySession(
    request: CapabilitySessionOpenRequest
  ): Promise<CapabilitySessionOpenResponse>
  /** 关掉一条能力会话；回它本来在不在账本里。 */
  closeCapabilitySession(
    request: CapabilitySessionCloseRequest
  ): Promise<CapabilitySessionCloseResponse>
  /** 发一次能力调用；没绑在会话上的调用当场回 `CAPABILITY_NOT_GRANTED`，不进服务端。 */
  call(request: CapabilityCallRequest, signal?: AbortSignal): Promise<CapabilityCallResponse>
  /** 列出 mod pack；服务端没接 ModStore 时回空表。 */
  listMods(request: ModsListRequest): Promise<ModsListResponse>
  /** 开关一个 mod pack；服务端没接 ModStore 时回 `ok: false`。 */
  setModEnabled(request: ModsSetEnabledRequest): Promise<ModsSetEnabledResponse>
  /** 从目录装一个 mod pack；服务端没接 ModStore 时抛 `MODS_UNAVAILABLE`。 */
  installModFromDirectory(
    request: ModsInstallFromDirectoryRequest
  ): Promise<ModsInstallFromDirectoryResponse>
  /** 订阅一类内核事件，返回退订句柄。 */
  subscribe(eventType: string, handler: KernelClientEventHandler): Promise<KernelEventSubscription>
  /** 回收这条传输：清掉本连接上的全部会话。 */
  dispose(): void
}

/** 进程内传输：同一进程里把客户端接到服务面上，语义与走 socket 的那一跳一致。 */
export class InProcessKernelTransport implements InProcessKernelTransportApi {
  private readonly sessions = new CapabilitySessionLedger()

  public constructor(private readonly service: InProcessKernelTransportService) {}

  public handshake(): Promise<KernelHandshake> {
    return Promise.resolve(this.service.handshake())
  }

  public health(): Promise<KernelServiceHealth> {
    return this.service.health()
  }

  public async openCapabilitySession(
    request: CapabilitySessionOpenRequest
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
    request: CapabilitySessionCloseRequest
  ): Promise<CapabilitySessionCloseResponse> {
    return Promise.resolve({
      protocolVersion: KernelProtocolVersion,
      closed: this.sessions.close(request.sessionId),
    })
  }

  public async call(
    request: CapabilityCallRequest,
    signal?: AbortSignal
  ): Promise<CapabilityCallResponse> {
    if (!this.sessions.covers(request))
      return {
        protocolVersion: KernelProtocolVersion,
        callId: request.callId,
        status: 'error',
        error: {
          code: 'CAPABILITY_NOT_GRANTED',
          message: `能力 "${request.capabilityId}" 没有绑定在会话 "${request.sessionId}" 上`,
          retryable: false,
          details: null,
        },
      }
    return this.service.handleCapabilityCall(request, signal)
  }

  public async listMods(request: ModsListRequest): Promise<ModsListResponse> {
    void request
    return {
      protocolVersion: KernelProtocolVersion,
      packs: [...(this.service.listMods?.() ?? [])],
    }
  }

  public async setModEnabled(request: ModsSetEnabledRequest): Promise<ModsSetEnabledResponse> {
    const result = await this.service.setModEnabled?.(request.id, request.enabled)
    return {
      protocolVersion: KernelProtocolVersion,
      ok: !!result?.ok,
      reloadRequired: !!result?.reloadRequired,
    }
  }

  public async installModFromDirectory(
    request: ModsInstallFromDirectoryRequest
  ): Promise<ModsInstallFromDirectoryResponse> {
    const result = await this.service.installModFromDirectory?.(request.directory)
    if (isUndefined(result)) {
      throw new AppError('MODS_UNAVAILABLE', '本 Kernel 没有接 ModStore')
    }
    return {
      protocolVersion: KernelProtocolVersion,
      pack: result.pack,
      reloadRequired: result.reloadRequired,
    }
  }

  public subscribe(
    eventType: string,
    handler: KernelClientEventHandler
  ): Promise<KernelEventSubscription> {
    return Promise.resolve(this.service.subscribe(eventType, handler))
  }

  public dispose(): void {
    this.sessions.clear()
  }
}
