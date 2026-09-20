import { toNullable } from '@velaros-ai/core'

import type { ContextMigrationEventSink } from '../../contract/requires.js'
import type { ContextDistiller, ContextGovernanceConfig, ContextGovernanceConfigInput, ContextGovernancePresetName, ContextGovernanceSessionRegistryContract, ContextGovernanceSessionRegistryOptions, ContextHandoffSignal, ContextRecordClassifier, GovernanceEpochReport, GovernanceEpochSource } from '../../types/residency.js'
import { compareStableStrings } from '../../utils/residency/determinism'
import { ContextGovernancePresetNames, ContextGovernancePresets, resolveContextGovernanceArmName, resolveContextGovernanceConfig } from '../../utils/residency/governance-config'
import { AgentTuning } from '../../utils/tuning'

import { ContextGovernanceSession } from './ContextGovernanceSession'

/**
 * 治理会话登记处对外这一面：按会话 id 取（或新建）治理面、晚绑配置与蒸馏器、代转几个常用查询。
 *
 * 实现是 `ContextGovernanceSessionRegistry`，宿主级单实例；会话表只在内存里，超过 `maxTrackedSessions`
 * 按最近使用淘汰最旧的（`resolve` 命中会把条目挪到尾部）。编译器、召回服务和转交信号读的都是这一份状态。
 * 形状与对外公开的 `ContextGovernanceSessionRegistryApi` 同源，这里把它挪到类上方当本类的接口。
 */
export interface ContextGovernanceSessionRegistryApi extends ContextGovernanceSessionRegistryContract {
  /** 实验臂预设表：四臂同引擎，差异只在器械档位；分臂实验按名取配置。 */
  readonly presets: Readonly<Record<ContextGovernancePresetName, ContextGovernanceConfigInput>>
  /** 实验臂的名字清单，顺序固定。 */
  readonly presetNames: readonly ContextGovernancePresetName[]
  /** 认出一份治理配置对应哪个实验分臂；都不匹配返回 null。 */
  resolveArmName(config: ContextGovernanceConfig): Nullable<ContextGovernancePresetName>
  /** 与治理账本同源的稳定字符串比较：同内容必同序。 */
  compareStableStrings(left: string, right: string): number
}

/**
 * 治理会话登记处（宿主级单实例）。
 *
 * 取代 `ContextAttentionSessionRegistry` 的注入位：编译器、召回服务与转交信号消费同一份状态。
 */
export class ContextGovernanceSessionRegistry implements ContextGovernanceSessionRegistryApi {
  public readonly presets: Readonly<Record<ContextGovernancePresetName, ContextGovernanceConfigInput>> =
    ContextGovernancePresets
  public readonly presetNames: readonly ContextGovernancePresetName[] = ContextGovernancePresetNames

  private readonly sessions = new Map<string, ContextGovernanceSession>()
  private config: ContextGovernanceConfig
  private readonly classifier: Nullable<ContextRecordClassifier>
  private readonly sinkFactory: Nullable<(sessionId: string) => Nullable<ContextMigrationEventSink>>
  private readonly maxTrackedSessions: number
  private distiller: Nullable<ContextDistiller>

  public constructor(options: ContextGovernanceSessionRegistryOptions = {}) {
    this.config = resolveContextGovernanceConfig(options.config)
    this.classifier = toNullable(options.classifier)
    this.sinkFactory = toNullable(options.sinkFactory)
    this.maxTrackedSessions = options.maxTrackedSessions ?? AgentTuning.residency.maxTrackedSessions
    this.distiller = toNullable(options.distiller)
  }

  public governanceConfig(): ContextGovernanceConfig {
    return this.config
  }

  /**
   * 晚绑 I2 蒸馏器。
   *
   * 与 `configure` 的"只影响新会话"相反，蒸馏器**立刻对全部会话生效**：它不是策略参数而是能力
   * 供给，换它不改变任何阈值，也就不会让同一本账本前后半段按两套规则治理。会话持有的是解析
   * 函数（`() => this.distiller`），所以晚到的注入能穿到已存在的会话。
   */
  public setDistiller(distiller: LooseOptional<ContextDistiller>): void {
    this.distiller = toNullable(distiller)
  }

  /**
   * 晚绑治理配置（宿主的 `AgentSystemRuntimeConfig.contextGovernance` 在 run 开始时推进来）。
   *
   * registry 是宿主级单实例、比任何一次 run 都长寿，所以配置只能后到。**已存在的会话不改配置**：
   * 半程换水位会让同一本账本的前后半段按两套规则治理，epoch 报告与离线重放当场失去可比性；
   * 新配置从下一个新会话起生效，想立刻生效就 `invalidateSession`。
   */
  public configure(input: LooseOptional<ContextGovernanceConfigInput>): ContextGovernanceConfig {
    this.config = resolveContextGovernanceConfig(input)
    return this.config
  }

