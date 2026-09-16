
import type { CapabilityToken } from '../../types/abi-capability'
import type {
  KernelServiceHandle,
  KernelServiceResolver,
} from '../../types/abi-module'
import { KernelError } from '../../utils/errors'

import type { KernelServiceStore } from './KernelServiceStore'

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
    throw new KernelError(
      'UNDECLARED_CAPABILITY_ACCESS',
      `模块 "${this.moduleId}" 访问了自己没声明的能力 "${capabilityId}"`,
      { moduleId: this.moduleId, capabilityId },
    )
  }
}
