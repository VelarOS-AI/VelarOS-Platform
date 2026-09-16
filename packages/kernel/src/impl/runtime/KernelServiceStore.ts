import { isFalse, isFunction, isNotUndefined, isNull, isObject,isUndefined } from '@velaros-ai/core';

import type { CapabilityToken } from '../../types/abi-capability'
import type {
  KernelRegistration,
  KernelServiceHandle,
} from '../../types/abi-module'
import { KernelError } from '../../utils/errors'

interface ServiceEntry {
  readonly ownerModuleId: string
  readonly generation: number
  readonly capabilityVersion: string
  readonly service: object
}

export interface KernelActiveServiceSnapshot {
  readonly capabilityId: string
  readonly capabilityVersion: string
  readonly ownerModuleId: string
  readonly generation: number
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

  /** 只读、稳定排序的活动服务目录；不暴露实现对象或可调用句柄。 */
  public listActiveServices(): readonly KernelActiveServiceSnapshot[] {
    return [...this.activeEntries.entries()]
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([capabilityId, entry]) => Object.freeze({
        capabilityId,
        capabilityVersion: entry.capabilityVersion,
        ownerModuleId: entry.ownerModuleId,
        generation: entry.generation,
      }))
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
      throw new KernelError(
        'MODULE_STATE',
        `能力 "${token.id}" 第 ${entry.generation} 代的服务句柄已经过期`,
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
      throw new KernelError(
        'DUPLICATE_SERVICE',
        `能力 "${token.id}" 已经注册过服务了`,
        { moduleId: ownerModuleId, capabilityId: token.id },
      )
    }
    if (
      isNull(service)
      || (!isObject(service) && !isNull(service) && !isFunction(service))
    ) {
      throw new KernelError(
        'INVALID_SERVICE',
        `能力 "${token.id}" 的服务必须是一个对象`,
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
        throw new KernelError(
          'DUPLICATE_SERVICE',
          `能力 "${token.id}" 已经有一个活动服务了`,
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
      throw new KernelError(
        'MISSING_SERVICE',
        `能力 "${token.id}" 没有注册任何服务`,
        { capabilityId: token.id },
      )
    }
    if (entry.capabilityVersion === token.version) return entry
    throw new KernelError(
      'VERSION_MISMATCH',
      `能力 "${token.id}" 当前活动的是版本 "${entry.capabilityVersion}"，不是 "${token.version}"`,
      {
        moduleId: entry.ownerModuleId,
        capabilityId: token.id,
      },
    )
  }
}
