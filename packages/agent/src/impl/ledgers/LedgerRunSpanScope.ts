import type { ExecutionSpanStatus } from '../../types/agent.js'
import type { PromptAuditRecord, RunSpanScope, SpanLedgerWarn, TurnSpanScope } from '../../types/ledgers.js'

import { type ExecutionSpanRecorder } from './ExecutionSpanRecorder'
import { runIsolatedSpanOp } from './LedgerExecutionSpanScopeFactory'
import { LedgerTurnSpanScope } from './LedgerTurnSpanScope'
export class LedgerRunSpanScope implements RunSpanScope {
  private readonly runSpan: ReturnType<ExecutionSpanRecorder['open']>

  constructor(
    private readonly recorder: ExecutionSpanRecorder,
    private readonly run: {
      runId: string
      sessionId: string
      rootInputId: Nullable<string>
      agentName: Nullable<string>
      dispatchSource: Nullable<string>
    },
    private readonly warn: SpanLedgerWarn,
    private readonly now: () => number,
    /** D3：prompt 审计侧信道写入器（fire-and-forget）；缺省 null → recordPromptAudit no-op。 */
    private readonly promptAuditAppend: Nullable<(record: PromptAuditRecord) => void>
  ) {
    this.runSpan = this.recorder.open({
      category: 'run',
      parentSpanId: null,
      runId: run.runId,
      sessionId: run.sessionId,
      name: 'agent-run',
      rootInputId: run.rootInputId,
      agentName: run.agentName,
      dispatchSource: run.dispatchSource,
    })
  }

  public beginTurn(input: {
    turn: number
    roleId: Nullable<string>
    model: Nullable<string>
  }): TurnSpanScope {
    const turnSpan = this.safe(
      () =>
        this.recorder.open({
          category: 'turn',
          parentSpanId: this.runSpan.spanId,
          runId: this.run.runId,
          sessionId: this.run.sessionId,
          name: `turn-${input.turn}`,
          turn: input.turn,
          roleId: input.roleId,
          model: input.model,
        }),
      'begin turn span'
    )
    return new LedgerTurnSpanScope(this.recorder, this.run, turnSpan, this.warn, {
      turnMeta: { turn: input.turn, roleId: input.roleId, model: input.model },
      now: this.now,
      promptAuditAppend: this.promptAuditAppend,
    })
  }

  public end(outcome: { status: ExecutionSpanStatus }): void {
    this.safe(() => this.runSpan.end({ status: outcome.status }), 'end run span')
  }

  private safe<T>(fn: () => T, label: string): Nullable<T> {
    return runIsolatedSpanOp(this.warn, fn, label)
  }
}
