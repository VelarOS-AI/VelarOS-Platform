/**
 * 会话级工具层遥测计数器。
 *
 * 从 CodingSessionTracker 剥离的第一块独立关注点（见 docs/agent-pipeline-review.md §2）：
 * 纯累加计数，与会话其余可变状态无耦合，单独持有便于测试与推理。
 * 后续可按同样方式逐块剥离 turn-planning journal、工具租约、能力验证跟踪等关注点。
 */
export interface SessionTelemetryCountersApi {
  /** 模型每调一次 `tooling:replace` 记一笔；编辑跟踪器在工具调用落定时调，读数即本会话换入能力的次数。 */
  recordToolReplaceCall(): void
  /** 每拦下一次重复调用（重复工具页请求或重复验证）记一笔，由跟踪器生成拦截文案时调。 */
  recordDedupeHit(): void
  /** 模型调到当前不可见工具时记一笔；数字偏高说明工具页换入换出策略没跟上模型的意图。 */
  recordInvisibleToolCall(): void
  /** 每向用户出示一张确认卡记一笔；数字偏高说明授权面太碎，用户被打断得太频繁。 */
  recordConfirmationCard(): void
  /** 本会话累计的 `tooling:replace` 次数（= 能力启用次数）。 */
  readonly enableToolsPerSession: number
  /** 本会话累计的去重拦截次数。 */
  readonly dedupeHitCount: number
  /** 本会话累计的不可见工具调用次数。 */
  readonly invisibleToolCallCount: number
  /** 本会话累计出示的确认卡数量。 */
  readonly confirmCardsPerSession: number
}

class SessionTelemetryCounters implements SessionTelemetryCountersApi {
  private toolReplaceCalls = 0
  private dedupeHits = 0
  private invisibleToolCalls = 0
  private confirmCards = 0

  /** tooling:replace 工具调用次数（= 本会话能力启用次数）。 */
  public recordToolReplaceCall(): void {
    this.toolReplaceCalls += 1
  }

  /** 工具调用去重命中次数。 */
  public recordDedupeHit(): void {
    this.dedupeHits += 1
  }

  /** 模型调用了不可见工具的次数。 */
  public recordInvisibleToolCall(): void {
    this.invisibleToolCalls += 1
  }

  /** 向用户出示确认卡的次数。 */
  public recordConfirmationCard(): void {
    this.confirmCards += 1
  }

  public get enableToolsPerSession(): number {
    return this.toolReplaceCalls
  }

  public get dedupeHitCount(): number {
    return this.dedupeHits
  }

  public get invisibleToolCallCount(): number {
    return this.invisibleToolCalls
  }

  public get confirmCardsPerSession(): number {
    return this.confirmCards
  }
}

export { SessionTelemetryCounters }
