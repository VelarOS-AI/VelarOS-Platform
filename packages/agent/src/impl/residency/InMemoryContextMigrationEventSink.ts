/**
 * 驻留迁移事件日志（上下文治理 v2 · P8 测量原生）。
 *
 * 每一次驻留态变化都是一条带**因果**与**token 差**的事件。这条流有三个下游：
 *  ① 可观测：任何时刻能回答"这条记录现在为什么在/不在上下文里"（v1 五条压缩路径谁都答不了）；
 *  ② 离线重放：真实账本 + 事件流 → 策略反事实实验，零 app 成本调参（B4）；
 *  ③ 学习信号：fault 事件（召回命中非 INLINE 记录）进准入与 epoch 排序的分数。
 *
 * 落盘端口而不是落盘实现：agent 包 host 无关，写文件是宿主的事。本文件只负责把事件序列化成
 * **确定性 JSONL**（键排序），交给注入的行写入器。
 */

import type { ContextMigrationEventSink } from '../../contract/requires.js'
import type { ContextFaultEvent, ContextResidencyMigrationEvent } from '../../types/residency.js'

/**
 * 内存版的迁移事件汇：`ContextMigrationEventSink` 端口的全部方法，外加三个把事件读回来的口子。
 *
 * 实现是 `InMemoryContextMigrationEventSink`，测试、离线重放和 headless 实验各自新建一个；事件只堆在数组里，
 * 不落盘、不设上限，跑久了会一直涨——所以它只用于这三个短生命周期场景，产线那条是 `JsonlContextMigrationEventSink`。
 */
export interface InMemoryContextMigrationEventSinkApi extends ContextMigrationEventSink {
  /** 按记录顺序取回攒下的全部迁移事件；返回的是内部数组本身的只读视图，别存着它跨 `clear` 用。 */
  listMigrations(): readonly ContextResidencyMigrationEvent[]
  /** 按记录顺序取回攒下的全部 fault 事件（召回命中了非 INLINE 的记录），断言召回口径和调策略分数时读它。 */
  listFaults(): readonly ContextFaultEvent[]
  /** 两条队列都清空，实例可以接着用；用例之间复用同一个汇时靠它隔离。 */
  clear(): void
}

/** 内存汇：测试、离线重放与 headless 实验用。 */
export class InMemoryContextMigrationEventSink implements InMemoryContextMigrationEventSinkApi {
  private readonly migrations: ContextResidencyMigrationEvent[] = []
  private readonly faults: ContextFaultEvent[] = []

  public recordMigration(event: ContextResidencyMigrationEvent): void {
    this.migrations.push(event)
  }

  public recordFault(event: ContextFaultEvent): void {
    this.faults.push(event)
  }

  public listMigrations(): readonly ContextResidencyMigrationEvent[] {
    return this.migrations
  }

  public listFaults(): readonly ContextFaultEvent[] {
    return this.faults
  }

  public clear(): void {
    this.migrations.length = 0
    this.faults.length = 0
  }
}

