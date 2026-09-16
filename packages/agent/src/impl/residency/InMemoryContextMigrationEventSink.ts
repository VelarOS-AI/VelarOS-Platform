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
import { Log } from '@velaros-ai/core'

import type { ContextMigrationEventSink } from '../../contract/requires.js'
import type { ContextFaultEvent, ContextMigrationEventLineWriter,ContextResidencyMigrationEvent } from '../../types/residency.js'
import { stableStringify } from '../../utils/residency/determinism'

/** 内存汇：测试、离线重放与 headless 实验用。 */
export class InMemoryContextMigrationEventSink implements ContextMigrationEventSink {
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

/** 事件 → 确定性 JSONL 行（键排序，同事件同字节）。 */
export function formatMigrationEventLine(event: ContextResidencyMigrationEvent): string {
  return stableStringify({ type: 'migration', ...event })
}

/** fault 事件 → 确定性 JSONL 行。 */
export function formatFaultEventLine(event: ContextFaultEvent): string {
  return stableStringify({ type: 'fault', ...event })
}

/**
 * JSONL 汇：把事件序列化成稳定行交给注入的写入器。
 * 写入器抛错时只记日志不外抛——治理不能被日志拖死（失败方向安全）。
 */
export class JsonlContextMigrationEventSink implements ContextMigrationEventSink {
  private readonly log = Log.tag('ContextMigrationEventSink')

  public constructor(private readonly writer: ContextMigrationEventLineWriter) {}

  public recordMigration(event: ContextResidencyMigrationEvent): void {
    this.writeLine(formatMigrationEventLine(event))
  }

  public recordFault(event: ContextFaultEvent): void {
    this.writeLine(formatFaultEventLine(event))
  }

  private writeLine(line: string): void {
    try {
      const result = this.writer.write(line)
      if (result instanceof Promise) {
        result.catch((error: unknown) => {
          this.log.warn('迁移事件异步写入失败，已丢弃该行', { error: String(error) })
        })
      }
    } catch (error) {
      this.log.warn('迁移事件写入失败，已丢弃该行', { error: String(error) })
    }
  }
}
