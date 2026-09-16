import { isEmpty, isPresent } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { MemoryBackendIds } from '../../contract/constants'
// 值导入指向具体模块（见 EvidenceBridge 同款注释：`from '..'` 在 dist 里是目录 import）。
import type {
  MemoryAdapterMountInput,
  MemoryStoreBackend,
} from '../../contract/requires'
import type { MemoryBackendDescriptor } from '../../types/memory'
import { listMissingAuthorityMemoryVerbs } from '../../utils/backends'
import {
  createMemoryTreeStoreBackend,
} from '../backends/MemoryTreeStoreBackend'

import type { MemoryEvidenceBridgeApi } from './MemoryEvidenceBridge'
import { MemoryEvidenceBridge } from './MemoryEvidenceBridge'
import { resolveMemoryStoreBackend } from './MemoryStoreCapabilities'
import type { MemoryTreeServiceApi } from './MemoryTreeService'
import { MemoryService } from './MemoryTreeService'
import type { MemoryTurnRecallCoordinatorApi } from './MemoryTurnRecallCoordinator'
import { MemoryTurnRecallCoordinator } from './MemoryTurnRecallCoordinator'

/**
 * 组装后的记忆适配器句柄。三端口各自的宿主接入点：
 * - `turnRecall.createTurnContextSource()` → 回合上下文源注册；
 * - `evidenceBridge` → 会话事件订阅（采集端口）；
 * - `service` → 后台整理调度生命周期 + 治理门面（供 IPC / 预热 / 收尾）。
 *
 * 实例由 `mountMemoryAdapter` 造，一个宿主进程一份。
 */
export interface MemoryAdapterApi {
  /** 树治理门面；宿主没接树档时为 null。 */
  readonly service: Nullable<MemoryTreeServiceApi>
  /** 证据采集桥：宿主把聊天与执行事件交给它。 */
  readonly evidenceBridge: MemoryEvidenceBridgeApi
  /** 回合召回协调器：后台召回与回合上下文注入。 */
  readonly turnRecall: MemoryTurnRecallCoordinatorApi
  /** 本次装配实际选中的记忆后端（采集 / 召回两端口的落点）。 */
  readonly store: MemoryStoreBackend
  /** 选中后端的自述，供宿主诊断面展示「记忆跑在哪个后端上」。 */
  readonly storeDescriptor: MemoryBackendDescriptor
  /** 是否回落到了默认树后端（未装任何后端 mod，或优先序全部落空）。 */
  readonly isDefaultStore: boolean
}

/** 记忆适配器句柄实现。 */
export class MemoryAdapterRuntime implements MemoryAdapterApi {
  public readonly service: Nullable<MemoryService>
  public readonly evidenceBridge: MemoryEvidenceBridge
  public readonly turnRecall: MemoryTurnRecallCoordinator
  /** 本次装配实际选中的记忆后端（采集 / 召回两端口的落点）。 */
  public readonly store: MemoryStoreBackend

  constructor(input: MemoryAdapterMountInput) {
    const { tree, config, hostContext } = input
    if (isPresent(input.backend) && isPresent(input.store)) {
      throw new AppError('VALIDATION', '记忆适配器只接受一个后端来源：backend 与 store 二选一。')
    }
    const selected = input.backend ?? (input.store && resolveMemoryStoreBackend(input.store))
    const store = selected ?? (tree && createMemoryTreeStoreBackend(tree.domain))
    if (!store) {
      throw new AppError('UNAVAILABLE', '记忆适配器没有权威层后端：既没传 backend，也没解析到，也没给 tree。')
    }
    const missingVerbs = listMissingAuthorityMemoryVerbs(store)
    if (store.descriptor.role !== 'authority' || !isEmpty(missingVerbs)) {
      throw new AppError(
        'VALIDATION',
        '记忆适配器要一个完整的权威层后端：角色必须是 authority，且四个必备动词一个不少。',
        undefined,
        { backendId: store.descriptor.id, missingVerbs }
      )
    }
    this.store = store

    this.turnRecall = new MemoryTurnRecallCoordinator({
      recall: (query, options) => this.store.recall(query, options),
      isEnabled: config.isEnabled,
      isSessionRecallAllowed: config.isSessionRecallAllowed,
      isAutomaticDeepRecallEnabled: config.isAutomaticDeepRecallEnabled,
      resolveScope: hostContext.resolveScope,
      turnContextScopes: hostContext.turnContextScopes,
    })

    this.evidenceBridge = new MemoryEvidenceBridge(this.store, {
      isEnabled: config.isEnabled,
      isGrowthEnabled: config.isBackgroundGrowthEnabled,
      isChatCaptureEnabled: config.isChatCaptureEnabled,
      isWorkspaceCaptureEnabled: config.isWorkspaceCaptureEnabled,
      isComputerUseCaptureEnabled: config.isComputerUseCaptureEnabled,
      isExecutionCaptureEnabled: config.isExecutionCaptureEnabled,
      isSessionCaptureAllowed: config.isSessionCaptureAllowed,
      resolveScope: hostContext.resolveScope,
      environmentContextBlockOpenTag: hostContext.environmentContextBlockOpenTag,
    })

    // 宿主可显式保留树档治理，或只挂载独立后端；后端名称不决定其它存储的生命周期。
    this.service = tree
      ? new MemoryService(tree.domain, {
          idleSignal: tree.idleSignal,
          isAutoMemoryEnabled: config.isEnabled,
          isBackgroundGrowthEnabled: config.isBackgroundGrowthEnabled,
          allowBatteryGrowth: config.allowBatteryGrowth,
        })
      : null
  }

  /** 选中后端的自述，供宿主诊断面展示「记忆跑在哪个后端上」。 */
  public get storeDescriptor(): MemoryBackendDescriptor {
    return this.store.descriptor
  }

  /** 是否回落到了默认树后端（未装任何后端 mod，或优先序全部落空）。 */
  public get isDefaultStore(): boolean {
    return this.store.descriptor.id === MemoryBackendIds.tree
  }
}

/**
 * 记忆适配器唯一组装入口。
 *
 * kernel 对 `@velaros-ai/memory` 零 import：宿主只把领域服务 + 宿主信号/配置/context 端口递进来，
 * 适配器在此把三个策略服务接线成型，返回三端口宿主接入点。Composition 的记忆粘合从三处散装
 * `new` 收敛为这一处调用。
 */
export function mountMemoryAdapter(input: MemoryAdapterMountInput): MemoryAdapterApi {
  return new MemoryAdapterRuntime(input)
}
