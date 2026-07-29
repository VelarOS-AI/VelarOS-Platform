import { AppError } from '@velaros-ai/core/error'

export interface VelarCloudModelRuntimeBinding {
  readonly baseURL: string
  readonly fetch: typeof fetch
}

/**
 * 单个宿主拥有的 Velar Cloud 连接绑定。
 */
export class VelarCloudModelRuntime {
  private binding: Nullable<VelarCloudModelRuntimeBinding> = null

  public register(binding: VelarCloudModelRuntimeBinding): void {
    this.binding = {
      baseURL: binding.baseURL.replace(/\/$/u, ''),
      fetch: binding.fetch,
    }
  }

  public require(): VelarCloudModelRuntimeBinding {
    if (!this.binding?.baseURL) {
      throw new AppError('UNAVAILABLE', 'Velar 模型服务尚未连接，请先登录内部账户。')
    }
    return this.binding
  }
}

/**
 * @deprecated 仅为 0.4.x 直接消费者保留。新的 composition 使用自己的
 * `ModelRuntimeComposition.velarCloudRuntime`，不会读取该兼容实例。
 */
export const velarCloudModelRuntime = new VelarCloudModelRuntime()
