export interface AgentSessionApplicationEvent<TPayload = unknown> {
  readonly type: string
  readonly payload: TPayload
  readonly createdAt: number
}

/** Product persistence adapter for event-sourced Session application services. */
export interface AgentSessionEventPort {
  readEvents(sessionId: string): readonly AgentSessionApplicationEvent[]
  appendEvent(
    sessionId: string,
    input: {
      readonly eventId?: string
      readonly type: string
      readonly payload: unknown
      readonly createdAt?: number
    }
  ): unknown
}
