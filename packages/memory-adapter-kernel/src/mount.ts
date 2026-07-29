import type { MemoryDomain } from '@velaros-ai/memory'

import { MemoryEvidenceBridge } from './EvidenceBridge'
import type { MemoryHostScopeResolver } from './HostContracts'
import type { HostIdleSignalPort } from './HostSignals'
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
}

/** Host composition supplies product context→Memory scope mapping. */
export interface MemoryAdapterHostContextPort {
  resolveScope: MemoryHostScopeResolver
  turnContextScopes: readonly string[]
  environmentContextBlockOpenTag?: string
}

export interface MountMemoryAdapterInput {
  /** 记忆树领域服务（`@velaros-ai/memory` 的 MemoryDomain）。 */
  domain: MemoryDomain
  /** 宿主空闲信号端口（Desktop 由 Electron 实现，headless 可注入常量实现）。 */
  idleSignal: HostIdleSignalPort
  config: MemoryAdapterConfigPort
  hostContext: MemoryAdapterHostContextPort
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

  constructor(input: MountMemoryAdapterInput) {
    const { domain, idleSignal, config, hostContext } = input

    this.turnRecall = new MemoryTurnRecallCoordinator({
      recall: (query, options) => domain.recall(query, options),
      isEnabled: config.isEnabled,
      isAutomaticDeepRecallEnabled: config.isAutomaticDeepRecallEnabled,
      resolveScope: hostContext.resolveScope,
      turnContextScopes: hostContext.turnContextScopes,
    })

    this.evidenceBridge = new MemoryEvidenceBridge(domain, {
      isEnabled: config.isEnabled,
      isGrowthEnabled: config.isBackgroundGrowthEnabled,
      isChatCaptureEnabled: config.isChatCaptureEnabled,
      isWorkspaceCaptureEnabled: config.isWorkspaceCaptureEnabled,
      isComputerUseCaptureEnabled: config.isComputerUseCaptureEnabled,
      isExecutionCaptureEnabled: config.isExecutionCaptureEnabled,
      resolveScope: hostContext.resolveScope,
      environmentContextBlockOpenTag: hostContext.environmentContextBlockOpenTag,
    })

    this.service = new MemoryService(domain, {
      idleSignal,
      isAutoMemoryEnabled: config.isEnabled,
      isBackgroundGrowthEnabled: config.isBackgroundGrowthEnabled,
      allowBatteryGrowth: config.allowBatteryGrowth,
    })
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
