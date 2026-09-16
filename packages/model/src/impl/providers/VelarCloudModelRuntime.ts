import { AppError } from '@velaros-ai/core/error'

import { ModelErrorCodes, VelarCloudManagedProviderIds } from '../../contract/constants.js'
import type { VelarCloudModelRuntimeBinding } from '../../contract/requires'
import type { ChatProviderId, VelarCloudManagedProviderId } from '../../types/model'
import { trimTrailingPathSeparators } from '../../utils/urls'

/**
 * 单个宿主拥有的 Velar Cloud 连接绑定。
 *
 * 账户认证挂在宿主注入的 `fetch` 上，本包只负责按 provider 存取绑定；
 * 一个装配一份，绑定不会跨宿主泄漏。
 */
export interface VelarCloudModelRuntimeApi {
  /** 宿主登录或授权变化后注册一个托管 provider 的绑定；地址为空一律拒。 */
  registerProvider(
    providerId: VelarCloudManagedProviderId,
    binding: VelarCloudModelRuntimeBinding
  ): void
  /** 账户退出或授权被撤销时移除单个绑定；移除一个不影响另一个。 */
  unregisterProvider(providerId: VelarCloudManagedProviderId): boolean
  /** 这个托管 provider 现在连着没有。 */
  hasProvider(providerId: VelarCloudManagedProviderId): boolean
}

/** 适配器取绑定用的包内接口；宿主面不开这个方法。 */
export interface VelarCloudModelRuntimeLookup {
  /** 取一个托管 provider 的绑定；没连接时按 cloudNotConnected 抛。 */
  require(providerId?: VelarCloudManagedProviderId): VelarCloudModelRuntimeBinding
}

export class VelarCloudModelRuntime
  implements VelarCloudModelRuntimeApi, VelarCloudModelRuntimeLookup
{
  private readonly bindings = new Map<
    VelarCloudManagedProviderId,
    VelarCloudModelRuntimeBinding
  >()

  public registerProvider(
    providerId: VelarCloudManagedProviderId,
    binding: VelarCloudModelRuntimeBinding
  ): void {
    const baseURL = trimTrailingPathSeparators(binding.baseURL)
    if (!baseURL) {
      throw new AppError('VALIDATION', `${providerId} Cloud 模型服务地址不能为空。`)
    }

    this.bindings.set(providerId, {
      baseURL,
      fetch: binding.fetch,
    })
  }

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
        ModelErrorCodes.cloudNotConnected,
        providerId === 'velar-dev'
          ? 'Velar Dev 模型服务尚未连接，请先登录已授权账户。'
          : 'Velar 模型服务尚未连接，请先登录内部账户。'
      )
    }
    return binding
  }
}

/** 这个 provider 是不是由 VelarOS Cloud 托管。 */
export function isVelarCloudManagedProviderId(
  providerId: ChatProviderId
): providerId is VelarCloudManagedProviderId {
  return (VelarCloudManagedProviderIds as readonly string[]).includes(providerId)
}
