// 域：Agent 领域贡献注册表（两级注册机第二级的注册面）。
//
// pi 吸收规则（蓝图裁决 9 v5）落地成三条机制：
//  ① **显式注入**：贡献只经 Loader 写入，运行链一律读快照，不存在「拿到 registry 就地改」的通路。
//  ② **每轮固定 generation 快照**：`snapshot()` 返回冻结视图并带 generation；消费者按回合持有一份。
//  ③ **两阶段 + stale-reject**：写入只在 registration 阶段；快照 generation 落后即判失效
//     （`isStale` / `assertFresh`），不做「静默用旧值」。
//
// 明确不做：全局 registry 即时修改、加载顺序覆盖、giant context 注入。
import type { ToolCategoryDefinition } from '@velaros-ai/agent/protocol'

import type { ExecutionModeDescriptor } from '../execution-modes'
import type { PromptSegmentDefinition } from '../prompts'
import type {
  AgentModContributionAxisName,
  AgentModExecutionModeContribution,
  AgentModHookContribution,
  AgentModPromptSegmentContribution,
  AgentModSkillContribution,
  AgentModSpaceContribution,
  AgentModSubAgentTypeContribution,
  AgentModToolCategoryContribution,
  AgentModToolContribution,
  AgentModTurnContextSourceContribution,
} from '../protocol'
import { AgentModContributionAxisNames } from '../protocol'
import type { AgentSkillDefinition } from '../skills'
import type { SubAgentTypeDescriptor } from '../sub-agent'
import type { VelaTool } from '../tool-library'

import type { AgentModSeamHandler } from './AgentModSeams'

/** 一条贡献记录：声明（manifest 条目）+ 运行态载荷（缺席即纯数据轴）。 */
interface AgentModContributionRecord<TDeclaration = unknown, TPayload = unknown> {
  readonly axis: AgentModContributionAxisName
  readonly modId: string
  /** 轴内稳定主键（工具用 name，其余用 id）。 */
  readonly key: string
  readonly declaration: TDeclaration
  readonly payload: Nullable<TPayload>
}

/** 各轴的运行态载荷类型；纯数据轴为 `never`（payload 恒 null）。 */
interface AgentModAxisPayloadMap {
  tools: VelaTool<any, any>
  toolCategories: ToolCategoryDefinition
  promptSegments: PromptSegmentDefinition
  skills: AgentSkillDefinition
  spaces: never
  subAgentTypes: SubAgentTypeDescriptor
  turnContextSources: never
  executionModes: ExecutionModeDescriptor
  hooks: AgentModSeamHandler
}

interface AgentModAxisDeclarationMap {
  tools: AgentModToolContribution
  toolCategories: AgentModToolCategoryContribution
  promptSegments: AgentModPromptSegmentContribution
  skills: AgentModSkillContribution
  spaces: AgentModSpaceContribution
  subAgentTypes: AgentModSubAgentTypeContribution
  turnContextSources: AgentModTurnContextSourceContribution
  executionModes: AgentModExecutionModeContribution
  hooks: AgentModHookContribution
}

type AgentModAxisRecord<TAxis extends AgentModContributionAxisName> = AgentModContributionRecord<
  AgentModAxisDeclarationMap[TAxis],
  AgentModAxisPayloadMap[TAxis]
>

/** 一份按 generation 冻结的注册表投影；跨 generation 使用即 stale。 */
interface AgentModRegistrySnapshot {
  readonly generation: number
  readonly tools: ReadonlyArray<AgentModAxisRecord<'tools'>>
  readonly toolCategories: ReadonlyArray<AgentModAxisRecord<'toolCategories'>>
  readonly promptSegments: ReadonlyArray<AgentModAxisRecord<'promptSegments'>>
  readonly skills: ReadonlyArray<AgentModAxisRecord<'skills'>>
  readonly spaces: ReadonlyArray<AgentModAxisRecord<'spaces'>>
  readonly subAgentTypes: ReadonlyArray<AgentModAxisRecord<'subAgentTypes'>>
  readonly turnContextSources: ReadonlyArray<AgentModAxisRecord<'turnContextSources'>>
  readonly executionModes: ReadonlyArray<AgentModAxisRecord<'executionModes'>>
  readonly hooks: ReadonlyArray<AgentModAxisRecord<'hooks'>>
}

type AgentModRegistryPhase = 'registration' | 'runtime'

/** 快照失效（generation 已推进）；stale-reject 走它，绝不静默回退到旧值。 */
class AgentModStaleSnapshotError extends Error {
  constructor(
    public readonly snapshotGeneration: number,
    public readonly currentGeneration: number
  ) {
    super(
      `Agent mod 注册表快照已失效：快照 generation=${snapshotGeneration}，当前 generation=${currentGeneration}。`
    )
    this.name = 'AgentModStaleSnapshotError'
  }
}

