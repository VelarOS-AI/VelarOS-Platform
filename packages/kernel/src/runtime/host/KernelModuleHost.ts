import { isEmpty, isTrue, isUndefined, Log } from '@velaros-ai/core'

import type {
  CapabilityToken,
  KernelEventHandler,
  KernelModuleActivateContext,
  KernelModuleDefinition,
  KernelModuleHealth,
  KernelModuleLifecycle,
  KernelModuleManifest,
  KernelModulePermissionRequest,
  KernelModuleStatus,
  KernelPermissionBroker,
  KernelPermissionDecision,
  KernelRegistration,
  KernelServiceHandle,
} from '../../contracts/abi'

import {
  type KernelModulePlan,
  resolveKernelModulePlan,
  validateManifest,
} from './dependency-resolver'
import {
  KernelHostError,
  KernelOperationError,
  KernelStartupError,
  toError,
} from './errors'
import { KernelEventHub } from './event-bus'
import {
  type ExternalKernelModuleIsolation,
  type KernelModuleIsolationAdapter,
} from './isolation'
import {
  createScopedPermissionBroker,
  DenyAllKernelPermissionBroker,
} from './permission-broker'
import {
  KernelServiceStore,
  ScopedKernelServiceResolver,
} from './service-registry'
import {
  createNamespacedStateStore,
  InMemoryKernelStateBackend,
  type KernelStateBackend,
} from './state-store'

export type { KernelModuleStatus } from '../../contracts/abi'

const log = Log.tag('KernelModuleHost')

export interface KernelModuleSnapshot {
  readonly manifest: KernelModuleManifest
  readonly status: KernelModuleStatus
  readonly health: KernelModuleHealth
  readonly generation: number
  readonly error?: string
}

export interface KernelCompositionCapabilitySnapshot {
  readonly id: string
  readonly version: string
  readonly providerModuleId: string
  readonly active: boolean
  readonly activeGeneration: Nullable<number>
}

/**
 * 运行组合的只读机器视图。它描述“装了什么、按什么顺序、哪些服务真的活动”，不接受 patch，
 * 因而不能绕过 Ring 0 的模块注册、权限或生命周期裁决。
 */
export interface KernelCompositionSnapshot {
  readonly schemaVersion: 1
  readonly apiVersion: number
  readonly moduleOrder: readonly string[]
  readonly modules: readonly KernelModuleSnapshot[]
  readonly capabilities: readonly KernelCompositionCapabilitySnapshot[]
}

interface ModuleRecord {
  readonly definition: KernelModuleDefinition
  readonly generation: number
  status: KernelModuleStatus
  health: KernelModuleHealth
  contextActive: boolean
  lifecycleDisposed: boolean
  error?: string
  lifecycle?: KernelModuleLifecycle
  controller?: AbortController
}

export interface KernelModuleHostOptions {
  readonly apiVersion: number
  readonly permissionBroker?: KernelPermissionBroker
  readonly stateBackend?: KernelStateBackend
  readonly isolationAdapters?: readonly KernelModuleIsolationAdapter[]
}

const unknownHealth: KernelModuleHealth = Object.freeze({ status: 'unknown' })
const healthyHealth: KernelModuleHealth = Object.freeze({ status: 'healthy' })

function cloneManifest(manifest: KernelModuleManifest): KernelModuleManifest {
  return Object.freeze({
    ...manifest,
    provides: Object.freeze(
      manifest.provides.map((capability) =>
        Object.freeze({ id: capability.id, version: capability.version })),
    ),
    requires: Object.freeze(
      manifest.requires.map((requirement) => Object.freeze({ ...requirement })),
    ),
    optionalRequires: Object.freeze(
      manifest.optionalRequires.map((requirement) =>
        Object.freeze({ ...requirement })),
    ),
    permissions: Object.freeze([...manifest.permissions]),
  })
}

/**
 * Product-neutral composition root for injected kernel modules.
 *
 * The host owns ordering, lifecycle, registration attribution, and rollback. It
 * deliberately has no knowledge of the capabilities carried by the graph.
 */
