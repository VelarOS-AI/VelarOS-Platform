import { Log } from '@velaros-ai/core'

import type { ContextMigrationEventSink } from '../../contract/requires.js'
import type { ContextFaultEvent, ContextMigrationEventLineWriter, ContextResidencyMigrationEvent } from '../../types/residency.js'
import { formatFaultEventLine, formatMigrationEventLine } from '../../utils/residency/migration-log'

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

/** 建一个把治理迁移事件按 JSONL 写出去的事件口。 */
export function createJsonlContextMigrationEventSink(writer: ContextMigrationEventLineWriter): ContextMigrationEventSink {
  return new JsonlContextMigrationEventSink(writer)
}
