import {
  isFalse,
  isFunction,
  isNotUndefined,
  isNull,
  isObject,
  isUndefined,
} from '@velaros-ai/core'

import { KernelErrorCodes } from '../../contract/constants'
import type { KernelRegistration, KernelServiceHandle } from '../../contract/provides'
import type { CapabilityToken } from '../../types/kernel.js'
import type { KernelActiveServiceSnapshot } from '../../types/runtime'
import type { ServiceEntry } from '../../types/runtime'
import { KernelError } from '../../utils/errors'

/**
 * 能力到活动服务的登记表：谁提供、哪一代、哪个版本，由它一处说了算。
 *
 * 实例由 `KernelModuleHost` 持一份；模块拿到的是收窄过的 {@link KernelServiceResolver}。
 */
export interface KernelServiceStoreApi {
  /** 这枚令牌（id 与版本都要对得上）现在有没有活动服务。 */
  has(token: CapabilityToken): boolean
  /** 把能力 id 解析成当前活动提供方的那一枚令牌；没有活动提供方就返回 undefined。 */
  getActiveToken(capabilityId: string): CapabilityToken | undefined
  /** 只读、稳定排序的活动服务目录；不暴露实现对象或可调用句柄。 */
  listActiveServices(): readonly KernelActiveServiceSnapshot[]
  /** 取服务；没注册或版本对不上时抛。 */
  get<TService extends object>(token: CapabilityToken<TService>): TService
  /** 取服务句柄；句柄绑死在取的那一代，换代之后再用就抛。 */
  getHandle<TService extends object>(
    token: CapabilityToken<TService>
  ): KernelServiceHandle<TService>
  /** 取服务，没有就返回 undefined，不抛错。 */
  getOptional<TService extends object>(token: CapabilityToken<TService>): TService | undefined
  /** 登记一条服务；`activate` 为 false 时先暂存不可见（替换模块时用）。 */
  register<TService extends object>(
    ownerModuleId: string,
    generation: number,
    token: CapabilityToken<TService>,
    service: TService,
    options?: { readonly activate?: boolean }
  ): KernelRegistration
  /** 把某个模块某一代暂存的服务一次性切成可见；旧句柄在下次访问时失效。 */
  activateOwner(ownerModuleId: string, generation: number): void
  /** 摘掉某个模块某一代登记的全部服务。 */
  removeOwner(ownerModuleId: string, generation: number): void
}

export class KernelServiceStore implements KernelServiceStoreApi {
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
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([capabilityId, entry]) =>
        Object.freeze({
          capabilityId,
          capabilityVersion: entry.capabilityVersion,
          ownerModuleId: entry.ownerModuleId,
          generation: entry.generation,
        })
      )
  }

  public get<TService extends object>(token: CapabilityToken<TService>): TService {
    return this.getHandle(token).get()
  }

  public getHandle<TService extends object>(
    token: CapabilityToken<TService>
  ): KernelServiceHandle<TService> {
    const entry = this.requireEntry(token)
    let proxy: TService | undefined
    const assertActive = () => {
      if (this.activeEntries.get(token.id) === entry) return
      throw new KernelError(
        KernelErrorCodes.moduleState,
        `能力 "${token.id}" 第 ${entry.generation} 代的服务句柄已经过期`,
        {
          moduleId: entry.ownerModuleId,
          capabilityId: token.id,
        }
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
            const value = Reflect.get(entry.service, property, entry.service) as unknown
            if (!isFunction(value)) return value
            return (...arguments_: unknown[]) => {
              assertActive()
              return Reflect.apply(value, entry.service, arguments_)
            }
          },
          set: (_target, property, value) => {
            assertActive()
            return Reflect.set(entry.service, property, value, entry.service)
          },
        }) as TService
        return proxy
      },
    })
  }

  public getOptional<TService extends object>(
    token: CapabilityToken<TService>
  ): TService | undefined {
    return this.has(token) ? this.get(token) : undefined
  }

  public register<TService extends object>(
    ownerModuleId: string,
    generation: number,
    token: CapabilityToken<TService>,
    service: TService,
    options: { readonly activate?: boolean } = {}
  ): KernelRegistration {
    const entries = this.entries.get(token.id) ?? new Set<ServiceEntry>()
    const duplicate = [...entries].find(
      (entry) => entry.ownerModuleId !== ownerModuleId || entry.generation === generation
    )
    if (isNotUndefined(duplicate)) {
      throw new KernelError(
        KernelErrorCodes.duplicateService,
        `能力 "${token.id}" 已经注册过服务了`,
        { moduleId: ownerModuleId, capabilityId: token.id }
      )
    }
    if (isNull(service) || (!isObject(service) && !isNull(service) && !isFunction(service))) {
      throw new KernelError(
        KernelErrorCodes.invalidService,
        `能力 "${token.id}" 的服务必须是一个对象`,
        { moduleId: ownerModuleId, capabilityId: token.id }
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
          KernelErrorCodes.duplicateService,
          `能力 "${token.id}" 已经有一个活动服务了`,
          { moduleId: ownerModuleId, capabilityId: token.id }
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
          candidate.ownerModuleId === ownerModuleId && candidate.generation === generation
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
        if (entry.ownerModuleId === ownerModuleId && entry.generation === generation) {
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
        KernelErrorCodes.missingService,
        `能力 "${token.id}" 没有注册任何服务`,
        { capabilityId: token.id }
      )
    }
    if (entry.capabilityVersion === token.version) return entry
    throw new KernelError(
      KernelErrorCodes.versionMismatch,
      `能力 "${token.id}" 当前活动的是版本 "${entry.capabilityVersion}"，不是 "${token.version}"`,
      {
        moduleId: entry.ownerModuleId,
        capabilityId: token.id,
      }
    )
  }
}
