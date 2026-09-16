import {
  isBlank,
  isNotUndefined,
  isUndefined,
  Log,
} from '@velaros-ai/core'

import { KernelCallErrorCodes, KernelErrorCodes } from '../../contract/constants'
import type { KernelRegistration } from '../../contract/provides'
import type { KernelEventHandler } from '../../contract/requires'
import type { KernelClientAccessBroker } from '../../contract/requires'
import type {
  KernelCompositionSnapshot,
  KernelServiceHealth,
  KernelServiceModuleHealth,
} from '../../types/kernel'
import type { KernelModCatalog, KernelServiceStatus } from '../../types/serve'
import { KernelError, notStartedFailure, startFailedFailure } from '../../utils/errors'
import {
  capabilityCallFailure,
  capabilitySessionOpenFailure,
  readCapabilityCallId,
  toKernelCapabilityScope,
  toKernelModuleDescriptor,
  toKernelServiceModuleHealth,
} from '../../utils/serve/service'
import {
  CapabilityCallRequestSchema,
  type CapabilityCallResponse,
  type CapabilityRequireItem,
  type CapabilitySessionOpenFailure,
  type CapabilitySessionOpenRequest,
  CapabilitySessionOpenRequestSchema,
} from '../../utils/wire/capability'
import type { KernelHandshake } from '../../utils/wire/handshake'
import { KernelProtocolVersion } from '../../utils/wire/version'
import { KernelCapabilityInvoker } from '../runtime/KernelCapabilityInvoker'
import type { KernelModuleHostApi } from '../runtime/KernelModuleHost'

import { DenyAllKernelClientAccessBroker } from './DenyAllKernelClientAccessBroker'
const log = Log.tag('KernelService')

/** 建一个服务面要交进来的东西：宿主、版本号，以及两个可选的注入点。 */
export interface KernelServiceOptions {
  /** 这个服务面对外代理的模块宿主。 */
  readonly host: KernelModuleHostApi
  /** 握手里回显的内核版本号；空串直接抛错，不让一个没有身份的 Kernel 起来。 */
  readonly kernelVersion: string
  /** 谁来判 `capability.session.open`；不给就是 deny-all。 */
  readonly clientAccessBroker?: KernelClientAccessBroker
  /** `mods.*` 一族 RPC 接到哪个 ModStore；不给就是「本 Kernel 没有接 ModStore」。 */
  readonly modCatalog?: KernelModCatalog
}

/**
 * 与产品无关的内核服务面；实例归装配这个 Kernel 进程的那一处。
 *
 * 产品客户端只看得到协议对象与可调用能力；宿主内部、具体模块实现与抛出来的错误都留在这道
 * 边界之内。
 */
export interface KernelServiceApi {
  /** 当前的生命周期状态。 */
  getStatus(): KernelServiceStatus
  /** 启动宿主；已启动直接返回，已回收或启动失败过的一律拒绝（失败是终态）。 */
  start(): Promise<void>
  /** 回收宿主；重复调用返回同一个 promise。 */
  dispose(): Promise<void>
  /** 回握手：协议版本、内核版本与当前模块目录。 */
  handshake(): KernelHandshake
  /** 回组合快照，本机诊断与 CLI 可直接 JSON 序列化；远端 wire 仍只走版本化协议。 */
  describeComposition(): KernelCompositionSnapshot
  /** 回整机健康；没启动时回 `stopped`，任一模块降级则整机 `degraded`。 */
  health(): Promise<KernelServiceHealth>
  /**
   * 按目录与准入策略判一次「打开能力会话」。
   *
   * 判过了回原请求，判不过回失败信封（请求不合协议、Kernel 没启动、能力没装载、绑定被拒、
   * 策略判不出来）。**本方法不记账**——记账归 RPC 或进程内连接的会话账本。
   */
  evaluateCapabilitySessionOpen(
    input: unknown,
  ): Promise<
    | { readonly status: 'ok'; readonly request: CapabilitySessionOpenRequest }
    | CapabilitySessionOpenFailure
  >
  /** 执行一次能力调用；任何失败都折成带码的失败信封回来，不抛。 */
  handleCapabilityCall(
    input: unknown,
    signal?: AbortSignal,
  ): Promise<CapabilityCallResponse>
  /** 订阅一类内核事件，返回退订句柄；没启动或事件类型为空时抛错。 */
  subscribe<TPayload>(
    type: string,
    handler: KernelEventHandler<TPayload>,
  ): KernelRegistration
  /** 列出 mod pack；没启动或没接 ModStore 时抛带码的错误。 */
  listMods(): ReturnType<KernelModCatalog['list']>
  /** 开关一个 mod pack；没启动或没接 ModStore 时抛带码的错误。 */
  setModEnabled(
    id: string,
    enabled: boolean,
  ): ReturnType<KernelModCatalog['setEnabled']>
  /** 从目录装一个 mod pack；失败原因随带码的错误回到调用方，不只进日志。 */
  installModFromDirectory(
    directory: string,
  ): ReturnType<KernelModCatalog['installFromDirectory']>
}

