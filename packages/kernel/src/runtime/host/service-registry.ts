import { isFalse, isFunction, isNotUndefined, isNull, isObject,isUndefined } from '@velaros-ai/core';

import type {
  CapabilityToken,
  KernelRegistration,
  KernelServiceHandle,
  KernelServiceResolver,
} from '../../contracts/abi'

import { KernelHostError } from './errors'

interface ServiceEntry {
  readonly ownerModuleId: string
  readonly generation: number
  readonly capabilityVersion: string
  readonly service: object
}

export class KernelServiceStore {
  private readonly entries = new Map<string, Set<ServiceEntry>>()
  private readonly activeEntries = new Map<string, ServiceEntry>()

  public has(token: CapabilityToken): boolean {
    return this.activeEntries.get(token.id)?.capabilityVersion === token.version
  }

  /** Resolves the exact token of the currently active provider for an id. */
  public getActiveToken(capabilityId: string): CapabilityToken | undefined {
    const entry = this.activeEntries.get(capabilityId)
    return isUndefined(entry)
      ? undefined
      : Object.freeze({
          id: capabilityId,
          version: entry.capabilityVersion,
        })
  }

  public get<TService extends object>(
    token: CapabilityToken<TService>,
  ): TService {
    return this.getHandle(token).get()
  }

  public getHandle<TService extends object>(
    token: CapabilityToken<TService>,
  ): KernelServiceHandle<TService> {
    const entry = this.requireEntry(token)
    let proxy: TService | undefined
    const assertActive = () => {
      if (this.activeEntries.get(token.id) === entry) return
      throw new KernelHostError(
        'MODULE_STATE',
        `Service handle for capability "${token.id}" from generation ${entry.generation} is stale`,
        {
          moduleId: entry.ownerModuleId,
          capabilityId: token.id,
        },
      )
    }

    return Object.freeze({
      capabilityId: token.id,
      capabilityVersion: entry.capabilityVersion,
      ownerModuleId: entry.ownerModuleId,
      generation: entry.generation,
      isActive: () => this.activeEntries.get(token.id) === entry,
      get: () => {
        assertActive()
        proxy ??= new Proxy(Object.create(null) as object, {
          get: (_target, property) => {
            assertActive()
            const value = Reflect.get(
              entry.service,
              property,
              entry.service,
            ) as unknown
            if (!isFunction(value)) return value
            return (...arguments_: unknown[]) => {
              assertActive()
              return Reflect.apply(value, entry.service, arguments_)
            }
          },
          set: (_target, property, value) => {
            assertActive()
            return Reflect.set(
              entry.service,
              property,
              value,
              entry.service,
            )
          },
        }) as TService
        return proxy
      },
    })
  }

  public getOptional<TService extends object>(
    token: CapabilityToken<TService>,
  ): TService | undefined {
    return this.has(token) ? this.get(token) : undefined
  }

  public register<TService extends object>(
    ownerModuleId: string,
    generation: number,
    token: CapabilityToken<TService>,
    service: TService,
    options: { readonly activate?: boolean } = {},
  ): KernelRegistration {
    const entries = this.entries.get(token.id) ?? new Set<ServiceEntry>()
    const duplicate = [...entries].find(
      (entry) =>
        entry.ownerModuleId !== ownerModuleId
        || entry.generation === generation,
    )
    if (isNotUndefined(duplicate)) {
      throw new KernelHostError(
        'DUPLICATE_SERVICE',
        `A service is already registered for capability "${token.id}"`,
        { moduleId: ownerModuleId, capabilityId: token.id },
      )
    }
    if (
      isNull(service)
      || (!isObject(service) && !isNull(service) && !isFunction(service))
    ) {
      throw new KernelHostError(
        'INVALID_SERVICE',
        `Service for capability "${token.id}" must be an object`,
        { moduleId: ownerModuleId, capabilityId: token.id },
      )
    }

    const entry: ServiceEntry = {
      ownerModuleId,
      generation,
      capabilityVersion: token.version,
      service,
    }
    entries.add(entry)
    this.entries.set(token.id, entries)
    if (!isFalse(options.activate)) {
      if (this.activeEntries.has(token.id)) {
        entries.delete(entry)
        if (entries.size === 0) this.entries.delete(token.id)
        throw new KernelHostError(
          'DUPLICATE_SERVICE',
          `An active service is already registered for capability "${token.id}"`,
          { moduleId: ownerModuleId, capabilityId: token.id },
        )
      }
      this.activeEntries.set(token.id, entry)
    }
    let disposed = false
    return {
      dispose: () => {
        if (disposed) return
        disposed = true
        entries.delete(entry)
        if (entries.size === 0) this.entries.delete(token.id)
        if (this.activeEntries.get(token.id) === entry) {
          this.activeEntries.delete(token.id)
        }
      },
    }
  }

