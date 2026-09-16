import { isEmpty, isTrue, isUndefined, Log } from '@velaros-ai/core'

import { KernelErrorCodes } from '../../contract/constants'
import type { KernelModuleActivateContext, KernelRegistration, KernelServiceHandle } from '../../contract/provides'
import type { KernelEventHandler } from '../../contract/requires'
import type { KernelModuleDefinition, KernelModuleLifecycle } from '../../contract/requires'
import type { KernelPermissionBroker } from '../../contract/requires'
import type { KernelModuleIsolationAdapter } from '../../contract/requires'
import type { KernelStateBackend } from '../../contract/requires'
import type { ExternalKernelModuleIsolation } from '../../types/kernel'
import type {
  CapabilityToken,
  KernelCompositionSnapshot,
  KernelModuleHealth,
  KernelModulePermissionRequest,
  KernelModuleSnapshot,
  KernelPermissionDecision,
} from '../../types/kernel.js'
import type { ModuleRecord } from '../../types/runtime'
import {
  KernelError,
  lifecycleFailure,
  startupFailure,
  toError,
} from '../../utils/errors'
import { cloneManifest } from '../../utils/runtime/manifest'
import {
  type KernelModulePlan,
  resolveKernelModulePlan,
  validateManifest,
} from '../../utils/runtime/module-plan'
import {
  assertModuleContextActive,
  createModuleRecord,
  disposeModuleLifecycle,
  failModuleRecord,
  HealthyModuleHealth,
  toModuleSnapshot,
  UnknownModuleHealth,
} from '../../utils/runtime/module-record'

import { DenyAllKernelPermissionBroker } from './DenyAllKernelPermissionBroker'
import { InMemoryKernelStateBackend } from './InMemoryKernelStateBackend'
import { KernelEventHub } from './KernelEventHub'
import {
  KernelServiceStore,
} from './KernelServiceStore'
import { createNamespacedStateStore } from './NamespacedKernelStateStore'
import { createScopedPermissionBroker } from './ScopedKernelPermissionBroker'
import { ScopedKernelServiceResolver } from './ScopedKernelServiceResolver'

const log = Log.tag('KernelModuleHost')

/** 装配宿主时交进来的东西：ABI 版本必填，三个策略件缺省用包内的安全默认。 */
export interface KernelModuleHostOptions {
  /** 本宿主认的模块清单 ABI 版本；清单上对不上的模块一律拒绝注册。 */
  readonly apiVersion: number
  /** 权限裁决；不给就是全拒（`DenyAllKernelPermissionBroker`）。 */
  readonly permissionBroker?: KernelPermissionBroker
  /** 模块状态的持久化后端；不给就用进程内内存。 */
  readonly stateBackend?: KernelStateBackend
  /** 非进程内模块的激活适配器，按隔离形态各一个。 */
  readonly isolationAdapters?: readonly KernelModuleIsolationAdapter[]
}

/**
 * 内核模块的组合根：只管顺序、生命周期、登记归属与回滚，不认识图里流过的任何能力。
 *
 * 实例由 `Kernel` 与守护进程装配各持一份，别处不自己 new。
 */
