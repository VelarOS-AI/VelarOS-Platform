import { AppError } from '@velaros-ai/core/error'

import type { ChatProviderId } from './ModelContracts'

export const VelarCloudManagedProviderIds = [
  'velar',
  'velar-dev',
] as const satisfies readonly ChatProviderId[]

export type VelarCloudManagedProviderId = (typeof VelarCloudManagedProviderIds)[number]

export function isVelarCloudManagedProviderId(
  providerId: ChatProviderId
): providerId is VelarCloudManagedProviderId {
  return (VelarCloudManagedProviderIds as readonly ChatProviderId[]).includes(providerId)
}

export interface VelarCloudModelRuntimeBinding {
  readonly baseURL: string
  readonly fetch: typeof fetch
}

/**
 * 单个宿主拥有的 Velar Cloud 连接绑定。
 */
export class VelarCloudModelRuntime {
  private readonly bindings = new Map<
    VelarCloudManagedProviderId,
    VelarCloudModelRuntimeBinding
  >()

  /** @deprecated 新宿主应使用 registerProvider；此入口始终只绑定原有 Velar。 */
  public register(binding: VelarCloudModelRuntimeBinding): void {
    this.registerProvider('velar', binding)
  }

  public registerProvider(
    providerId: VelarCloudManagedProviderId,
    binding: VelarCloudModelRuntimeBinding
  ): void {
    const baseURL = binding.baseURL.trim().replace(/\/+$/u, '')
    if (!baseURL) {
      throw new AppError('VALIDATION', `${providerId} Cloud 模型服务地址不能为空。`)
    }

    this.bindings.set(providerId, {
      baseURL,
      fetch: binding.fetch,
    })
  }

  /**
   * 在账户退出或授权被撤销时移除单个服务绑定。
   *
   * 每个 provider 独立删除；移除 Velar Dev 不会断开原有 Velar，反之亦然。
   */
  public unregisterProvider(providerId: VelarCloudManagedProviderId): boolean {
    return this.bindings.delete(providerId)
  }

  public hasProvider(providerId: VelarCloudManagedProviderId): boolean {
    return this.bindings.has(providerId)
  }

  public require(providerId: VelarCloudManagedProviderId = 'velar'): VelarCloudModelRuntimeBinding {
    const binding = this.bindings.get(providerId)
    if (!binding?.baseURL) {
      throw new AppError(
        'UNAVAILABLE',
        providerId === 'velar-dev'
          ? 'Velar Dev 模型服务尚未连接，请先登录已授权账户。'
          : 'Velar 模型服务尚未连接，请先登录内部账户。'
      )
    }
    return binding
  }
}

/**
 * @deprecated 仅为 0.4.x 直接消费者保留。新的 composition 使用自己的
 * `ModelRuntimeComposition.velarCloudRuntime`，不会读取该兼容实例。
 */
export const velarCloudModelRuntime = new VelarCloudModelRuntime()
