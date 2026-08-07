import { isUndefined } from '@velaros-ai/core'

import {
  type CapabilityToken,
  isKernelCallableCapabilityService,
  type KernelCallableCapabilityService,
  type KernelEventHandler,
  KernelModuleApiVersion,
  type KernelModuleDefinition,
  type KernelModulePermissionRequest,
  type KernelPermissionDecision,
  type KernelRegistration,
  KernelVersion,
} from '../contracts/abi'

import {
  type KernelCapabilityCall,
  KernelCapabilityInvoker,
} from './capability-invocation'
import {
  KernelModuleHost,
  type KernelModuleHostOptions,
  type KernelModuleSnapshot,
  toError,
} from './host'

export type KernelStatus =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'degraded'
  | 'disposing'
  | 'disposed'

export interface KernelLifecycleFailure {
  readonly phase: 'start' | 'dispose'
  readonly error: Error
}

export interface KernelOptions
  extends Omit<KernelModuleHostOptions, 'apiVersion'> {
  readonly apiVersion?: number
  readonly kernelVersion?: string
  /**
   * `throw` is the secure library default. Complete UI hosts may choose
   * `degrade` when optional capabilities must not brick the product shell.
   */
  readonly lifecycleFailureMode?: 'throw' | 'degrade'
  readonly onLifecycleFailure?: (failure: KernelLifecycleFailure) => void
}

export type { KernelCapabilityCall } from './capability-invocation'
export {
  KernelCapabilityNotCallableError,
  KernelCapabilityOperationMetadataError,
  KernelCapabilityPermissionCheckError,
  KernelCapabilityPermissionDeniedError,
  KernelCapabilityUnavailableError,
} from './capability-invocation'

/**
 * Product-neutral, in-process VelarOS Kernel facade.
 *
 * This is the public `new Kernel()` path described by the Kernel contract. It
 * owns one module host, idempotent lifecycle, exact active-token resolution,
 * permission-gated callable invocation, and event subscription. Products only
 * choose modules and lifecycle failure policy; they do not recreate these
 * semantics in their own repositories.
 */
export class Kernel {
  private readonly host: KernelModuleHost
  private readonly capabilityInvoker: KernelCapabilityInvoker
  private readonly failureMode: 'throw' | 'degrade'
  private startPromise?: Promise<void>
  private disposePromise?: Promise<void>
  private status: KernelStatus = 'idle'

  public readonly version: string

  public constructor(private readonly options: KernelOptions = {}) {
    this.version = options.kernelVersion ?? KernelVersion
    this.failureMode = options.lifecycleFailureMode ?? 'throw'
    this.host = new KernelModuleHost({
      apiVersion: options.apiVersion ?? KernelModuleApiVersion,
      ...(isUndefined(options.permissionBroker)
        ? {}
        : { permissionBroker: options.permissionBroker }),
      ...(isUndefined(options.stateBackend)
        ? {}
        : { stateBackend: options.stateBackend }),
      ...(isUndefined(options.isolationAdapters)
        ? {}
        : { isolationAdapters: options.isolationAdapters }),
    })
    this.capabilityInvoker = new KernelCapabilityInvoker(this.host)
  }

  public getStatus(): KernelStatus {
    return this.status
  }

  public registerModule(definition: KernelModuleDefinition): void {
    if (this.status !== 'idle') {
      throw new Error('Kernel modules must be registered before start')
    }
    this.host.registerModule(definition)
  }

  public registerModules(definitions: Iterable<KernelModuleDefinition>): void {
    if (this.status !== 'idle') {
      throw new Error('Kernel modules must be registered before start')
    }
    this.host.registerModules(definitions)
  }

  public start(): Promise<void> {
    if (this.status === 'disposed' || this.status === 'disposing') return Promise.reject(new Error('Disposed Kernel cannot be started'))
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

  public hasCapability(capabilityId: string): boolean {
    return !isUndefined(this.host.getActiveCapabilityToken(capabilityId))
  }

  public getCapability<TService extends object>(
    token: CapabilityToken<TService>,
  ): TService | undefined {
    return this.host.getOptionalService(token)
  }

  /** Resolves a callable service using the registry's exact active version. */
  public resolveCallableCapability(
    capabilityId: string,
  ): Nullable<KernelCallableCapabilityService> {
    const token = this.host.getActiveCapabilityToken(capabilityId)
    if (isUndefined(token)) return null
    const service = this.host.getOptionalService(token)
    return isKernelCallableCapabilityService(service) ? service : null
  }

  /**
   * `attribution` names the party the invocation acts *on behalf of*, when the host has
   * authenticated it. Without it the grant is keyed on the capability's provider, so one
   * mod's approval silently covers every other mod that later calls the same provider.
   */
  public async requestCapabilityPermission(
    capabilityId: string,
    request: KernelModulePermissionRequest,
    attribution?: { readonly callerModuleId: string },
  ): Promise<KernelPermissionDecision> {
    const token = this.host.getActiveCapabilityToken(capabilityId)
    if (isUndefined(token)) return {
        status: 'denied',
        reason: `Capability "${capabilityId}" has no active provider`,
      }
    return this.host.requestCapabilityPermission(token, request, attribution)
  }

  /**
   * Invokes a callable capability through the Ring 0 permission authority.
   * Unknown operations fail before permission evaluation; every declared
   * permission is checked before any provider code runs.
   */
  public async invokeCapability(call: KernelCapabilityCall): Promise<unknown> {
    return this.capabilityInvoker.invoke(call)
  }

  public subscribeEvent<TPayload>(
    type: string,
    handler: KernelEventHandler<TPayload>,
  ): () => void {
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
