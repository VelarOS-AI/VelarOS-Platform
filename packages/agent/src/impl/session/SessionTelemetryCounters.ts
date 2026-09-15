/**
 * 会话级工具层遥测计数器。
 *
 * 从 CodingSessionTracker 剥离的第一块独立关注点（见 docs/agent-pipeline-review.md §2）：
 * 纯累加计数，与会话其余可变状态无耦合，单独持有便于测试与推理。
 * 后续可按同样方式逐块剥离 turn-planning journal、工具租约、能力验证跟踪等关注点。
 */
class SessionTelemetryCounters {
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
