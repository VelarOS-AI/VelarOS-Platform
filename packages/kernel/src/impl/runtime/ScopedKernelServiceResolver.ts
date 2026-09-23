import { KernelErrorCodes } from '../../contract/constants'
import type { KernelServiceHandle } from '../../contract/provides'
import type { CapabilityToken } from '../../types/kernel.js'
import { KernelError } from '../../utils/errors'

import type { KernelServiceStore } from './KernelServiceStore'

/**
 * 一个模块看到的服务视图。
 *
 * 只解析得到本模块清单里声明过的能力（provides / requires / optionalRequires）；没声明过的一律
 * 抛 `UNDECLARED_CAPABILITY_ACCESS`。上下文失效之后任何解析都被 `assertActive` 拦住。
 */
export interface KernelServiceResolver {
  /** 这件能力现在有没有活动服务；没声明过就抛。 */
  has(token: CapabilityToken): boolean
  /** 取服务；没有或版本对不上时抛。 */
  get<TService extends object>(token: CapabilityToken<TService>): TService
  /** 取服务句柄；句柄绑死在取的那一代，换代之后失效。 */
  getHandle<TService extends object>(
    token: CapabilityToken<TService>
  ): KernelServiceHandle<TService>
  /** 取服务，没有就返回 undefined，不抛错；没声明过这件能力仍然抛。 */
  getOptional<TService extends object>(token: CapabilityToken<TService>): TService | undefined
}

export class ScopedKernelServiceResolver implements KernelServiceResolver {
  private readonly allowedCapabilityIds: ReadonlySet<string>

  public constructor(
    private readonly moduleId: string,
    allowedCapabilityIds: Iterable<string>,
    private readonly store: KernelServiceStore,
    private readonly assertActive: () => void
  ) {
    this.allowedCapabilityIds = new Set(allowedCapabilityIds)
  }

  public has(token: CapabilityToken): boolean {
    this.assertActive()
    this.assertDeclared(token.id)
    return this.store.has(token)
  }

  public get<TService extends object>(token: CapabilityToken<TService>): TService {
    this.assertActive()
    this.assertDeclared(token.id)
    return this.store.get(token)
  }

  public getHandle<TService extends object>(
    token: CapabilityToken<TService>
  ): KernelServiceHandle<TService> {
    this.assertActive()
    this.assertDeclared(token.id)
    return this.store.getHandle(token)
  }

  public getOptional<TService extends object>(
    token: CapabilityToken<TService>
  ): TService | undefined {
    this.assertActive()
    this.assertDeclared(token.id)
    return this.store.getOptional(token)
  }

  /** 这件能力在本模块清单里声明过吗；没有就抛 `UNDECLARED_CAPABILITY_ACCESS`。 */
  private assertDeclared(capabilityId: string): void {
    if (this.allowedCapabilityIds.has(capabilityId)) return
    throw new KernelError(
      KernelErrorCodes.undeclaredCapabilityAccess,
      `模块 "${this.moduleId}" 访问了自己没声明的能力 "${capabilityId}"`,
      { moduleId: this.moduleId, capabilityId }
    )
  }
}
