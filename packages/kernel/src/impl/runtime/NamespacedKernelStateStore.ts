import { isBlank } from '@velaros-ai/core'

import { KernelErrorCodes } from '../../contract/constants'
import type { NamespacedKernelStateStoreOptions } from '../../types/runtime'
import { KernelError } from '../../utils/errors'

/**
 * 一个模块看到的状态面。
 *
 * 命名空间由宿主绑死，模块寻址不到别的模块的状态；上下文失效之后任何读写都被拦住。
 */
export interface KernelStateStore {
  /** 读一个键；没有就是 undefined。 */
  get<TValue = unknown>(key: string): Promise<TValue | undefined>
  /** 写一个键。 */
  set<TValue = unknown>(key: string, value: TValue): Promise<void>
  /** 删一个键；返回原来有没有这个键。 */
  delete(key: string): Promise<boolean>
  /** 列出本模块命名空间下的键，可以按前缀过滤。 */
  list(prefix?: string): Promise<readonly string[]>
}

export class NamespacedKernelStateStore implements KernelStateStore {
  public constructor(
    private readonly options: NamespacedKernelStateStoreOptions,
  ) {}

  public async get<TValue = unknown>(key: string): Promise<TValue | undefined> {
    this.assertUsable(key)
    return this.options.backend.get(this.options.namespace, key) as
      Promise<TValue | undefined>
  }

  public async set<TValue = unknown>(key: string, value: TValue): Promise<void> {
    this.assertUsable(key)
    await this.options.backend.set(this.options.namespace, key, value)
  }

  public async delete(key: string): Promise<boolean> {
    this.assertUsable(key)
    return this.options.backend.delete(this.options.namespace, key)
  }

  public async list(prefix?: string): Promise<readonly string[]> {
    this.options.assertActive()
    return this.options.backend.list(this.options.namespace, prefix)
  }

  /** 上下文还有效吗、键是不是空的；两条都过了才往后端走。 */
  private assertUsable(key: string): void {
    this.options.assertActive()
    if (isBlank(key.trim())) {
      throw new KernelError(
        KernelErrorCodes.moduleState,
        '内核模块的状态键不能为空',
      )
    }
  }
}
