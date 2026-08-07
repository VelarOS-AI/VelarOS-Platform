import type { MemoryDomain } from '..'
// 值导入指向具体模块（见 EvidenceBridge 同款注释：`from '..'` 在 dist 里是目录 import）。
import type {
  MemoryBackendDescriptor,
  MemoryStoreBackend,
} from '../backend/Contract'
import {
  createMemoryTreeStoreBackend,
  MemoryTreeBackendId,
} from '../backend/TreeStoreBackend'

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
 * 递进来，适配器经 `velaros.memory.store.<id>` token 解析出该用哪个后端。**不传即默认**：
 * 回落到把 `domain` 包成的树后端，与 token 未引入前逐字等价。
 */
export interface MemoryAdapterStorePort {
  readonly registry: MemoryStoreCapabilityRegistry
  /** 后端 id 优先序，首个已注册的胜出（如 `['files', 'tree']`）。 */
  readonly preference: readonly string[]
  readonly capabilityVersion?: string
}

export interface MountMemoryAdapterInput {
  /**
   * 记忆树领域服务（`@velaros-ai/memory` 的 MemoryDomain）。
   *
   * 它同时是**默认已注册后端**的来源与树档治理面（warmup / Dream 调度 / 树版本）的持有者。
   * TODO(批三)：权威层迁到 `memory-files` 后本字段变可选——files-only 宿主不该被迫开一个
   * SQLite 记忆树。
   */
  domain: MemoryDomain
  /** 宿主空闲信号端口（Desktop 由 Electron 实现，headless 可注入常量实现）。 */
  idleSignal: HostIdleSignalPort
  config: MemoryAdapterConfigPort
  hostContext: MemoryAdapterHostContextPort
  /** 可选：经 capability token 解析后端。缺席时用 `domain` 包成的默认树后端。 */
  store?: MemoryAdapterStorePort
}

/**
 * 组装后的记忆适配器句柄。三端口各自的宿主接入点：
 * - `turnRecall.createTurnContextSource()` → turn-context 源注册；
 * - `evidenceBridge` → 会话事件订阅（capture 端口）；
 * - `service` → Dream 调度生命周期 + 治理门面（供 IPC/warmup/close）。
 */
export class MemoryAdapterRuntime {
  public readonly service: MemoryService
  public readonly evidenceBridge: MemoryEvidenceBridge
  public readonly turnRecall: MemoryTurnRecallCoordinator
  /** 本次装配实际选中的记忆后端（capture / recall 两端口的落点）。 */
  public readonly store: MemoryStoreBackend

  constructor(input: MountMemoryAdapterInput) {
    const { domain, idleSignal, config, hostContext } = input

    // 「默认已注册后端」：既有树领域服务原样包成后端，每个动词逐字转发 → 行为零变化。
    const defaultStore = createMemoryTreeStoreBackend(domain)
    this.store = (
      input.store === undefined
        ? undefined
        : resolveMemoryStoreBackend({
            registry: input.store.registry,
            preference: input.store.preference,
            capabilityVersion: input.store.capabilityVersion,
          })
    ) ?? defaultStore

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

    // 树档自己的治理面（warmup / Dream 调度 / 树版本 / 完整性校验）仍直连 domain：那是
    // `memory-tree` 档的生命周期，不属于后端无关的窄端口。files-only 宿主不需要它。
    this.service = new MemoryService(domain, {
      idleSignal,
      isAutoMemoryEnabled: config.isEnabled,
      isBackgroundGrowthEnabled: config.isBackgroundGrowthEnabled,
      allowBatteryGrowth: config.allowBatteryGrowth,
    })
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