/** 与产品无关的内核服务面。 */
export class KernelService implements KernelServiceApi {
  private status: KernelServiceStatus = 'idle'
  private startFailure?: unknown
  private startPromise?: Promise<void>
  private disposePromise?: Promise<void>
  private readonly clientAccessBroker: KernelClientAccessBroker
  private readonly capabilityInvoker: KernelCapabilityInvoker

  public constructor(private readonly options: KernelServiceOptions) {
    if (isBlank(options.kernelVersion.trim())) {
      throw new Error('内核版本号不能为空')
    }
    this.clientAccessBroker = options.clientAccessBroker
      ?? new DenyAllKernelClientAccessBroker()
    this.capabilityInvoker = new KernelCapabilityInvoker(options.host)
  }

  public getStatus(): KernelServiceStatus {
    return this.status
  }

  public start(): Promise<void> {
    switch (this.status) {
      case 'disposed':
        return Promise.reject(new Error('已回收的 Kernel service 不能再启动'))
      case 'failed':
        return Promise.reject(
          startFailedFailure(this.startFailure),
        )
      case 'started':
        return Promise.resolve()
      case 'idle':
        break
    }
    this.startPromise ??= this.startOnce()
    return this.startPromise
  }

  private async startOnce(): Promise<void> {
    try {
      await this.options.host.start()
    } catch (error) {
      // 启动失败是终态：同一个 host 不会因为再调一次 start() 就变好。
      if (this.status === 'idle') {
        this.status = 'failed'
        this.startFailure = error
      }
      throw error
    }
    if (this.status === 'idle') this.status = 'started'
  }

  public dispose(): Promise<void> {
    this.disposePromise ??= this.disposeOnce()
    return this.disposePromise
  }

  private async disposeOnce(): Promise<void> {
    if (this.status === 'disposed') return
    this.status = 'disposed'
    await this.options.host.dispose()
  }

  public handshake(): KernelHandshake {
    return {
      protocolVersion: KernelProtocolVersion,
      kernelVersion: this.options.kernelVersion,
      modules: this.options.host.listModules().map(toKernelModuleDescriptor),
    }
  }

  public describeComposition(): KernelCompositionSnapshot {
    return this.options.host.describeComposition()
  }

  public async health(): Promise<KernelServiceHealth> {
    if (this.status !== 'started')
      return { status: 'stopped', modules: this.moduleHealthSnapshots() }

    const snapshots = await this.options.host.checkHealth()
    const modules = snapshots.map(toKernelServiceModuleHealth)
    const degraded = modules.some(
      (module) =>
        module.status !== 'ready'
        || module.health.status === 'degraded'
        || module.health.status === 'unhealthy',
    )
    return {
      status: degraded ? 'degraded' : 'healthy',
      modules,
    }
  }