class AgentModRegistry {
  private readonly axes = new Map<
    AgentModContributionAxisName,
    Map<string, AgentModContributionRecord>
  >()
  private phase: AgentModRegistryPhase = 'runtime'
  private currentGeneration = 0
  private cachedSnapshot: Nullable<AgentModRegistrySnapshot> = null

  constructor() {
    for (const axis of AgentModContributionAxisNames) this.axes.set(axis, new Map())
  }

  public get generation(): number {
    return this.currentGeneration
  }

  public getPhase(): AgentModRegistryPhase {
    return this.phase
  }

  /** 打开 registration 阶段。 */
  public beginRegistration(): void {
    this.phase = 'registration'
  }

  /** 关闭 registration 阶段并推进 generation（此前的快照全部 stale）。 */
  public endRegistration(): number {
    this.phase = 'runtime'
    this.currentGeneration += 1
    this.cachedSnapshot = null
    return this.currentGeneration
  }

  private assertRegistrationPhase(action: string): void {
    if (this.phase === 'registration') return
    throw new Error(
      `Agent mod 注册表处于运行阶段：${action} 必须发生在 registration 阶段（两阶段注册纪律）。`
    )
  }

  /** 某轴主键是否已被占用（resolve 阶段的冲突预检）。 */
  public has(axis: AgentModContributionAxisName, key: string): boolean {
    return this.axes.get(axis)?.has(key) === true
  }

  public findOwner(axis: AgentModContributionAxisName, key: string): Nullable<string> {
    return this.axes.get(axis)?.get(key)?.modId ?? null
  }

  public register<TAxis extends AgentModContributionAxisName>(
    axis: TAxis,
    record: AgentModAxisRecord<TAxis>
  ): void {
    this.assertRegistrationPhase(`注册 ${axis}/${record.key}`)
    const bucket = this.axes.get(axis)
    if (!bucket) throw new Error(`未知贡献轴：${axis}`)
    const existing = bucket.get(record.key)
    if (existing) {
      throw new Error(
        `贡献主键冲突：${axis}/${record.key} 已由 mod「${existing.modId}」占用，mod「${record.modId}」拒载。`
      )
    }
    bucket.set(record.key, Object.freeze({ ...record }) as AgentModContributionRecord)
    this.cachedSnapshot = null
  }

  /** 摘除某 mod 的全部贡献（deactivate）；返回摘除条目数。 */
  public removeMod(modId: string): number {
    this.assertRegistrationPhase(`摘除 mod「${modId}」`)
    let removed = 0
    for (const bucket of this.axes.values()) {
      for (const [key, record] of bucket) {
        if (record.modId !== modId) continue
        bucket.delete(key)
        removed += 1
      }
    }
    if (removed > 0) this.cachedSnapshot = null
    return removed
  }

  public listAxis<TAxis extends AgentModContributionAxisName>(
    axis: TAxis
  ): ReadonlyArray<AgentModAxisRecord<TAxis>> {
    const bucket = this.axes.get(axis)
    if (!bucket) return []
    return [...bucket.values()] as ReadonlyArray<AgentModAxisRecord<TAxis>>
  }

  /** 取当前 generation 的冻结快照；同一 generation 内复用同一对象。 */
  public snapshot(): AgentModRegistrySnapshot {
    if (this.cachedSnapshot) return this.cachedSnapshot
    const snapshot: AgentModRegistrySnapshot = Object.freeze({
      generation: this.currentGeneration,
      tools: Object.freeze(this.listAxis('tools')),
      toolCategories: Object.freeze(this.listAxis('toolCategories')),
      promptSegments: Object.freeze(this.listAxis('promptSegments')),
      skills: Object.freeze(this.listAxis('skills')),
      spaces: Object.freeze(this.listAxis('spaces')),
      subAgentTypes: Object.freeze(this.listAxis('subAgentTypes')),
      turnContextSources: Object.freeze(this.listAxis('turnContextSources')),
      executionModes: Object.freeze(this.listAxis('executionModes')),
      hooks: Object.freeze(this.listAxis('hooks')),
    })
    this.cachedSnapshot = snapshot
    return snapshot
  }

  public isStale(snapshot: AgentModRegistrySnapshot): boolean {
    return snapshot.generation !== this.currentGeneration
  }

  /** stale 即抛，绝不静默降级到当前值。 */
  public assertFresh(snapshot: AgentModRegistrySnapshot): void {
    if (!this.isStale(snapshot)) return
    throw new AgentModStaleSnapshotError(snapshot.generation, this.currentGeneration)
  }
}

export { AgentModRegistry, AgentModStaleSnapshotError }
export type {
  AgentModAxisDeclarationMap,
  AgentModAxisPayloadMap,
  AgentModAxisRecord,
  AgentModContributionRecord,
  AgentModRegistryPhase,
  AgentModRegistrySnapshot,
}
