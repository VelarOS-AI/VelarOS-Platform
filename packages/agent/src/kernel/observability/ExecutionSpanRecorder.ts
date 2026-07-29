// 域：执行观测 span 录制器（宪章 §11 span 模型的产出侧）。
//
// 录制器持**进行中** span 于内存，收敛（`end`）时组装成一条完整 {@link ExecutionSpan}、schema 校验后交给
// 注入的 sink（sink 由宿主装配成执行账本写入器或事件总线旁路）。纪律对齐会话账本：
//   - **只产已完成 span**：进行中 span 不落盘，避免账本出现半态记录（读侧无需处理 in-progress）；
//   - **身份/时序引擎分配**：`spanId` / `startedAt` / `endedAt` 由注入端口填，调用方只声明「这是哪类 span
//     + 该类负载」，property 电池借确定性时钟/序号工厂复现字节；
//   - **校验即契约**：组装后必过 `ExecutionSpanSchema.parse`，绝不 emit 坏 span（边界解析一次，宪章 §12.5）。
import { randomUUID } from 'node:crypto'

import {
  emptyExecutionSpanMetrics,
  type ExecutionSpan,
  type ExecutionSpanMetrics,
  ExecutionSpanSchema,
  type ExecutionSpanStatus,
} from '../../protocol'

/** 引擎负责分配、开 span 时不得携带的字段。 */
type EngineAssignedSpanField = 'spanId' | 'startedAt' | 'endedAt' | 'status' | 'metrics'

/** 判别联合上的分配式 Omit：逐变体去字段后重新联合，保住判别字段 `category` 的收窄能力。 */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never

/**
 * 开 span 输入：{@link ExecutionSpan} 去掉引擎分配字段。
 *
 * 类别特有的**收敛期字段**（tool 的 `errorCode` / model 的 `finishReason`）开 span 时
 * 先置 null 占位，收敛时经 `end` 的 patch 补上——形状恒全、消费面无需分支。
 */
export type ExecutionSpanStart = DistributiveOmit<ExecutionSpan, EngineAssignedSpanField>

/** 收敛一条 span 的产出：状态（缺省 ok）+ 度量增补 + 类别收敛期字段 patch。 */
export interface ExecutionSpanOutcome {
  status?: ExecutionSpanStatus
  metrics?: Partial<ExecutionSpanMetrics>
  /** 类别收敛期字段（errorCode / finishReason / found 等）；未知键由 strictObject 校验拦截。 */
  patch?: Record<string, unknown>
}

/** 录制器装配依赖。除 emit 外均可缺省；缺省用系统时钟 / randomUUID。 */
export interface ExecutionSpanRecorderDeps {
  emit: (span: ExecutionSpan) => void
  now?: () => number
  nextSpanId?: () => string
}

/**
 * 一条进行中的 span handle。
 *
 * `end` 幂等前置：重复收敛抛错（防止同一 span 双计时/双落盘）。`spanId` 暴露给调用方作子 span 的 `parentSpanId`。
 */
export class OpenExecutionSpan {
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
    if (this.ended) throw new Error(`execution span ${this.spanId} already ended`)
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

/**
 * 执行观测 span 录制器。
 *
 * 只认注入的 sink 与端口，零 IO、零 app 路径——落盘/转发由宿主装配。同一 run 的全部 span 经 `runId` 关联，
 * 树形靠 `parentSpanId`（调用方用父 handle 的 `spanId`）。
 */
export class ExecutionSpanRecorder {
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
