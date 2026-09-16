// 域：Agent 领域贡献注册表（两级注册机第二级的注册面）。
//
// pi 吸收规则（蓝图裁决 9 v5）落地成三条机制：
//  ① **显式注入**：贡献只经 Loader 写入，运行链一律读快照，不存在「拿到 registry 就地改」的通路。
//  ② **每轮固定 generation 快照**：`snapshot()` 返回冻结视图并带 generation；消费者按回合持有一份。
//  ③ **两阶段 + stale-reject**：写入只在 registration 阶段；快照 generation 落后即判失效
//     （`isStale` / `assertFresh`），不做「静默用旧值」。
//
// 明确不做：全局 registry 即时修改、加载顺序覆盖、giant context 注入。
import { isTrue,toNullable } from '@velaros-ai/core'

import type { AgentModContributionAxisName } from '../../types/agent.js'
import type { AgentModAxisRecord, AgentModContributionRecord, AgentModRegistryPhase, AgentModRegistrySnapshot } from '../../types/mods.js'
import { AgentModContributionAxisNames } from '../../utils/wire/mods'
import { AgentModStaleSnapshotError } from '../errors/AgentModStaleSnapshotError'



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
    return isTrue(this.axes.get(axis)?.has(key))
  }

  public findOwner(axis: AgentModContributionAxisName, key: string): Nullable<string> {
    return toNullable(this.axes.get(axis)?.get(key)?.modId)
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

export { AgentModRegistry }