export interface KernelModuleHostApi {
  /** 注册一个模块；只能在 `start()` 之前调用，清单不合法或 id 重复时抛错。 */
  registerModule(definition: KernelModuleDefinition): void
  /** 按顺序注册一批模块，等价于逐个调 `registerModule`。 */
  registerModules(definitions: Iterable<KernelModuleDefinition>): void
  /** 解析依赖图，给出激活顺序与每件能力的提供方；成环或缺能力时抛错。 */
  resolvePlan(): KernelModulePlan
  /** 按解析出的顺序激活并就绪全部模块；只真正跑一次，失败时已激活的按逆序回滚。 */
  start(): Promise<void>
  /**
   * 用新的一代替换一个在跑的模块。
   *
   * 新代在暂存门后面激活并就绪，其间旧代照常提供服务；就绪之后同步切换可见性与事件归属，
   * 再释放旧代。替换失败只丢掉新代，现有图不受影响。
   */
  replaceModule(definition: KernelModuleDefinition): Promise<void>
  /** 按激活的逆序挂起全部模块；有模块挂起失败时收齐再一起抛。 */
  suspend(): Promise<void>
  /** 释放整个宿主；只真正跑一次，之后任何操作都拒绝。 */
  dispose(): Promise<void>
  /** 取一件能力当前活动的服务；没有或版本对不上时抛错。 */
  getService<TService extends object>(token: CapabilityToken<TService>): TService
  /** 取一件能力的服务句柄；句柄绑死在取的那一代，换代之后就失效。 */
  getServiceHandle<TService extends object>(
    token: CapabilityToken<TService>,
  ): KernelServiceHandle<TService>
  /** 取一件能力当前活动的服务，没有就返回 undefined，不抛错。 */
  getOptionalService<TService extends object>(
    token: CapabilityToken<TService>,
  ): TService | undefined
  /**
   * 把能力 id 解析成当前活动提供方的那一枚令牌。
   *
   * 调用方不许自己按缺省版本拼令牌：只有服务登记表知道现在活动的是哪一代、哪个版本。
   */
  getActiveCapabilityToken(capabilityId: string): CapabilityToken | undefined
  /**
   * 经宿主的权限权威判一次能力调用。
   *
   * 提供方模块身份与代际由活动服务句柄推出来，调用方伪造不了；`attribution` 是单独一个参数、
   * 不在 `request` 里，正是为了让模块自己的作用域 broker 够不着它。
   */
  requestCapabilityPermission(
    token: CapabilityToken,
    request: KernelModulePermissionRequest,
    attribution?: { readonly callerModuleId: string },
  ): Promise<KernelPermissionDecision>
  /** 以宿主身份订阅一类事件；返回的登记用完要 dispose。 */
  subscribe<TPayload>(
    type: string,
    handler: KernelEventHandler<TPayload>,
  ): KernelRegistration
  /** 取一个模块的只读快照，没注册过返回 undefined。 */
  getModule(moduleId: string): KernelModuleSnapshot | undefined
  /** 按模块 id 排序列出全部模块的只读快照。 */
  listModules(): readonly KernelModuleSnapshot[]
  /**
   * 运行组合的只读快照；**任何状态下都不抛错**，包括依赖图不合法和 dispose 之后。
   *
   * 快照最该有用的时刻就是降级态的宿主启动失败后要看诊断，所以解析失败不外抛，
   * 原因摆在 `resolutionError` 里。
   */
  describeComposition(): KernelCompositionSnapshot
  /** 逐个问一遍已就绪模块的健康度并写回快照；模块自己抛错算 unhealthy，不影响别人。 */
  checkHealth(): Promise<readonly KernelModuleSnapshot[]>
}

export class KernelModuleHost implements KernelModuleHostApi {
  /** 还没问过健康度（刚注册、已挂起、已释放）时的占位值。 */
  private static readonly unknownHealth: KernelModuleHealth = Object.freeze({ status: 'unknown' })
  /** 模块就绪但自己没实现 `health()` 时的默认值。 */
  private static readonly healthyHealth: KernelModuleHealth = Object.freeze({ status: 'healthy' })

  private readonly modules = new Map<string, ModuleRecord>()
  private readonly serviceStore = new KernelServiceStore()
  private readonly eventHub = new KernelEventHub()
  private readonly permissionBroker: KernelPermissionBroker
  private readonly stateBackend: KernelStateBackend
  private readonly isolationAdapters = new Map<
    ExternalKernelModuleIsolation,
    KernelModuleIsolationAdapter
  >()
  private activationOrder: readonly string[] = []
  private startPromise?: Promise<void>
  private disposePromise?: Promise<void>
  private disposed = false

  public constructor(private readonly options: KernelModuleHostOptions) {
    if (!Number.isInteger(options.apiVersion) || options.apiVersion <= 0) {
      throw new KernelError(
        KernelErrorCodes.invalidManifest,
        '内核宿主的 apiVersion 必须是正整数',
      )
    }
    this.permissionBroker = options.permissionBroker
      ?? new DenyAllKernelPermissionBroker()
    this.stateBackend = options.stateBackend
      ?? new InMemoryKernelStateBackend()
    for (const adapter of options.isolationAdapters ?? []) {
      if (this.isolationAdapters.has(adapter.isolation)) {
        throw new KernelError(
          KernelErrorCodes.invalidManifest,
          `隔离形态 "${adapter.isolation}" 注册了两个适配器`,
        )
      }
      this.isolationAdapters.set(adapter.isolation, adapter)
    }
  }