  /**
   * Atomically makes one staged module generation visible to new consumers.
   *
   * Existing proxies stay bound to the previous entries and become stale on
   * their next access, while new resolutions observe only the new generation.
   */
  public activateOwner(ownerModuleId: string, generation: number): void {
    const replacements: Array<{
      readonly capabilityId: string
      readonly entry: ServiceEntry
    }> = []
    for (const [capabilityId, entries] of this.entries) {
      const entry = [...entries].find(
        (candidate) =>
          candidate.ownerModuleId === ownerModuleId
          && candidate.generation === generation,
      )
      if (isNotUndefined(entry)) replacements.push({ capabilityId, entry })
    }
    for (const replacement of replacements) {
      this.activeEntries.set(replacement.capabilityId, replacement.entry)
    }
  }

  public removeOwner(ownerModuleId: string, generation: number): void {
    for (const [capabilityId, entries] of this.entries) {
      for (const entry of entries) {
        if (
          entry.ownerModuleId === ownerModuleId
          && entry.generation === generation
        ) {
          entries.delete(entry)
          if (this.activeEntries.get(capabilityId) === entry) {
            this.activeEntries.delete(capabilityId)
          }
        }
      }
      if (entries.size === 0) this.entries.delete(capabilityId)
    }
  }

  private requireEntry(token: CapabilityToken): ServiceEntry {
    const entry = this.activeEntries.get(token.id)
    if (isUndefined(entry)) {
      throw new KernelHostError(
        'MISSING_SERVICE',
        `No service is registered for capability "${token.id}"`,
        { capabilityId: token.id },
      )
    }
    if (entry.capabilityVersion === token.version) return entry
    throw new KernelHostError(
      'VERSION_MISMATCH',
      `Capability "${token.id}" is active at version "${entry.capabilityVersion}", not "${token.version}"`,
      {
        moduleId: entry.ownerModuleId,
        capabilityId: token.id,
      },
    )
  }
}

export class ScopedKernelServiceResolver implements KernelServiceResolver {
  private readonly allowedCapabilityIds: ReadonlySet<string>

  public constructor(
    private readonly moduleId: string,
    allowedCapabilityIds: Iterable<string>,
    private readonly store: KernelServiceStore,
    private readonly assertActive: () => void,
  ) {
    this.allowedCapabilityIds = new Set(allowedCapabilityIds)
  }

  public has(token: CapabilityToken): boolean {
    this.assertActive()
    this.assertDeclared(token.id)
    return this.store.has(token)
  }

  public get<TService extends object>(
    token: CapabilityToken<TService>,
  ): TService {
    this.assertActive()
    this.assertDeclared(token.id)
    return this.store.get(token)
  }

  public getHandle<TService extends object>(
    token: CapabilityToken<TService>,
  ): KernelServiceHandle<TService> {
    this.assertActive()
    this.assertDeclared(token.id)
    return this.store.getHandle(token)
  }

  public getOptional<TService extends object>(
    token: CapabilityToken<TService>,
  ): TService | undefined {
    this.assertActive()
    this.assertDeclared(token.id)
    return this.store.getOptional(token)
  }

  private assertDeclared(capabilityId: string): void {
    if (this.allowedCapabilityIds.has(capabilityId)) return
    throw new KernelHostError(
      'UNDECLARED_CAPABILITY_ACCESS',
      `Module "${this.moduleId}" accessed undeclared capability "${capabilityId}"`,
      { moduleId: this.moduleId, capabilityId },
    )
  }
}
