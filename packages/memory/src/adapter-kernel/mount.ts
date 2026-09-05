import { isEmpty, isPresent } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

// 值导入指向具体模块（见 EvidenceBridge 同款注释：`from '..'` 在 dist 里是目录 import）。
import {
  listMissingAuthorityMemoryVerbs,
  type MemoryBackendDescriptor,
  type MemoryStoreBackend,
} from '../backend/Contract'
import {
  createMemoryTreeStoreBackend,
  MemoryTreeBackendId,
} from '../backend/TreeStoreBackend'
import type { MemoryDomain } from '../index'

import { MemoryEvidenceBridge } from './EvidenceBridge'
import type { MemoryHostScopeResolver } from './HostContracts'
import type { HostIdleSignalPort } from './HostSignals'
import {
  type MemoryStoreCapabilityRegistry,
  resolveMemoryStoreBackend,
} from './MemoryStoreCapability'
import { MemoryService } from './Service'
import { MemoryTurnRecallCoordinator } from './TurnRecallCoordinator'

/**
 * 记忆采集/召回/整理的宿主配置读数端口。
 *
 * 三个策略服务原先各自在 Composition 内联接线宿主配置；组装入口把这些读数收成单一端口，
 * 由 mount 内部分派到各服务需要的选项形状——kernel 侧只声明「记忆要读哪些开关」，不知道
 * 记忆内部把它们喂给了 capture 还是 dream。
 */
export interface MemoryAdapterConfigPort {
  /** 自动记忆总开关（采集 + 召回 + 整理的顶层门）。 */
  isEnabled: () => boolean
  /** 后台生长开关（即时整理与空闲整理的门）。 */
  isBackgroundGrowthEnabled: () => boolean
  /** 是否允许电池供电下也跑积压整理。 */
  allowBatteryGrowth: () => boolean
  /** 普通召回无果时是否自动降级深层召回。 */
  isAutomaticDeepRecallEnabled: () => boolean
  /** 聊天消息采集开关。 */
  isChatCaptureEnabled: () => boolean
  /** 工作区工具观测采集开关。 */
  isWorkspaceCaptureEnabled: () => boolean
  /** Computer Use 观测采集开关。 */
  isComputerUseCaptureEnabled: () => boolean
  /** 执行生命周期采集开关。 */
  isExecutionCaptureEnabled: () => boolean
  /** 单条会话的采集豁免；缺席 = 不豁免（与四个类别开关并列求合取）。 */
  isSessionCaptureAllowed?: (sessionId: string) => boolean
}

/** Host composition supplies product context→Memory scope mapping. */
export interface MemoryAdapterHostContextPort {
  resolveScope: MemoryHostScopeResolver
  turnContextScopes: readonly string[]
  environmentContextBlockOpenTag?: string
}

/**
 * 后端解析端口（kernel-contract §15.7 裁决二）。
 *
 * 宿主把进程内 `KernelModuleHost`（结构上满足 `MemoryStoreCapabilityRegistry`）与后端优先序
 * 递进来，适配器经 `velaros.memory.store.<id>` token 解析出该用哪个后端。
 * 显式提供 tree 时，未解析到后端会使用该树；独立后端宿主缺少权威层则明确拒绝装配。
 */
export interface MemoryAdapterStorePort {
  readonly registry: MemoryStoreCapabilityRegistry
  /** 后端 id 优先序，首个已注册的胜出（如 `['files', 'tree']`）。 */
  readonly preference: readonly string[]
  readonly capabilityVersion?: string
}

/** Tree lifecycle is an explicit host choice, independent of the selected authority backend. */
export interface MemoryAdapterTreePort {
  domain: MemoryDomain
  idleSignal: HostIdleSignalPort
}

export interface MountMemoryAdapterInput {
  /** 已完成权威层/派生索引装配的后端，与 store 解析端口互斥。 */
  backend?: MemoryStoreBackend
  /** 树治理的显式接入；缺席时不创建 warmup / Dream / idle signal 生命周期。 */
  tree?: MemoryAdapterTreePort
  config: MemoryAdapterConfigPort
  hostContext: MemoryAdapterHostContextPort
  /** 经 capability token 解析后端；未选中时仅允许回落显式提供的 tree。 */
  store?: MemoryAdapterStorePort
}

/**
 * 组装后的记忆适配器句柄。三端口各自的宿主接入点：
 * - `turnRecall.createTurnContextSource()` → turn-context 源注册；
 * - `evidenceBridge` → 会话事件订阅（capture 端口）；
 * - `service` → Dream 调度生命周期 + 治理门面（供 IPC/warmup/close）。
 */
export class MemoryAdapterRuntime {
  public readonly service: Nullable<MemoryService>
  public readonly evidenceBridge: MemoryEvidenceBridge
  public readonly turnRecall: MemoryTurnRecallCoordinator
  /** 本次装配实际选中的记忆后端（capture / recall 两端口的落点）。 */
  public readonly store: MemoryStoreBackend

  constructor(input: MountMemoryAdapterInput) {
    const { tree, config, hostContext } = input
    if (isPresent(input.backend) && isPresent(input.store)) {
      throw new AppError('VALIDATION', 'Memory adapter requires one backend selection source.')
    }
    const selected = input.backend ?? (input.store && resolveMemoryStoreBackend(input.store))
    const store = selected ?? (tree && createMemoryTreeStoreBackend(tree.domain))
    if (!store) {
      throw new AppError('UNAVAILABLE', 'Memory adapter has no authority backend.')
    }
    const missingVerbs = listMissingAuthorityMemoryVerbs(store)
    if (store.descriptor.role !== 'authority' || !isEmpty(missingVerbs)) {
      throw new AppError(
        'VALIDATION',
        'Memory adapter requires a complete authority backend.',
        undefined,
        { backendId: store.descriptor.id, missingVerbs }
      )
    }
    this.store = store

    this.turnRecall = new MemoryTurnRecallCoordinator({
      recall: (query, options) => this.store.recall(query, options),
      isEnabled: config.isEnabled,
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
    return this.store.descriptor.id === MemoryTreeBackendId
  }
}

export type MemoryAdapterMount = MemoryAdapterRuntime

/**
 * 记忆适配器唯一组装入口。
 *
 * kernel 对 `@velaros-ai/memory` 零 import：宿主只把领域服务 + 宿主信号/配置/context 端口递进来，
 * 适配器在此把三个策略服务接线成型，返回三端口宿主接入点。Composition 的记忆粘合从三处散装
 * `new` 收敛为这一处调用。
 */
export function mountMemoryAdapter(input: MountMemoryAdapterInput): MemoryAdapterMount {
  return new MemoryAdapterRuntime(input)
}
