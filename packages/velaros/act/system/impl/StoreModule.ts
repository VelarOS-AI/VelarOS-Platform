import type { StoreObject } from '@velaros-ai/context'
import type { OperationDefinition, OperationModuleDefinition } from '@velaros-ai/kernel'

import { capabilityModules } from '../../runtime/impl/CapabilityModules.js'
import { SystemContract } from '../contract/constants.js'
import type { StoreHost } from '../contract/requires.js'
import {
  VelarSystemStoreModule,
  VelarSystemStoreReadModule,
  VelarSystemStoreWriteModule,
} from '../contract/surface.js'

import type { StoreOperationsApi } from './StoreOperations.js'
import { storeOperations } from './StoreOperations.js'

/** 多空间共享能力，唯一模型成员按实际授权生成合同。 */
export interface StoreModuleApi {
  /** 装配创建、读写或只读投影，均复用同一实现。 */
  create(host: StoreHost, mode?: 'create' | 'write' | 'read'): OperationModuleDefinition
}

class StoreModule implements StoreModuleApi {
  public create(
    host: StoreHost,
    mode: 'create' | 'write' | 'read' = 'create'
  ): OperationModuleDefinition {
    // 读到的对象版本按「空间 + 键」登记，写入前据此核对没有被别人改过
    const reads: NonNullable<OperationDefinition['reads']> = {
      capture: async (input, value) => {
        const target = input as { store: string; key: string }
        return [
          {
            resourceId: JSON.stringify([target.store, target.key]),
            version: String((value as Nullable<StoreObject>)?.revision ?? 0),
          },
        ]
      },
      validate: async (stamp, call) =>
        stamp.version === (await host.stores(call.invocation.sessionId).version(stamp.resourceId)),
    }
    // 写操作的效果按空间事务回执核对，不重跑脚本
    const reconcile: NonNullable<OperationDefinition['reconcile']> = async (invocation, signal) => {
      signal.throwIfAborted()
      return (await host
        .stores(invocation.sessionId)
        .committed(invocation.id, (invocation.input as { store?: string }).store))
        ? {
            outcome: 'succeeded' as const,
            effect: 'committed' as const,
            evidence: '空间事务回执已持久化',
          }
        : null
    }
    return capabilityModules.create<StoreOperationsApi>({
      surface:
        mode === 'create'
          ? VelarSystemStoreModule
          : mode === 'write'
            ? VelarSystemStoreWriteModule
            : VelarSystemStoreReadModule,
      implementation: storeOperations,
      instanceId: 'standard:store',
      generation: SystemContract.generation,
      summary: '独立持久空间、结构化对象、显式共享与恢复通知',
      context: (call) => ({
        store: host.stores(call.invocation.sessionId),
        invocationId: call.invocation.id,
        abortSignal: call.signal,
      }),
      reads: { get: reads, read: reads, share: reads, set: reads, remove: reads },
      reconcile: {
        subscribe: reconcile,
        ack: reconcile,
        watch: reconcile,
        publish: reconcile,
        share: reconcile,
        set: reconcile,
        remove: reconcile,
        create: reconcile,
      },
    })
  }
}

/** 唯一 store 能力的装配实例。 */
export const storeModule: StoreModuleApi = new StoreModule()
