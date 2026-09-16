import { isBlank,isUndefined } from '@velaros-ai/core';

import type { KernelStateStore } from '../../types/abi-state'
import { KernelError } from '../../utils/errors'

export interface KernelStateBackend {
  get(namespace: string, key: string): Promise<unknown>
  set(namespace: string, key: string, value: unknown): Promise<void>
  delete(namespace: string, key: string): Promise<boolean>
  list(namespace: string, prefix?: string): Promise<readonly string[]>
}

/** Non-durable host default suitable for tests and ephemeral processes. */
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

function assertStateKey(key: string): void {
  if (!isBlank(key.trim())) return
  throw new KernelError(
    'MODULE_STATE',
    '内核模块的状态键不能为空',
  )
}

export function createNamespacedStateStore(options: {
  readonly namespace: string
  readonly backend: KernelStateBackend
  readonly assertActive: () => void
}): KernelStateStore {
  return Object.freeze({
    get: async <TValue = unknown>(key: string) => {
      options.assertActive()
      assertStateKey(key)
      return options.backend.get(options.namespace, key) as
        Promise<TValue | undefined>
    },
    set: async <TValue = unknown>(key: string, value: TValue) => {
      options.assertActive()
      assertStateKey(key)
      await options.backend.set(options.namespace, key, value)
    },
    delete: async (key: string) => {
      options.assertActive()
      assertStateKey(key)
      return options.backend.delete(options.namespace, key)
    },
    list: async (prefix?: string) => {
      options.assertActive()
      return options.backend.list(options.namespace, prefix)
    },
  })
}
