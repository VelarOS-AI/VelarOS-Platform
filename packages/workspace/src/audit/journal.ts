import { id } from "../utils/id.js";

export interface AuditEvent {
  id: string;
  timestamp: number;
  actor: "agent" | "user" | "system" | "validator" | "plugin";
  action: string;
  inputSummary?: string;
  outputSummary?: string;
  path?: string;
  targetId?: string;
  transactionId?: string;
  oldRevision?: string;
  newRevision?: string;
  permissionDecision?: "allow" | "deny" | "ask";
  risk?: "low" | "medium" | "high";
  metadata?: Record<string, any>;
}

// 审计日志在内存常驻，按环形上限保留最近事件，避免长会话无界增长。
const MaxRetainedAuditEvents = 5000;

/** 内核内存审计日志：记录读写/编辑/权限等事件，并按环形上限保留最近若干条。 */
export class AuditJournal {
  private events: AuditEvent[] = [];
  private readonly maxEvents: number;

  constructor(maxEvents: number = MaxRetainedAuditEvents) {
    this.maxEvents = Math.max(1, maxEvents);
  }

  /** 追加一条审计事件并补全 id/时间戳；超过保留上限时丢弃最旧事件。 */
  public record(event: Omit<AuditEvent, "id" | "timestamp">): AuditEvent {
    const full: AuditEvent = { id: id("evt"), timestamp: Date.now(), ...event };
    this.events.push(full);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
    return full;
  }

  /** 返回当前保留事件的浅拷贝快照。 */
  public list(): AuditEvent[] {
    return [...this.events];
  }

  /** 将当前保留事件序列化为 JSONL（每行一个事件）。 */
  public toJSONL(): string {
    return this.events.map((event) => JSON.stringify(event)).join("\n");
  }
}
