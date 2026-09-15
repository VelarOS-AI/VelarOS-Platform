/**
 * 内存审计日志：`AuditJournal`。接口 `AuditJournalApi` 在本文件的类上方。
 */

import type { AuditEvent } from '../../types/audit.js'
import { id } from '../../utils/id.js'
import { ProjectTuning } from '../../utils/tuning.js'

export type { AuditEvent } from '../../types/audit.js'

/**
 * 内核的内存审计日志：记录读写、编辑、权限等事件，按环形上限保留最近若干条（缺省 ProjectTuning.persistence.auditEvents），
 * 避免长会话无界增长；不落盘。实例由内核持有，一个内核一份。
 */
export interface AuditJournalApi {
  /** 追加一条审计事件，补上事件号和时间戳后返回；超过保留上限时丢弃最旧的。 */
  record(event: Omit<AuditEvent, 'id' | 'timestamp'>): AuditEvent
  /** 当前保留的事件（浅拷贝的数组，最旧的在前）。 */
  list(): AuditEvent[]
  /** 把当前保留的事件序列化成 JSONL，每行一个事件。 */
  toJSONL(): string
}

export class AuditJournal implements AuditJournalApi {
  private events: AuditEvent[] = []
  private readonly maxEvents: number

  public constructor(maxEvents: number = ProjectTuning.persistence.auditEvents) {
    this.maxEvents = Math.max(1, maxEvents)
  }

  public record(event: Omit<AuditEvent, 'id' | 'timestamp'>): AuditEvent {
    const full: AuditEvent = { id: id('evt'), timestamp: Date.now(), ...event }
    this.events.push(full)
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents)
    }
    return full
  }

  public list(): AuditEvent[] {
    return [...this.events]
  }

  public toJSONL(): string {
    return this.events.map((event) => JSON.stringify(event)).join('\n')
  }
}