  public registerModule(definition: KernelModuleDefinition): void {
    this.assertNotDisposed()
    if (!isUndefined(this.startPromise)) {
      throw new KernelError(
        KernelErrorCodes.moduleState,
        '内核模块必须在宿主启动之前注册',
      )
    }
    const manifest = cloneManifest(definition.manifest)
    validateManifest(manifest, this.options.apiVersion)
    if (this.modules.has(manifest.id)) {
      throw new KernelError(
        KernelErrorCodes.duplicateModule,
        `内核模块 "${manifest.id}" 已经注册过了`,
        { moduleId: manifest.id },
      )
    }

    this.modules.set(manifest.id, createModuleRecord(definition, manifest, 1))
  }

  public registerModules(definitions: Iterable<KernelModuleDefinition>): void {
    for (const definition of definitions) this.registerModule(definition)
  }

  public resolvePlan(): KernelModulePlan {
    this.assertNotDisposed()
    return resolveKernelModulePlan(
      new Map(
        [...this.modules].map(([moduleId, record]) => [
          moduleId,
          record.definition,
        ]),
      ),
      this.options.apiVersion,
    )
  }

  public start(): Promise<void> {
    this.assertNotDisposed()
    this.startPromise ??= this.startOnce()
    return this.startPromise
  }

  private async startOnce(): Promise<void> {
    this.assertStartable()
    const plan = this.resolvePlan()
    this.activationOrder = plan.order
    const activatedModuleIds: string[] = []

    for (const moduleId of plan.order) {
      const record = this.modules.get(moduleId)!
      record.status = 'activating'
      record.error = undefined
      record.controller = new AbortController()
      record.contextActive = true
      try {
        const lifecycle = await this.activateRecord(record)
        record.lifecycle = lifecycle ?? {}
        record.status = 'active'
        activatedModuleIds.push(moduleId)
      } catch (error) {
        failModuleRecord(record, error)
        this.cleanupModule(record)
        const rollbackErrors = await this.rollback(activatedModuleIds)
        throw startupFailure({
          moduleId,
          phase: 'activate',
          cause: error,
          rollbackErrors,
        })
      }
    }

    for (const moduleId of plan.order) {
      const record = this.modules.get(moduleId)!
      record.status = 'readying'
      try {
        await record.lifecycle?.ready?.()
        record.status = 'ready'
        record.health = HealthyModuleHealth
      } catch (error) {
        failModuleRecord(record, error)
        const rollbackErrors = await this.rollback(
          activatedModuleIds,
          moduleId,
        )
        throw startupFailure({
          moduleId,
          phase: 'ready',
          cause: error,
          rollbackErrors,
        })
      }
    }
  }

