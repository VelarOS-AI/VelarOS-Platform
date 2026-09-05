import type { ModelMessage } from 'ai'

/** Host persistence and product policy at the existing turn boundaries. */
export interface AgentTurnBoundary<TContext> {
  turn: number
  history: ModelMessage[]
  toolContext: TContext
  abortSignal: AbortSignal
}

export interface AgentTurnSettlement<TContext> extends AgentTurnBoundary<TContext> {
  result: {
    hasToolUse: boolean
    inputTokens?: LooseOptional<number>
    outputTokens?: LooseOptional<number>
    costUsd?: LooseOptional<number>
    finishReason?: LooseOptional<string>
  }
}

export interface AgentRunLifecycle<TContext> {
  /** Before capturing this turn's tool surface and compiling its request. */
  beforeTurn?(turn: AgentTurnBoundary<TContext>): void | Promise<void>
  /** History includes assistant/tool results; persistence is awaited before another request. */
  onTurnSettled?(turn: AgentTurnSettlement<TContext>):
    void | 'continue' | 'stop' | Promise<void | 'continue' | 'stop'>
}

/** Decisions run inside the shared retry loop, after mandatory replay-safety checks. */
export interface AgentModelRetryPolicy {
  onFailure(input: { error: unknown; attempt: number; abortSignal: AbortSignal }):
    Nullable<{ delayMs: number }> | Promise<Nullable<{ delayMs: number }>>
  /** Disable continuation when the product promises no recovery after visible output. */
  allowPartialContinuation?: boolean
}