  public async evaluateCapabilitySessionOpen(
    input: unknown,
  ): Promise<
    | { readonly status: 'ok'; readonly request: CapabilitySessionOpenRequest }
    | CapabilitySessionOpenFailure
  > {
    const parsed = CapabilitySessionOpenRequestSchema.safeParse(input)
    if (!parsed.success) return capabilitySessionOpenFailure(
        'INVALID_REQUEST',
        '打开能力会话的请求不符合 Kernel 协议 v2',
      )

    const request = parsed.data
    if (this.status !== 'started') return capabilitySessionOpenFailure(
        'KERNEL_NOT_STARTED',
        'Kernel 服务面还没启动',
        this.status === 'idle',
      )

    for (const item of request.requires) {
      const evaluation = await this.evaluateRequireItem(item)
      if (isNotUndefined(evaluation)) return evaluation
    }

    return { status: 'ok', request }
  }

  private async evaluateRequireItem(
    item: CapabilityRequireItem,
  ): Promise<CapabilitySessionOpenFailure | undefined> {
    if (isUndefined(this.findCapabilityById(item.capabilityId))) return capabilitySessionOpenFailure(
        'CAPABILITY_NOT_AVAILABLE',
        `能力 "${item.capabilityId}" 当前没有装载`,
      )

    try {
      const decision = await this.clientAccessBroker.requestBind({
        capabilityId: item.capabilityId,
        operations: item.operations,
        scope: item.scope,
      })
      if (decision.status === 'denied') return capabilitySessionOpenFailure(
          'CAPABILITY_BIND_DENIED',
          decision.reason,
        )
    } catch (error) {
      log.warn('能力绑定策略判定失败', { capabilityId: item.capabilityId, error })
      return capabilitySessionOpenFailure(
        'CAPABILITY_BIND_FAILED',
        '判不出这次能力绑定的结果',
        true,
      )
    }
    return undefined
  }