  /**
   * Replaces one running module with a new generation.
   *
   * The replacement activates and reaches ready behind a staging gate. The old
   * generation remains live until the new generation is ready, then service
   * visibility and event delivery switch synchronously. A failed replacement
   * is removed without disturbing the current graph.
   */
  public async replaceModule(
    definition: KernelModuleDefinition,
  ): Promise<void> {
    this.assertNotDisposed()
    const manifest = cloneManifest(definition.manifest)
    validateManifest(manifest, this.options.apiVersion)
    const previous = this.modules.get(manifest.id)
    if (isUndefined(previous)) {
      throw new KernelError(
        KernelErrorCodes.moduleState,
        `模块 "${manifest.id}" 没注册过，替换不了`,
        { moduleId: manifest.id },
      )
    }
    if (
      previous.status !== 'ready'
      && previous.status !== 'active'
      && previous.status !== 'suspended'
    ) {
      throw new KernelError(
        KernelErrorCodes.moduleState,
        `内核模块 "${manifest.id}" 当前是 "${previous.status}" 状态，不能替换`,
        { moduleId: manifest.id },
      )
    }

    const replacement = createModuleRecord(
      definition,
      manifest,
      previous.generation + 1,
    )
    const tentativeDefinitions = new Map(
      [...this.modules].map(([moduleId, record]) => [
        moduleId,
        moduleId === manifest.id ? replacement.definition : record.definition,
      ]),
    )
    const plan = resolveKernelModulePlan(
      tentativeDefinitions,
      this.options.apiVersion,
    )

    let replacementCommitted = false
    replacement.status = 'activating'
    replacement.controller = new AbortController()
    replacement.contextActive = true
    let failedPhase: 'activate' | 'ready' = 'activate'
    try {
      const lifecycle = await this.activateRecord(
        replacement,
        {
          stageServices: true,
          isEventDeliveryEnabled: () => replacementCommitted,
        },
      )
      replacement.lifecycle = lifecycle ?? {}
      replacement.status = 'readying'
      failedPhase = 'ready'
      await replacement.lifecycle.ready?.()
      replacement.status = 'ready'
      replacement.health = HealthyModuleHealth
    } catch (error) {
      failModuleRecord(replacement, error)
      const rollbackErrors: Error[] = []
      try {
        await disposeModuleLifecycle(replacement)
      } catch (rollbackError) {
        const normalized = toError(rollbackError)
        rollbackErrors.push(normalized)
        log.warn('Replacement cleanup failed during rollback', {
          error: normalized,
          moduleId: manifest.id,
        })
      }
      this.cleanupModule(replacement)
      throw startupFailure({
        moduleId: manifest.id,
        phase: failedPhase,
        cause: error,
        rollbackErrors,
      })
    }

    // 新代已就绪：**先**同步切换可见性与归属，再去释放旧代。反过来（先释放、后切换）会让
    // 释放期间到达的调用打在正在释放的旧代上；旧代 dispose 抛错时更糟——旧代服务仍然活动、
    // 仍然能授权（探针实测：状态 failed，`getOptionalService` 还拿得到，权限还返回 granted）。
    // 下面四步之间没有 await，不存在「服务已切、归属未切」的窗口。
    this.serviceStore.activateOwner(manifest.id, replacement.generation)
    replacementCommitted = true
    this.modules.set(manifest.id, replacement)
    this.activationOrder = plan.order

    previous.status = 'disposing'
    previous.controller?.abort()
    try {
      await disposeModuleLifecycle(previous)
      previous.status = 'disposed'
    } catch (error) {
      // 旧代释放失败只是旧代的事：新代已经在提供服务，替换本身是成功的。
      failModuleRecord(previous, error)
      log.error('Kernel module previous generation failed to dispose', {
        error: toError(error),
        generation: previous.generation,
        moduleId: manifest.id,
      })
    } finally {
      // 不论释放成功与否，旧代的服务登记与事件订阅都必须摘掉。
      this.cleanupModule(previous)
    }
  }

  public async suspend(): Promise<void> {
    this.assertNotDisposed()
    const failures: Array<{ moduleId: string; error: Error }> = []
    for (const moduleId of [...this.activationOrder].reverse()) {
      const record = this.modules.get(moduleId)!
      if (record.status !== 'ready' && record.status !== 'active') continue
      record.status = 'suspending'
      try {
        await record.lifecycle?.suspend?.()
        record.status = 'suspended'
        record.health = UnknownModuleHealth
      } catch (error) {
        failModuleRecord(record, error)
        failures.push({ moduleId, error: toError(error) })
      }
    }

    if (!isEmpty(failures)) {
      throw lifecycleFailure('suspend', failures)
    }
  }

  public dispose(): Promise<void> {
    this.disposePromise ??= this.disposeOnce()
    return this.disposePromise
  }

  private async disposeOnce(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.startPromise) {
      try {
        await this.startPromise
      } catch (error) {
        // 启动调用方已收到原始拒绝；dispose 只等待结算并继续清理全部已注册模块。
        log.debug('Kernel start settled with failure before dispose', {
          error: toError(error).message,
        })
      }
    }
    const failures: Array<{ moduleId: string; error: Error }> = []
    const orderedIds = new Set(this.activationOrder)
    const remainingIds = [...this.modules.keys()]
      .filter((moduleId) => !orderedIds.has(moduleId))
      .sort()
    const disposeOrder = [...this.activationOrder, ...remainingIds].reverse()