export class KernelModuleHost {
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
      throw new KernelHostError(
        'INVALID_MANIFEST',
        'Kernel host apiVersion must be a positive integer',
      )
    }
    this.permissionBroker = options.permissionBroker
      ?? new DenyAllKernelPermissionBroker()
    this.stateBackend = options.stateBackend
      ?? new InMemoryKernelStateBackend()
    for (const adapter of options.isolationAdapters ?? []) {
      if (this.isolationAdapters.has(adapter.isolation)) {
        throw new KernelHostError(
          'INVALID_MANIFEST',
          `Duplicate isolation adapter for "${adapter.isolation}"`,
        )
      }
      this.isolationAdapters.set(adapter.isolation, adapter)
    }
  }

  public registerModule(definition: KernelModuleDefinition): void {
    this.assertNotDisposed()
    if (!isUndefined(this.startPromise)) {
      throw new KernelHostError(
        'MODULE_STATE',
        'Kernel modules must be registered before host start',
      )
    }
    const manifest = cloneManifest(definition.manifest)
    validateManifest(manifest, this.options.apiVersion)
    if (this.modules.has(manifest.id)) {
      throw new KernelHostError(
        'DUPLICATE_MODULE',
        `Kernel module "${manifest.id}" is already registered`,
        { moduleId: manifest.id },
      )
    }

    this.modules.set(manifest.id, this.createRecord(definition, manifest, 1))
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
        this.failRecord(record, error)
        this.cleanupModule(record)
        const rollbackErrors = await this.rollback(activatedModuleIds)
        throw new KernelStartupError({
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
        record.health = healthyHealth
      } catch (error) {
        this.failRecord(record, error)
        const rollbackErrors = await this.rollback(
          activatedModuleIds,
          moduleId,
        )
        throw new KernelStartupError({
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
      throw new KernelHostError(
        'MODULE_STATE',
        `Cannot replace unregistered module "${manifest.id}"`,
        { moduleId: manifest.id },
      )
    }
    if (
      previous.status !== 'ready'
      && previous.status !== 'active'
      && previous.status !== 'suspended'
    ) {
      throw new KernelHostError(
        'MODULE_STATE',
        `Kernel module "${manifest.id}" cannot be replaced from state "${previous.status}"`,
        { moduleId: manifest.id },
      )
    }

    const replacement = this.createRecord(
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
      replacement.health = healthyHealth
    } catch (error) {
      this.failRecord(replacement, error)
      const rollbackErrors: Error[] = []
      try {
        await this.disposeLifecycle(replacement)
      } catch (rollbackError) {
        const normalized = toError(rollbackError)
        rollbackErrors.push(normalized)
        log.warn('Replacement cleanup failed during rollback', {
          error: normalized,
          moduleId: manifest.id,
        })
      }
      this.cleanupModule(replacement)
      throw new KernelStartupError({
        moduleId: manifest.id,
        phase: failedPhase,
        cause: error,
        rollbackErrors,
      })
    }

    previous.status = 'disposing'
    previous.controller?.abort()
    try {
      await this.disposeLifecycle(previous)
    } catch (error) {
      this.failRecord(previous, error)
      replacement.controller.abort()
      await this.disposeLifecycle(replacement).catch((rollbackError) => {
        log.warn('Replacement cleanup failed after prior module disposal error', {
          error: rollbackError,
          moduleId: manifest.id,
        })
      })
      this.cleanupModule(replacement)
      throw new KernelOperationError('dispose', [
        { moduleId: manifest.id, error: toError(error) },
      ])
    }
    previous.status = 'disposed'

    this.serviceStore.activateOwner(manifest.id, replacement.generation)
    replacementCommitted = true
    this.cleanupModule(previous)
    this.modules.set(manifest.id, replacement)
    this.activationOrder = plan.order
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
        record.health = unknownHealth
      } catch (error) {
        this.failRecord(record, error)
        failures.push({ moduleId, error: toError(error) })
      }
    }

    if (!isEmpty(failures)) {
      throw new KernelOperationError('suspend', failures)
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
        await this.disposeLifecycle(record)
        record.status = 'disposed'
        record.health = unknownHealth
      } catch (error) {
        this.failRecord(record, error)
        failures.push({ moduleId, error: toError(error) })
      } finally {
        this.cleanupModule(record)
      }
    }

    if (!isEmpty(failures)) {
      throw new KernelOperationError('dispose', failures)
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
      ...(attribution ? { callerModuleId: attribution.callerModuleId } : {}),
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
    return isUndefined(record) ? undefined : this.snapshot(record)
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
      .map((record) => this.snapshot(record))
  }

  public describeComposition(): KernelCompositionSnapshot {
    const plan = this.resolvePlan()
    const activeServices = new Map(
      this.serviceStore.listActiveServices().map((service) => [service.capabilityId, service])
    )
    const capabilities = [...plan.capabilityProviders.entries()]
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([id, provider]) => {
        const active = activeServices.get(id)
        return Object.freeze({
          id,
          version: provider.capability.version,
          providerModuleId: provider.moduleId,
          active: Boolean(
            active
            && active.ownerModuleId === provider.moduleId
            && active.capabilityVersion === provider.capability.version
          ),
          activeGeneration: active?.ownerModuleId === provider.moduleId
            ? active.generation
            : null,
        })
      })
    return Object.freeze({
      schemaVersion: 1,
      apiVersion: this.options.apiVersion,
      moduleOrder: Object.freeze([...plan.order]),
      modules: Object.freeze([...this.listModules()]),
      capabilities: Object.freeze(capabilities),
    })
  }

  public async checkHealth(): Promise<readonly KernelModuleSnapshot[]> {
    for (const record of this.modules.values()) {
      if (record.status !== 'ready') continue
      try {
        record.health = isUndefined(record.lifecycle?.health)
          ? healthyHealth
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
    throw new KernelHostError('HOST_DISPOSED', 'Kernel module host is disposed')
  }

  private assertStartable(): void {
    const invalid = [...this.modules.values()].find(
      (record) => record.status !== 'registered',
    )
    if (isUndefined(invalid)) return
    throw new KernelHostError(
      'MODULE_STATE',
      `Kernel module "${invalid.definition.manifest.id}" cannot start from state "${invalid.status}"`,
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
      () => this.assertModuleContextActive(record),
    )

    return Object.freeze({
      moduleId: manifest.id,
      generation: record.generation,
      signal: record.controller!.signal,
      services,
      events: this.eventHub.forModule(
        manifest.id,
        record.generation,
        () => this.assertModuleContextActive(record),
        options.isEventDeliveryEnabled,
      ),
      permissions: createScopedPermissionBroker({
        manifest,
        generation: record.generation,
        broker: this.permissionBroker,
        assertActive: () => this.assertModuleContextActive(record),
      }),
      state: createNamespacedStateStore({
        namespace: manifest.id,
        backend: this.stateBackend,
        assertActive: () => this.assertModuleContextActive(record),
      }),
      registerService: <TService extends object>(
        token: CapabilityToken<TService>,
        service: TService,
      ) => {
        this.assertModuleContextActive(record)
        const declaredCapability = manifest.provides.find(
          (capability) => capability.id === token.id,
        )
        if (
          isUndefined(declaredCapability)
          || declaredCapability.version !== token.version
        ) {
          throw new KernelHostError(
            'UNDECLARED_CAPABILITY_PROVIDER',
            `Module "${manifest.id}" registered undeclared capability "${token.id}" at version "${token.version}"`,
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

  private assertModuleContextActive(record: ModuleRecord): void {
    if (record.contextActive) return
    throw new KernelHostError(
      'MODULE_STATE',
      `Kernel module context "${record.definition.manifest.id}" is no longer active`,
      { moduleId: record.definition.manifest.id },
    )
  }

  private failRecord(record: ModuleRecord, error: unknown): void {
    const normalized = toError(error)
    record.status = 'failed'
    record.error = normalized.message
    record.health = {
      status: 'unhealthy',
      message: normalized.message,
    }
    record.controller?.abort()
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
        await this.disposeLifecycle(record)
        if (moduleId !== failedModuleId) {
          record.status = 'disposed'
          record.health = unknownHealth
        }
      } catch (error) {
        const normalized = toError(error)
        rollbackErrors.push(normalized)
        log.warn('Kernel module rollback failed', { error: normalized, moduleId })
        if (moduleId !== failedModuleId) this.failRecord(record, normalized)
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

  private async disposeLifecycle(record: ModuleRecord): Promise<void> {
    if (record.lifecycleDisposed) return
    record.lifecycleDisposed = true
    await record.lifecycle?.dispose?.()
  }

  private snapshot(record: ModuleRecord): KernelModuleSnapshot {
    return Object.freeze({
      manifest: record.definition.manifest,
      status: record.status,
      health: record.health,
      generation: record.generation,
      ...(isUndefined(record.error) ? {} : { error: record.error }),
    })
  }

  private createRecord(
    definition: KernelModuleDefinition,
    manifest: KernelModuleManifest,
    generation: number,
  ): ModuleRecord {
    return {
      definition: {
        manifest,
        activate: (context) => definition.activate(context),
      },
      generation,
      status: 'registered',
      health: unknownHealth,
      contextActive: false,
      lifecycleDisposed: false,
    }
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
      throw new KernelHostError(
        'MISSING_ISOLATION_ADAPTER',
        `Module "${record.definition.manifest.id}" requires a "${isolation}" isolation adapter`,
        { moduleId: record.definition.manifest.id },
      )
    }
    return Promise.resolve(adapter.activate(record.definition, context))
  }
}
