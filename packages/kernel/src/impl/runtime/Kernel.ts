import { isUndefined } from '@velaros-ai/core'

import { KernelVersionAxes } from '../../contract/constants'
import type { KernelRegistration } from '../../contract/provides'
import type {
  KernelCallableCapabilityService,
  KernelEventHandler,
  KernelModuleDefinition,
} from '../../contract/requires'
import type {
  CapabilityToken,
  KernelCompositionSnapshot,
  KernelModulePermissionRequest,
  KernelModuleSnapshot,
  KernelPermissionDecision,
  KernelStatus,
} from '../../types/kernel.js'
import type { KernelCapabilityCall, KernelLifecycleFailure } from '../../types/runtime'
import { toError } from '../../utils/errors'
import { isKernelCallableCapabilityService } from '../../utils/runtime/callable'

import { KernelCapabilityInvoker } from './KernelCapabilityInvoker'
import { KernelModuleHost, type KernelModuleHostOptions } from './KernelModuleHost'

/** 装配进程内内核时交进来的东西；四个策略件都可选，缺省是安全默认。 */
export interface KernelOptions extends Omit<KernelModuleHostOptions, 'apiVersion'> {
  /** 覆盖模块清单 ABI 版本；只给测试用，产品不要写。 */
  readonly apiVersion?: number
  /** 覆盖内核自报的版本；不写就用常量表里的那一个。 */
  readonly kernelVersion?: string
  /**
   * 生命周期失败怎么处理：`throw` 是库的安全默认；完整界面宿主可以选 `degrade`，
   * 让可选能力起不来时不至于把产品外壳一起废掉。
   */
  readonly lifecycleFailureMode?: 'throw' | 'degrade'
  /** 生命周期失败的回调；`degrade` 模式下这是宿主唯一拿得到失败的地方。 */
  readonly onLifecycleFailure?: (failure: KernelLifecycleFailure) => void
}

/**
 * 进程内内核的门面：一个内核一份模块宿主，装什么能力由宿主选，内核自己不认识任何能力。
 *
 * 它管幂等的生命周期、精确的活动令牌解析、过权限门的可调用调用与事件订阅。
 * 实例由 `createKernel()` 给，产品不自己 new。
 */
export interface KernelApi {
  /** 本内核自报的版本；mod 清单的 `engines.velaros` 按它判。 */
  readonly version: string
  /** 当前生命周期状态。 */
  getStatus(): KernelStatus
  /** 注册一个模块；只能在 `start()` 之前调。 */
  registerModule(definition: KernelModuleDefinition): void
  /** 按顺序注册一批模块。 */
  registerModules(definitions: Iterable<KernelModuleDefinition>): void
  /** 启动：解析依赖图、按序激活并就绪。只真正跑一次；失败按 `lifecycleFailureMode` 抛或降级。 */
  start(): Promise<void>
  /** 回收整个内核；只真正跑一次。 */
  dispose(): Promise<void>
  /** 列出全部模块的只读快照。 */
  listModules(): readonly KernelModuleSnapshot[]
  /** 可序列化的只读组合快照；任何状态下都不抛错，也不提供任何运行时改写入口。 */
  describeComposition(): KernelCompositionSnapshot
  /** 这件能力现在有没有活动提供方。 */
  hasCapability(capabilityId: string): boolean
  /** 取一件能力的服务；没有就返回 undefined。 */
  getCapability<TService extends object>(token: CapabilityToken<TService>): TService | undefined
  /** 按能力 id 取可调用服务；能力不在、或服务不满足可调用约定时返回 null。 */
  resolveCallableCapability(capabilityId: string): Nullable<KernelCallableCapabilityService>
  /**
   * 单独求一次能力权限（不执行调用）。
   *
   * `attribution` 说明这次是「代谁」发起的——只有认证过调用方的宿主才填；不填的话授权会记在
   * 能力提供方名下，之后每个调同一提供方的 mod 都被静默放行。
   */
  requestCapabilityPermission(
    capabilityId: string,
    request: KernelModulePermissionRequest,
    attribution?: { readonly callerModuleId: string }
  ): Promise<KernelPermissionDecision>
  /** 过权限门调一次能力：未知操作在求权限之前就失败，声明的每条权限都在 provider 代码跑之前判完。 */
  invokeCapability(call: KernelCapabilityCall): Promise<unknown>
  /** 以宿主身份订阅一类事件；返回退订函数。 */
  subscribeEvent<TPayload>(type: string, handler: KernelEventHandler<TPayload>): () => void
}

