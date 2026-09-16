import { randomUUID } from 'node:crypto'

import type { ExecutionSpan } from '../../types/agent.js'
import type { ExecutionSpanOutcome, ExecutionSpanRecorderDeps, ExecutionSpanStart } from '../../types/ledgers.js'

import { OpenExecutionSpan } from './OpenExecutionSpan'

/**
 * 执行观测 span 录制器：产 span 的唯一入口，由 scope 工厂按会话装配、run/turn scope 持有。
 *
 * 只认注入的 sink 与端口，零 IO、零 app 路径——落盘/转发由宿主装配。同一 run 的全部 span 经 `runId` 关联，
 * 树形靠 `parentSpanId`（调用方用父 handle 的 `spanId`）。身份与时刻一律由录制器分配，调用方不许自带。
 */
export interface ExecutionSpanRecorderApi {
  /**
   * 开一条 span：现在分配 `spanId` 与 `startedAt`，返回 handle 供动作结束时收敛。
   *
   * 用于有持续时间的动作（一次 provider 请求、一次工具执行）；开着不收敛的 span 不会落盘，
   * 所以调用方必须保证走到 `end`（失败路径也要）。
   */
  open(draft: ExecutionSpanStart): OpenExecutionSpan
  /**
   * 开即收：一次调用产一条完整 span，起止同刻、`latencyMs` 记 0，立刻交给 sink。
   *
   * 用于没有持续时间的点事件（policy 决策、能力观测）；`outcome` 省略时按成功记。
   */
  record(draft: ExecutionSpanStart, outcome?: ExecutionSpanOutcome): ExecutionSpan
}

export class ExecutionSpanRecorder implements ExecutionSpanRecorderApi {
  private readonly emit: (span: ExecutionSpan) => void
  private readonly now: () => number
  private readonly nextSpanId: () => string

  constructor(deps: ExecutionSpanRecorderDeps) {
    this.emit = deps.emit
    this.now = deps.now ?? (() => Date.now())
    this.nextSpanId = deps.nextSpanId ?? (() => randomUUID())
  }

  /** 开一条 span：分配 id 与起始时刻，返回 handle 供收敛。 */
  public open(draft: ExecutionSpanStart): OpenExecutionSpan {
    return new OpenExecutionSpan(draft, this.nextSpanId(), this.now(), this.now, this.emit)
  }

  /** 开即收（点事件，如 policy 决策）：起止同刻、latency=0，一次调用产一条完整 span。 */
  public record(draft: ExecutionSpanStart, outcome: ExecutionSpanOutcome = {}): ExecutionSpan {
    return this.open(draft).end({ ...outcome, metrics: { latencyMs: 0, ...(outcome.metrics ?? {}) } })
  }
}
