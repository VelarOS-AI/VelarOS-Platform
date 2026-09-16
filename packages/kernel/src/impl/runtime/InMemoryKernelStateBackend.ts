import { isUndefined } from '@velaros-ai/core'

/**
 * 宿主没注入持久化时的默认模块状态后端：只活在本进程内存里。
 *
 * 由 `KernelModuleHost` 在宿主没给 `stateBackend` 时自己 new 一份；测试与短命进程够用，
 * 要跨进程留存就由宿主注入自己的实现。
 */
export interface KernelStateBackend {
  /** 读一个命名空间下的键。 */
  get(namespace: string, key: string): Promise<unknown>
  /** 写一个命名空间下的键。 */
  set(namespace: string, key: string, value: unknown): Promise<void>
  /** 删一个命名空间下的键；返回原来有没有这个键。 */
  delete(namespace: string, key: string): Promise<boolean>
  /** 列出一个命名空间下的键，可以按前缀过滤，结果按字典序排好。 */
  list(namespace: string, prefix?: string): Promise<readonly string[]>
}

export class InMemoryKernelStateBackend implements KernelStateBackend {
  private readonly namespaces = new Map<string, Map<string, unknown>>()

  public async get(namespace: string, key: string): Promise<unknown> {
    return this.namespaces.get(namespace)?.get(key)
  }

  public async set(
    namespace: string,
    key: string,
    value: unknown,
  ): Promise<void> {
    const state = this.namespaces.get(namespace) ?? new Map()
    if (!this.namespaces.has(namespace)) this.namespaces.set(namespace, state)
    state.set(key, value)
  }

  public async delete(namespace: string, key: string): Promise<boolean> {
    return !!this.namespaces.get(namespace)?.delete(key)
  }

  public async list(
    namespace: string,
    prefix?: string,
  ): Promise<readonly string[]> {
    const keys = [...(this.namespaces.get(namespace)?.keys() ?? [])]
    return keys
      .filter((key) => isUndefined(prefix) || key.startsWith(prefix))
      .sort()
  }
}