export class Kernel implements KernelApi {
  private readonly host: KernelModuleHost
  private readonly capabilityInvoker: KernelCapabilityInvoker
  private readonly failureMode: 'throw' | 'degrade'
  private startPromise?: Promise<void>
  private disposePromise?: Promise<void>
  private status: KernelStatus = 'idle'

  public readonly version: string

  public constructor(private readonly options: KernelOptions = {}) {
    this.version = options.kernelVersion ?? KernelVersionAxes.kernel
    this.failureMode = options.lifecycleFailureMode ?? 'throw'
    this.host = new KernelModuleHost({
      apiVersion: options.apiVersion ?? KernelVersionAxes.moduleApi,
      permissionBroker: options.permissionBroker,
      stateBackend: options.stateBackend,
      isolationAdapters: options.isolationAdapters,
    })
    this.capabilityInvoker = new KernelCapabilityInvoker(this.host)
  }

  public getStatus(): KernelStatus {
    return this.status
  }

  public registerModule(definition: KernelModuleDefinition): void {
    if (this.status !== 'idle') {
      throw new Error('内核模块必须在启动之前注册')
    }
    this.host.registerModule(definition)
  }

  public registerModules(definitions: Iterable<KernelModuleDefinition>): void {
    if (this.status !== 'idle') {
      throw new Error('内核模块必须在启动之前注册')
    }
    this.host.registerModules(definitions)
  }

  public start(): Promise<void> {
    if (this.status === 'disposed' || this.status === 'disposing')
      return Promise.reject(new Error('已回收的内核不能再启动'))
    this.startPromise ??= this.startOnce()
    return this.startPromise
  }

  public dispose(): Promise<void> {
    this.disposePromise ??= this.disposeOnce()
    return this.disposePromise
  }

  public listModules(): readonly KernelModuleSnapshot[] {
    return this.host.listModules()
  }

  public describeComposition(): KernelCompositionSnapshot {
    return this.host.describeComposition()
  }

  public hasCapability(capabilityId: string): boolean {
    return !isUndefined(this.host.getActiveCapabilityToken(capabilityId))
  }

  public getCapability<TService extends object>(
    token: CapabilityToken<TService>
  ): TService | undefined {
    return this.host.getOptionalService(token)
  }

  public resolveCallableCapability(
    capabilityId: string
  ): Nullable<KernelCallableCapabilityService> {
    const token = this.host.getActiveCapabilityToken(capabilityId)
    if (isUndefined(token)) return null
    const service = this.host.getOptionalService(token)
    return isKernelCallableCapabilityService(service) ? service : null
  }

  public async requestCapabilityPermission(
    capabilityId: string,
    request: KernelModulePermissionRequest,
    attribution?: { readonly callerModuleId: string }
  ): Promise<KernelPermissionDecision> {
    const token = this.host.getActiveCapabilityToken(capabilityId)
    if (isUndefined(token))
      return {
        status: 'denied',
        reason: `能力 "${capabilityId}" 现在没有活动的提供方`,
      }
    return this.host.requestCapabilityPermission(token, request, attribution)
  }

  public async invokeCapability(call: KernelCapabilityCall): Promise<unknown> {
    return this.capabilityInvoker.invoke(call)
  }

  public subscribeEvent<TPayload>(type: string, handler: KernelEventHandler<TPayload>): () => void {
    const registration: KernelRegistration = this.host.subscribe(type, handler)
    return () => registration.dispose()
  }

  private async startOnce(): Promise<void> {
    this.status = 'starting'
    try {
      await this.host.start()
      if (this.status === 'starting') this.status = 'ready'
    } catch (error) {
      if (this.status === 'starting') this.status = 'degraded'
      const normalized = toError(error)
      this.options.onLifecycleFailure?.({ phase: 'start', error: normalized })
      if (this.failureMode === 'throw') throw normalized
    }
  }

  private async disposeOnce(): Promise<void> {
    this.status = 'disposing'
    try {
      await this.host.dispose()
    } catch (error) {
      const normalized = toError(error)
      this.options.onLifecycleFailure?.({ phase: 'dispose', error: normalized })
      if (this.failureMode === 'throw') throw normalized
    } finally {
      this.status = 'disposed'
    }
  }
}

/** 建一个进程内内核（产品装配内核的唯一入口）。 */
export function createKernel(options: KernelOptions = {}): KernelApi {
  return new Kernel(options)
}
