import type {
  CapabilityRequirement,
  CapabilityToken,
} from './capability.js'
import type { KernelModuleEventBus } from './events.js'
import type {
  KernelModulePermissionBroker,
} from './permissions.js'
import type { KernelStateStore } from './state.js'

export type Awaitable<T> = T | Promise<T>

export type KernelModuleIsolation = 'in-process' | 'worker' | 'sidecar'

/**
 * Static declaration used to resolve a module graph before module code activates.
 *
 * Capability ids are stable contract identities. Module ids identify concrete
 * providers and must be unique within a host.
 */
export interface KernelModuleManifest {
  readonly id: string
  readonly version: string
  readonly apiVersion: number
  readonly provides: readonly CapabilityToken[]
  readonly requires: readonly CapabilityRequirement[]
  readonly optionalRequires: readonly CapabilityRequirement[]
  readonly permissions: readonly string[]
  readonly isolation: KernelModuleIsolation
}

/** Idempotent registration handle returned by host-owned registries. */
export interface KernelRegistration {
  dispose(): void
}

/** Generation-bound service lease. Old handles fail after provider replacement. */
export interface KernelServiceHandle<TService extends object> {
  readonly capabilityId: string
  readonly capabilityVersion: string
  readonly ownerModuleId: string
  readonly generation: number
  isActive(): boolean
  get(): TService
}

/** Read-only view of services injected by other modules. */
export interface KernelServiceResolver {
  has(token: CapabilityToken): boolean
  get<TService extends object>(token: CapabilityToken<TService>): TService
  getHandle<TService extends object>(
    token: CapabilityToken<TService>,
  ): KernelServiceHandle<TService>
  getOptional<TService extends object>(
    token: CapabilityToken<TService>,
  ): TService | undefined
}

/**
 * Narrow host surface supplied to one module during activation.
 *
 * Service and event registrations are attributed to `moduleId` and are removed
 * automatically on rollback or disposal.
 */
export interface KernelModuleActivateContext {
  readonly moduleId: string
  readonly generation: number
  readonly signal: AbortSignal
  readonly services: KernelServiceResolver
  readonly events: KernelModuleEventBus
  readonly permissions: KernelModulePermissionBroker
  readonly state: KernelStateStore
  registerService<TService extends object>(
    token: CapabilityToken<TService>,
    service: TService,
  ): KernelRegistration
}

export type KernelModuleHealthStatus =
  | 'unknown'
  | 'healthy'
  | 'degraded'
  | 'unhealthy'

/**
 * Module lifecycle states owned by the host state machine.
 *
 * Declared here because both the host and the service-facing contracts speak it;
 * duplicating the union let a new state reach the host while the wire view stayed
 * silently stale.
 */
export type KernelModuleStatus =
  | 'registered'
  | 'activating'
  | 'active'
  | 'readying'
  | 'ready'
  | 'suspending'
  | 'suspended'
  | 'disposing'
  | 'disposed'
  | 'failed'

export interface KernelModuleHealth {
  readonly status: KernelModuleHealthStatus
  readonly message?: string
  readonly details?: Readonly<Record<string, unknown>>
}

/**
 * Hooks returned after activation. Hooks are optional so a registration-only
 * module stays small.
 */
export interface KernelModuleLifecycle {
  ready?(): Awaitable<void>
  suspend?(): Awaitable<void>
  dispose?(): Awaitable<void>
  health?(): Awaitable<KernelModuleHealth>
}

/**
 * Executable module supplied to a host or to an isolation adapter.
 *
 * Worker and sidecar loaders implement this same boundary, keeping the host
 * independent of transport details.
 */
export interface KernelModuleDefinition {
  readonly manifest: KernelModuleManifest
  activate(
    context: KernelModuleActivateContext,
  ): Awaitable<KernelModuleLifecycle | void>
}

/** Preserves a module's precise inferred type while checking its contract. */
export function defineKernelModule<TModule extends KernelModuleDefinition>(
  module: TModule,
): TModule {
  return module
}
