// 域：执行观测 span 录制器（宪章 §11 span 模型的产出侧）。
//
// 录制器持**进行中** span 于内存，收敛（`end`）时组装成一条完整 {@link ExecutionSpan}、schema 校验后交给
// 注入的 sink（sink 由宿主装配成执行账本写入器或事件总线旁路）。纪律对齐会话账本：
//   - **只产已完成 span**：进行中 span 不落盘，避免账本出现半态记录（读侧无需处理 in-progress）；
//   - **身份/时序引擎分配**：`spanId` / `startedAt` / `endedAt` 由注入端口填，调用方只声明「这是哪类 span
//     + 该类负载」，property 电池借确定性时钟/序号工厂复现字节；
//   - **校验即契约**：组装后必过 `ExecutionSpanSchema.parse`，绝不 emit 坏 span（边界解析一次，宪章 §12.5）。

import { AppError } from '@velaros-ai/core/error'

import type { ExecutionSpan, ExecutionSpanMetrics } from '../../types/agent.js'
import type { ExecutionSpanOutcome,ExecutionSpanStart } from '../../types/ledgers.js'
import { emptyExecutionSpanMetrics, ExecutionSpanSchema } from '../../utils/wire/observability'

/**
 * 一条**进行中**的 span handle：由 `ExecutionSpanRecorder.open` 造出，身份与起始时刻在那一刻就定死。
 *
 * 持有者是产 span 的生产侧（run/turn scope），拿着它做两件事：给子 span 当父指针，以及在动作结束时收敛。
 * 进行中的状态只在内存里，不落盘——账本里永远只有已收敛的完整 span。
 */
export interface OpenExecutionSpanApi {
  /** 本条 span 的身份，录制器开 span 时分配；子 span 把它填进自己的 `parentSpanId` 来结成树。 */
  readonly spanId: string
  /** 开 span 的时刻（epoch 毫秒，取注入时钟）；收敛时 `latencyMs` 就按「收敛时刻 − 它」算。 */
  readonly startedAt: number
  /**
   * 收敛并落定本 span：补齐 endedAt / status / metrics → `ExecutionSpanSchema.parse` → 交给 sink，返回完整记录。
   *
   * 每条 span 只许收敛一次，重复调用抛 `INVARIANT`（同一 span 双计时、双落盘是观测数据坏掉的根源）；
   * schema 不过也抛——绝不 emit 半成品。`outcome` 省略时按成功（status='ok'）记。
   */
  end(outcome?: ExecutionSpanOutcome): ExecutionSpan
}

export class OpenExecutionSpan implements OpenExecutionSpanApi {
  private ended = false

  constructor(
    private readonly draft: ExecutionSpanStart,
    public readonly spanId: string,
    public readonly startedAt: number,
    private readonly now: () => number,
    private readonly emit: (span: ExecutionSpan) => void
  ) {}

  /** 收敛并落定本 span：组装 → 校验 → emit，返回完整记录。 */
  public end(outcome: ExecutionSpanOutcome = {}): ExecutionSpan {
    if (this.ended) throw new AppError('INVARIANT', `执行 span ${this.spanId} 已经收敛过，不能再收敛一次：一个 span 只允许落定一条记录，重复收敛会让账本里出现重复 span。`)
    this.ended = true

    const endedAt = this.now()
    const metrics: ExecutionSpanMetrics = {
      ...emptyExecutionSpanMetrics(),
      latencyMs: endedAt - this.startedAt,
      ...(outcome.metrics ?? {}),
    }
    const candidate: Record<string, unknown> = {
      ...this.draft,
      ...(outcome.patch ?? {}),
      spanId: this.spanId,
      startedAt: this.startedAt,
      endedAt,
      status: outcome.status ?? 'ok',
      metrics,
    }
    // 校验即契约：不过即抛，绝不 emit 坏 span。
    const span = ExecutionSpanSchema.parse(candidate)
    this.emit(span)
    return span
  }
}