  /** 解析（并按需创建）会话治理器；sessionId 为空时返回 null（无身份不建状态）。 */
  public resolve(sessionId: LooseOptional<string>): Nullable<ContextGovernanceSession> {
    const key = sessionId?.trim()
    if (!key) return null

    const existing = this.sessions.get(key)
    if (existing) {
      // 命中即"最近使用"：删了再塞把它挪到 Map 尾部（Map 保插入序 = 这里的 LRU 序）。
      this.sessions.delete(key)
      this.sessions.set(key, existing)
      return existing
    }

    const created = new ContextGovernanceSession(
      this.config,
      this.classifier,
      toNullable(this.sinkFactory?.(key)),
      { resolveDistiller: () => this.distiller, sessionId: key }
    )
    this.sessions.set(key, created)
    this.evictOldestSessionsBeyondLimit()
    return created
  }

  /** 已存在才返回，不建新会话（只读查询用）。 */
  public peek(sessionId: LooseOptional<string>): Nullable<ContextGovernanceSession> {
    const key = sessionId?.trim()
    if (!key) return null

    return toNullable(this.sessions.get(key))
  }

  /** fault 记账入口：`历史检索服务` 每次取回后调用；未命中账本返回 false。 */
  public recordFault(sessionId: LooseOptional<string>, ref: string, at: number = Date.now()): boolean {
    return !!this.peek(sessionId)?.recordFault(ref, at)
  }

  /** 转交信号（B1b 的 handoff 布防数据源）。 */
  public handoffSignal(sessionId: LooseOptional<string>): Nullable<ContextHandoffSignal> {
    return toNullable(this.peek(sessionId)?.handoffSignal())
  }

  /**
   * 自动溢出恢复的强制治理入口。用 `peek` 而不是 `resolve`：从没编译过的会话没有账本，
   * 为了"压一下"凭空建一本空账本只会产出一份没有信息的报告。
   */
  public requestEpoch(
    sessionId: LooseOptional<string>,
    input: {
      at?: LooseOptional<number>
      modelWindowTokens?: LooseOptional<number>
      /** 字符/token 密度；缺席时会话回落到最近一次编译期实测的量纲。 */
      charsPerToken?: LooseOptional<number>
      source?: LooseOptional<GovernanceEpochSource>
    } = {}
  ): Nullable<GovernanceEpochReport> {
    return toNullable(
      this.peek(sessionId)?.requestEpoch({
        at: input.at ?? Date.now(),
        modelWindowTokens: input.modelWindowTokens,
        charsPerToken: input.charsPerToken,
        source: input.source,
      })
    )
  }

  /** 最近若干次 epoch 报告（scoreboard / 调试面数据源）。 */
  public epochReports(sessionId: LooseOptional<string>): readonly GovernanceEpochReport[] {
    return this.peek(sessionId)?.epochReports() ?? []
  }

  /** 硬失效通道：会话重置 / handoff / 清空时丢弃全部治理状态。 */
  public invalidateSession(sessionId: LooseOptional<string>): void {
    const key = sessionId?.trim()
    if (key) this.sessions.delete(key)
  }

  /**
   * 容量淘汰：按 Map 插入序（= LRU 序，`resolve` 命中时会把条目挪到尾部）从头删。
   *
   * 原实现按 `updatedAt` 升序删，而新建会话的 `updatedAt` 是 0（只有 `syncHistory` 才赋值），
   * 于是满员之后**每次都把刚建的那个当场删掉**：它这一轮还能用（`resolve` 返回的是对象本身），
   * 下一轮 peek 不到又重建一个，账本每轮从零开始，老的 128 个反而永远淘汰不掉（审计 V7）。
   * 换成插入序就不需要任何时钟：刚建的条目恒在尾部，结构上不可能被本次淘汰选中。
   */
  private evictOldestSessionsBeyondLimit(): void {
    if (this.sessions.size <= this.maxTrackedSessions) return

    const overflow = this.sessions.size - this.maxTrackedSessions
    const oldestFirst = [...this.sessions.keys()].slice(0, overflow)
    for (const sessionId of oldestFirst) this.sessions.delete(sessionId)
  }

  public resolveArmName(config: ContextGovernanceConfig): Nullable<ContextGovernancePresetName> {
    return resolveContextGovernanceArmName(config)
  }

  public compareStableStrings(left: string, right: string): number {
    return compareStableStrings(left, right)
  }
}

/** 建一份上下文治理的会话登记处：每个会话的驻留账本与压缩进度都挂在它身上。 */
export function createContextGovernanceSessionRegistry(options: ContextGovernanceSessionRegistryOptions = {}): ContextGovernanceSessionRegistryApi {
  return new ContextGovernanceSessionRegistry(options)
}
