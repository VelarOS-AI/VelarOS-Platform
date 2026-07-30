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

import type { ContextResidency } from './ContextRecord'
import { stableStringify } from './determinism'

/** 迁移因果。准入期只会产生 `admission` / `admission-oversize`；其余归 B1 起的 epoch。 */
export type ContextMigrationCause =
  /** 准入：常规入账。 */
  | 'admission'
  /** 准入：超 `inlineMaxChars`，直接以 EXCERPT 入账。 */
  | 'admission-oversize'
  /** epoch I0：机械逐出。 */
  | 'evict'
  /** epoch I1：规则骨架折叠。 */
  | 'skeleton'
  /** epoch I2：LLM 蒸馏折叠。 */
  | 'distill'
  /** 冷归档 GC：原文不再可取。 */
  | 'expire'
  /** 语义去重：同工具同目标的旧快照被新的取代。 */
  | 'superseded'

/** 缺页（fault）事件：`recall_context` 命中非 INLINE 记录。 */
export interface ContextFaultEvent {
  recordId: string
  residency: ContextResidency
  /** 该记录累计被召回次数（含本次）。 */
  faultCount: number
  /** 记录年龄（毫秒），由调用方的时钟差算出，事件自身不取时钟。 */
  ageMs: number
  at: number
}

export interface ContextResidencyMigrationEvent {
  recordId: string
  /** null = 准入（此前不存在驻留态）。 */
  from: Nullable<ContextResidency>
  to: ContextResidency
  cause: ContextMigrationCause
  /** 本次迁移的 token 变化量（负值 = 省下）。 */
  tokensDelta: number
  at: number
}

/** 事件汇（sink）端口。实现必须自行吞掉自己的 IO 失败——治理链路不因日志写失败而中断。 */
export interface ContextMigrationEventSink {
  recordMigration(event: ContextResidencyMigrationEvent): void
  recordFault(event: ContextFaultEvent): void
}

/** JSONL 行写入器端口：宿主注入（文件 / 流 / 内存皆可）。 */
export interface ContextMigrationEventLineWriter {
  write(line: string): void | Promise<void>
}

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
