import type { ExecutionSpanStatus } from '../../types/agent.js'
import type { PromptAuditRecord, RunSpanScope, SpanLedgerWarn, TurnSpanScope } from '../../types/ledgers.js'

import { type ExecutionSpanRecorder } from './ExecutionSpanRecorder'
import { runIsolatedSpanOp } from './LedgerExecutionSpanScopeFactory'
import { LedgerTurnSpanScope } from './LedgerTurnSpanScope'

/**
 * 一次完整 agent 执行（run）的 span 作用域：构造时就开好 run span，收敛时关掉它。
 *
 * 由 span scope 工厂在 `beginRun` 时造一个交给 SoloLoop / QueryLoop，跟着那次执行活，执行结束即弃。
 * 父子指针（run → turn）由它内部记账，调用方从不碰 spanId；任一动词出错都吞成 warn，绝不冒泡进执行主路。
 */
export interface LedgerRunSpanScopeApi extends RunSpanScope {
  /**
   * 开一轮 turn 的作用域：新建一条挂在 run span 下的 turn span，返回 turn scope 供它再派生 model/tool span。
   *
   * 每轮 provider 生成开始时调一次。turn span 开不出来（观测停用或落盘异常）时返回的 scope 整体降级 no-op，
   * 调用方不需要分支。
   */
  beginTurn(input: {
    turn: number
    roleId: Nullable<string>
    model: Nullable<string>
  }): TurnSpanScope
  /** 收敛 run span：执行收尾时按最终状态（ok / error / aborted）调一次，本 scope 之后作废。 */
  end(outcome: { status: ExecutionSpanStatus }): void
}

export class LedgerRunSpanScope implements LedgerRunSpanScopeApi {
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