  public async handleCapabilityCall(
    input: unknown,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<CapabilityCallResponse> {
    const parsed = CapabilityCallRequestSchema.safeParse(input)
    if (!parsed.success)
      return capabilityCallFailure(
        readCapabilityCallId(input),
        'INVALID_REQUEST',
        '能力调用请求不符合 Kernel 协议 v2',
      )

    const request = parsed.data
    if (this.status !== 'started')
      return capabilityCallFailure(
        request.callId,
        'KERNEL_NOT_STARTED',
        'Kernel 服务面还没启动',
        this.status === 'idle',
      )

    try {
      const output = await this.capabilityInvoker.invoke({
        capabilityId: request.capabilityId,
        operation: request.operation,
        scope: toKernelCapabilityScope(request.scope),
        input: request.input,
        signal,
      })
      return {
        protocolVersion: KernelProtocolVersion,
        callId: request.callId,
        status: 'ok',
        output,
      }
    } catch (error) {
      // 调用路径抛的都是带码的 KernelError：wire 失败信封原样用同一个码，进程内与 serve
      // 两条路径因此对同一件事给出同一个判断依据。
      if (error instanceof KernelError) {
        switch (error.code) {
          case KernelCallErrorCodes.capabilityNotFound:
            return capabilityCallFailure(
              request.callId,
              KernelCallErrorCodes.capabilityNotFound,
              `能力 "${request.capabilityId}" 当前不可用`,
            )
          case KernelCallErrorCodes.capabilityNotCallable:
            return capabilityCallFailure(
              request.callId,
              KernelCallErrorCodes.capabilityNotCallable,
              `能力 "${request.capabilityId}" 没有可调用接口`,
            )
          case KernelCallErrorCodes.operationNotFound:
            return capabilityCallFailure(
              request.callId,
              KernelCallErrorCodes.operationNotFound,
              `能力 "${request.capabilityId}" 上没有操作 "${request.operation}"`,
            )
          case KernelCallErrorCodes.operationMetadataFailed:
            log.warn('取不到能力操作的元数据', {
              capabilityId: request.capabilityId,
              error,
              operation: request.operation,
            })
            return capabilityCallFailure(
              request.callId,
              KernelCallErrorCodes.operationMetadataFailed,
              '取不到能力操作的元数据',
            )
          // 进程内路径的错误消息就是 broker 给的原因；serve 路径不能把它丢掉，否则同一次拒绝
          // 在两条路径上说的不是一回事，模型也拿不到「为什么被拒」。
          case KernelCallErrorCodes.permissionDenied:
            return capabilityCallFailure(
              request.callId,
              KernelCallErrorCodes.permissionDenied,
              `能力调用被权限策略拒绝：${error.message}`,
              false,
              {
                permission: error.details.permission,
                reason: error.details.reason ?? error.message,
              },
            )
          case KernelCallErrorCodes.permissionCheckFailed:
            log.warn('判不出能力调用的授权结果', {
              capabilityId: request.capabilityId,
              error,
              operation: request.operation,
            })
            return capabilityCallFailure(
              request.callId,
              KernelCallErrorCodes.permissionCheckFailed,
              '判不出能力调用的授权结果',
              true,
            )
          default:
            break
        }
      }
      log.warn('能力调用失败', {
        aborted: signal.aborted,
        capabilityId: request.capabilityId,
        error,
        operation: request.operation,
      })
      return capabilityCallFailure(
        request.callId,
        signal.aborted ? 'CALL_ABORTED' : 'CAPABILITY_CALL_FAILED',
        signal.aborted
          ? '能力调用被中止'
          : '能力调用失败',
        !signal.aborted,
      )
    }
  }

  private findCapabilityById(capabilityId: string):
    | { readonly token: { readonly id: string; readonly version: string } }
    | undefined {
    const token = this.options.host.getActiveCapabilityToken(capabilityId)
    return isUndefined(token) ? undefined : { token }
  }

  private moduleHealthSnapshots(): readonly KernelServiceModuleHealth[] {
    return this.options.host.listModules().map(toKernelServiceModuleHealth)
  }

  public subscribe<TPayload>(
    type: string,
    handler: KernelEventHandler<TPayload>,
  ): KernelRegistration {
    this.assertStarted()
    if (isBlank(type.trim())) {
      throw new Error('内核事件类型不能为空')
    }
    return this.options.host.subscribe(type, handler)
  }

  public listMods(): ReturnType<KernelModCatalog['list']> {
    this.assertStarted()
    return this.requireModCatalog().list()
  }

  public setModEnabled(
    id: string,
    enabled: boolean,
  ): ReturnType<KernelModCatalog['setEnabled']> {
    this.assertStarted()
    return this.requireModCatalog().setEnabled(id, enabled)
  }

  /**
   * 从目录安装一个 mod pack。
   *
   * 失败原因（目录不存在、`velaros.mod.json` 不合法、入口导不出模块定义……）必须随错误一起
   * 回到调用方：原来它是一个无码的普通错误，RPC 那侧统一投影成「INTERNAL_ERROR，可重试」，
   * 真正的原因只进了守护进程日志。
   */
  public async installModFromDirectory(
    directory: string,
  ): ReturnType<KernelModCatalog['installFromDirectory']> {
    this.assertStarted()
    try {
      return await this.requireModCatalog().installFromDirectory(directory)
    } catch (error) {
      if (error instanceof KernelError) throw error
      const reason = error instanceof Error ? error.message : String(error)
      log.warn('mod pack 安装失败', { directory, error })
      throw new KernelError(
        KernelErrorCodes.modInstallFailed,
        `从目录安装 mod pack 失败：${reason}`,
        { directory, reason },
        { cause: error },
      )
    }
  }

  private requireModCatalog(): KernelModCatalog {
    if (isUndefined(this.options.modCatalog)) {
      throw new KernelError(
        KernelErrorCodes.modsUnavailable,
        '本 Kernel 没有接 ModStore，mods.* 不可用',
      )
    }
    return this.options.modCatalog
  }

  private assertStarted(): void {
    if (this.status === 'started') return
    throw notStartedFailure()
  }
}