    for (const moduleId of disposeOrder) {
      const record = this.modules.get(moduleId)!
      if (record.status === 'disposed') {
        this.cleanupModule(record)
        continue
      }
      record.status = 'disposing'
      record.controller?.abort()
      try {
        await disposeModuleLifecycle(record)
        record.status = 'disposed'
        record.health = UnknownModuleHealth
      } catch (error) {
        failModuleRecord(record, error)
        failures.push({ moduleId, error: toError(error) })
      } finally {
        this.cleanupModule(record)
      }
    }

    if (!isEmpty(failures)) {
      throw lifecycleFailure('dispose', failures)
    }
  }

  public getService<TService extends object>(
    token: CapabilityToken<TService>,
  ): TService {
    return this.serviceStore.get(token)
  }

  public getServiceHandle<TService extends object>(
    token: CapabilityToken<TService>,
  ): KernelServiceHandle<TService> {
    return this.serviceStore.getHandle(token)
  }

  public getOptionalService<TService extends object>(
    token: CapabilityToken<TService>,
  ): TService | undefined {
    return this.serviceStore.getOptional(token)
  }

  /**
   * Resolves an id to the exact token of its active provider.
   *
   * Product hosts and the protocol service must not reconstruct a token using
   * a guessed default version. The service registry is the only source that
   * knows which generation and capability version is currently visible.
   */
  public getActiveCapabilityToken(
    capabilityId: string,
  ): CapabilityToken | undefined {
    return this.serviceStore.getActiveToken(capabilityId)
  }

  /**
   * Runs a capability invocation through the host-owned permission authority.
   *
   * The caller supplies only the requested operation permission. Provider
   * module identity and generation are derived from the active service handle,
   * so a client cannot forge either field.
   *
   * `attribution` is a **separate parameter, not part of `request`**, precisely so it stays
   * out of {@link KernelModulePermissionRequest}: only a host that has authenticated the
   * caller may name it, and a module calling through its own scoped broker has no way to
   * reach this argument.
   */
  public async requestCapabilityPermission(
    token: CapabilityToken,
    request: KernelModulePermissionRequest,
    attribution?: { readonly callerModuleId: string },
  ): Promise<KernelPermissionDecision> {
    this.assertNotDisposed()
    const handle = this.serviceStore.getHandle(token)
    const record = this.modules.get(handle.ownerModuleId)
    if (
      isUndefined(record)
      || record.generation !== handle.generation
      || !record.contextActive
    ) return {
        status: 'denied',
        reason: `Capability "${token.id}" has no active provider`,
      }
    if (!record.definition.manifest.permissions.includes(request.permission)) return {
        status: 'denied',
        reason: `Module "${handle.ownerModuleId}" did not declare permission "${request.permission}"`,
      }
    return this.permissionBroker.request({
      ...request,
      moduleId: handle.ownerModuleId,
      generation: handle.generation,
      // 调用方只由宿主认定：没有 attribution 时显式清空，request 里即便夹带了也不会透传。
      callerModuleId: attribution?.callerModuleId,
    })
  }

  public subscribe<TPayload>(
    type: string,
    handler: KernelEventHandler<TPayload>,
  ): KernelRegistration {
    this.assertNotDisposed()
    return this.eventHub.subscribe('@host', 0, type, handler)
  }

  public getModule(moduleId: string): KernelModuleSnapshot | undefined {
    const record = this.modules.get(moduleId)
    return isUndefined(record) ? undefined : toModuleSnapshot(record)
  }

  public listModules(): readonly KernelModuleSnapshot[] {
    return [...this.modules.values()]
      .sort((left, right) => {
        const leftId = left.definition.manifest.id
        const rightId = right.definition.manifest.id
        if (leftId < rightId) return -1
        if (leftId > rightId) return 1
        return 0
      })
      .map((record) => toModuleSnapshot(record))
  }

  /**
   * 运行组合的只读快照。**任何状态下都不抛错**，包括依赖图不合法和 dispose 之后。
   *
   * 它一度先 `resolvePlan()` 再组装，于是「启动失败之后要看诊断」的时刻反而抛
   * `MISSING_CAPABILITY`、dispose 之后抛 `HOST_DISPOSED`——正好把降级态的宿主
   * （Desktop、Workbench 都用 `lifecycleFailureMode: 'degrade'`）挡在诊断门外。
   */
  public describeComposition(): KernelCompositionSnapshot {
    let plan: KernelModulePlan | undefined
    let resolutionError: Nullable<string> = null
    try {
      plan = resolveKernelModulePlan(
        new Map(
          [...this.modules].map(([moduleId, record]) => [
            moduleId,
            record.definition,
          ]),
        ),
        this.options.apiVersion,
      )
    } catch (error) {
      // 不外抛：原因随快照一起交给调用方（`resolutionError`），日志留一条便于对账。
      resolutionError = toError(error).message
      log.debug('Kernel composition snapshot taken with an unresolved graph', {
        error: resolutionError,
      })
    }

    const activeServices = new Map(
      this.serviceStore.listActiveServices().map((service) => [service.capabilityId, service])
    )
    const providers = isUndefined(plan)
      ? this.declaredCapabilityProviders()
      : [...plan.capabilityProviders.entries()].map(([id, provider]) => ({
          id,
          version: provider.capability.version,
          providerModuleId: provider.moduleId,
        }))
    const capabilities = providers
      .sort((left, right) =>
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
      .map((provider) => {
        const active = activeServices.get(provider.id)
        return Object.freeze({
          id: provider.id,
          version: provider.version,
          providerModuleId: provider.providerModuleId,
          active: Boolean(
            active
            && active.ownerModuleId === provider.providerModuleId
            && active.capabilityVersion === provider.version
          ),
          activeGeneration: active?.ownerModuleId === provider.providerModuleId
            ? active.generation
            : null,
        })
      })
    return Object.freeze({
      schemaVersion: 1,
      apiVersion: this.options.apiVersion,
      // 解析不出顺序时退回登记顺序（依赖图不合法时它本来也不存在真正的激活顺序）。
      moduleOrder: Object.freeze(
        isUndefined(plan) ? [...this.modules.keys()] : [...plan.order],
      ),
      modules: Object.freeze([...this.listModules()]),
      capabilities: Object.freeze(capabilities),
      resolutionError,
    })
  }

  /** 依赖图解析不了时的退路：直接读每个模块清单自己声明的 provides。 */
  private declaredCapabilityProviders(): Array<{
    id: string
    version: string
    providerModuleId: string
  }> {
    const providers: Array<{
      id: string
      version: string
      providerModuleId: string
    }> = []
    for (const record of this.modules.values()) {
      const { id: moduleId, provides } = record.definition.manifest
      for (const capability of provides) {
        providers.push({
          id: capability.id,
          version: capability.version,
          providerModuleId: moduleId,
        })
      }
    }
    return providers
  }

  public async checkHealth(): Promise<readonly KernelModuleSnapshot[]> {
    for (const record of this.modules.values()) {
      if (record.status !== 'ready') continue
      try {
        record.health = isUndefined(record.lifecycle?.health)
          ? HealthyModuleHealth
          : await record.lifecycle.health()
      } catch (error) {
        log.warn('Kernel module health check failed', {
          error,
          moduleId: record.definition.manifest.id,
        })
        record.health = {
          status: 'unhealthy',
          message: toError(error).message,
        }
      }
    }
    return this.listModules()
  }

  private assertNotDisposed(): void {
    if (!this.disposed) return
    throw new KernelError(KernelErrorCodes.hostDisposed, '内核模块宿主已回收')
  }

  private assertStartable(): void {
    const invalid = [...this.modules.values()].find(
      (record) => record.status !== 'registered',
    )
    if (isUndefined(invalid)) return
    throw new KernelError(
      KernelErrorCodes.moduleState,
      `内核模块 "${invalid.definition.manifest.id}" 当前是 "${invalid.status}" 状态，起不来`,
      { moduleId: invalid.definition.manifest.id },
    )
  }

  private createActivateContext(
    record: ModuleRecord,
    options: {
      readonly stageServices?: boolean
      readonly isEventDeliveryEnabled?: () => boolean
    } = {},
  ): KernelModuleActivateContext {
    const { manifest } = record.definition
    const readableCapabilityIds = [
      ...manifest.provides.map((capability) => capability.id),
      ...manifest.requires.map((requirement) => requirement.id),
      ...manifest.optionalRequires.map((requirement) => requirement.id),
    ]
    const services = new ScopedKernelServiceResolver(
      manifest.id,
      readableCapabilityIds,
      this.serviceStore,
      () => assertModuleContextActive(record),
    )

    return Object.freeze({
      moduleId: manifest.id,
      generation: record.generation,
      signal: record.controller!.signal,
      services,
      events: this.eventHub.forModule(
        manifest.id,
        record.generation,
        () => assertModuleContextActive(record),
        options.isEventDeliveryEnabled,
      ),
      permissions: createScopedPermissionBroker({
        manifest,
        generation: record.generation,
        broker: this.permissionBroker,
        assertActive: () => assertModuleContextActive(record),
      }),
      state: createNamespacedStateStore({
        namespace: manifest.id,
        backend: this.stateBackend,
        assertActive: () => assertModuleContextActive(record),
      }),
      registerService: <TService extends object>(
        token: CapabilityToken<TService>,
        service: TService,
      ) => {
        assertModuleContextActive(record)
        const declaredCapability = manifest.provides.find(
          (capability) => capability.id === token.id,
        )
        if (
          isUndefined(declaredCapability)
          || declaredCapability.version !== token.version
        ) {
          throw new KernelError(
            KernelErrorCodes.undeclaredCapabilityProvider,
            `模块 "${manifest.id}" 注册了自己没声明提供的能力 "${token.id}"（版本 "${token.version}"）`,
            { moduleId: manifest.id, capabilityId: token.id },
          )
        }
        return this.serviceStore.register(
          manifest.id,
          record.generation,
          token,
          service,
          { activate: !isTrue(options.stageServices) },
        )
      },
    })
  }



  private async rollback(
    activatedModuleIds: readonly string[],
    failedModuleId?: string,
  ): Promise<readonly Error[]> {
    const rollbackErrors: Error[] = []
    for (const moduleId of [...activatedModuleIds].reverse()) {
      const record = this.modules.get(moduleId)!
      record.controller?.abort()
      try {
        await disposeModuleLifecycle(record)
        if (moduleId !== failedModuleId) {
          record.status = 'disposed'
          record.health = UnknownModuleHealth
        }
      } catch (error) {
        const normalized = toError(error)
        rollbackErrors.push(normalized)
        log.warn('Kernel module rollback failed', { error: normalized, moduleId })
        if (moduleId !== failedModuleId) failModuleRecord(record, normalized)
      } finally {
        this.cleanupModule(record)
      }
    }
    return rollbackErrors
  }

  private cleanupModule(record: ModuleRecord): void {
    const { id } = record.definition.manifest
    record.contextActive = false
    this.serviceStore.removeOwner(id, record.generation)
    this.eventHub.removeOwner(id, record.generation)
  }




  private activateRecord(
    record: ModuleRecord,
    options?: {
      readonly stageServices?: boolean
      readonly isEventDeliveryEnabled?: () => boolean
    },
  ): Promise<KernelModuleLifecycle | void> {
    const context = this.createActivateContext(record, options)
    const { isolation } = record.definition.manifest
    if (isolation === 'in-process') return Promise.resolve(record.definition.activate(context))

    const adapter = this.isolationAdapters.get(isolation)
    if (isUndefined(adapter)) {
      throw new KernelError(
        KernelErrorCodes.missingIsolationAdapter,
        `Module "${record.definition.manifest.id}" requires a "${isolation}" isolation adapter`,
        { moduleId: record.definition.manifest.id },
      )
    }
    return Promise.resolve(adapter.activate(record.definition, context))
  }
}
