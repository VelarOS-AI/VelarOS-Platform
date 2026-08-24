// Platform Kernel 统一持有与宿主无关的远程节点实现。
// 调用侧运行时:并发闸、终态回放缓存,以及「一个 callId 有且只有一帧终态」这条不变量的看守。
//
// 刻意不认识连接:终态从哪条 socket 出去是 Server 的判断(断线期间产生的结果要留在缓存里等重连
// 来取),runner 只负责执行、计时、去重与审计。
import { isNotNull, isUndefined, Log, toNullable } from '@velaros-ai/core'
import type { TimerLease, TimerScope } from '@velaros-ai/core/utils/TimerScope'
import type {
  RemoteNodeCancel,
  RemoteNodeError,
  RemoteNodeInvoke,
  RemoteNodeResult,
} from '@velaros-ai/kernel/contracts/protocol'

import type {
  RemoteNodeActivityEvent,
  RemoteNodeActivitySink,
  RemoteNodeAuditSink,
  RemoteNodeCapabilityInvoker,
} from './contracts'

const log = Log.tag('RemoteNodeCallRunner')

/** 终态回放缓存容量。够覆盖一次断线重连窗口内的在途调用,不做成无界的调用历史。 */
export const RemoteNodeCompletedCallCapacity = 256

interface RemoteNodeInFlightCall {
  readonly callId: string
  readonly clientId: string
  readonly clientName: string
  readonly capabilityId: string
  readonly operation: string
  readonly startedAt: number
  readonly controller: AbortController
  deadline: Nullable<TimerLease>
  settled: boolean
}

/**
 * 有界并发闸。
 *
 * 不是「队列化整条连接」:只有超过并发上限的**执行**才挂起,帧处理与取消走的是另一条路径,
 * 永远不会被这里的等待队列拖住。
 */
export class RemoteNodeInvocationPool {
  private readonly waiting: Array<() => void> = []
  private active = 0

  public constructor(private readonly limit: number) {}

  public async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve))
    }
    this.active += 1
    try {
      return await task()
    } finally {
      this.active -= 1
      this.waiting.shift()?.()
    }
  }
}

/**
 * callId → 终态结果的有界 FIFO 缓存。
 *
 * 这是「重连后按同一 callId 重试是安全的」这条承诺的物质基础。满了按最早写入淘汰——被淘汰的
 * callId 再来会被当成新调用,这是有界内存换来的已知代价,容量按一个重连窗口取。
 */
export class RemoteNodeResultCache {
  private readonly entries = new Map<string, RemoteNodeResult>()

  public constructor(
    private readonly capacity: number = RemoteNodeCompletedCallCapacity,
  ) {}

  public get(callId: string): Nullable<RemoteNodeResult> {
    return toNullable(this.entries.get(callId))
  }

  public set(callId: string, result: RemoteNodeResult): void {
    this.entries.set(callId, result)
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value
      if (isUndefined(oldest)) break
      this.entries.delete(oldest)
    }
  }

  public clear(): void {
    this.entries.clear()
  }
}

export interface RemoteNodeCallRunnerOptions {
  readonly invoker: RemoteNodeCapabilityInvoker
  readonly audit: RemoteNodeAuditSink
  readonly activity?: RemoteNodeActivitySink
  readonly timers: TimerScope
  readonly now: () => number
  readonly maxConcurrent: number
  /** 终态出口。可能一条连接都没有——那样结果就只留在回放缓存里,等重连后的重试来取。 */
  readonly deliver: (clientId: string, result: RemoteNodeResult) => void
}

/** 能力调用的执行与终态记账。 */
export class RemoteNodeCallRunner {
  private readonly pool: RemoteNodeInvocationPool
  private readonly completed = new RemoteNodeResultCache()
  private readonly calls = new Map<string, RemoteNodeInFlightCall>()

  public constructor(private readonly options: RemoteNodeCallRunnerOptions) {
    this.pool = new RemoteNodeInvocationPool(options.maxConcurrent)
  }

  public get inFlight(): number {
    return this.calls.size
  }

  public submit(
    frame: RemoteNodeInvoke,
    clientId: string,
    clientName: string,
    manifestRevision: string,
  ): void {
    const replay = this.completed.get(frame.callId)
    if (isNotNull(replay)) {
      // 回放不重记审计:审计记录的是「执行」,不是「Client 重试了几次」。
      this.options.deliver(clientId, replay)
      return
    }
    // 在途重复绝不启动第二次执行;那一份终态到达时自然会发出去,这里什么都不做才是对的。
    if (this.calls.has(frame.callId)) return
    const startedAt = this.options.now()
    this.recordActivity({
      type: 'started',
      at: startedAt,
      callId: frame.callId,
      clientId,
      clientName,
      capabilityId: frame.capabilityId,
      operation: frame.operation,
      input: frame.input,
    })
    if (frame.manifestRevision !== manifestRevision) {
      this.rejectStale(frame, clientId, clientName, startedAt)
      return
    }

    const call: RemoteNodeInFlightCall = {
      callId: frame.callId,
      clientId,
      clientName,
      capabilityId: frame.capabilityId,
      operation: frame.operation,
      startedAt,
      controller: new AbortController(),
      deadline: null,
      settled: false,
    }
    this.calls.set(call.callId, call)
    // deadline 从**收帧**起算而不是从开始执行起算:Client 那头的等待是从发出去就开始的,
    // 把排队时间藏起来只会让两端对同一次调用的耐心不一致。
    call.deadline = this.options.timers.after(frame.deadlineMs, () => {
      call.controller.abort(new Error('Remote node call deadline exceeded'))
      this.settle(call, 'error', undefined, {
        code: 'DEADLINE_EXCEEDED',
        message: `Call exceeded its ${frame.deadlineMs}ms deadline`,
        retryable: true,
      })
    }, { label: 'remote-node-deadline', unref: true })

    void this.pool
      .run(async () => {
        // 排队期间可能已被取消或超时;此时不该再打扰能力实现。
        if (call.settled) return
        const outcome = await this.options.invoker.invoke({
          capabilityId: frame.capabilityId,
          operation: frame.operation,
          scope: frame.scope,
          input: frame.input,
        }, call.controller.signal)
        if (outcome.status === 'denied') {
          this.settle(call, 'denied', undefined, {
            code: outcome.error?.code ?? 'DENIED',
            message: outcome.error?.message ?? 'Capability call was denied',
            retryable: false,
          })
          return
        }
        this.settle(call, 'success', outcome.output, null)
      })
      .catch((error: unknown) => {
        this.settle(call, 'error', undefined, {
          code: 'CALL_FAILED',
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        })
      })
  }

  public cancel(frame: RemoteNodeCancel): void {
    const call = this.calls.get(frame.callId)
    // 未知或已终态的 callId 一律静默:一个 callId 只有一帧终态,这里补发就破了那条不变量。
    if (isUndefined(call)) return
    call.controller.abort(new Error(`Remote node call was cancelled: ${frame.reason}`))
    // best-effort abort 之后**立刻**回终态,不等能力实现自己收敛——契约承诺的是「取消后仍有
    // 一帧终态」,不是「取消后等实现愿意停」。实现晚到的结果会被 `settled` 挡掉。
    this.settle(call, 'error', undefined, {
      code: 'CALL_ABORTED',
      message: 'Call was cancelled by the client',
      retryable: false,
    })
  }

  /**
   * 停机:中止在途调用但**不**写安全审计——它们没有「完成」,记一条审计 error 会冒充成
   * 对端收到的终态。产品侧执行流仍要收到 stopped 终态,否则私有 Session 会永久停在 running。
   */
  public abortAll(reason: string): void {
    for (const call of this.calls.values()) {
      call.settled = true
      call.deadline?.cancel()
      call.controller.abort(new Error(reason))
      this.recordActivity({
        type: 'finished',
        at: this.options.now(),
        callId: call.callId,
        clientId: call.clientId,
        clientName: call.clientName,
        capabilityId: call.capabilityId,
        operation: call.operation,
        status: 'error',
        durationMs: this.options.now() - call.startedAt,
        error: {
          code: 'NODE_STOPPED',
          message: reason,
          retryable: true,
        },
      })
    }
    this.calls.clear()
  }

  /** 丢弃终态回放缓存。仅用于解除配对——缓存属于上一段信任关系。 */
  public forgetCompleted(): void {
    this.completed.clear()
  }

  private rejectStale(
    frame: RemoteNodeInvoke,
    clientId: string,
    clientName: string,
    startedAt: number,
  ): void {
    const result: RemoteNodeResult = {
      type: 'result',
      callId: frame.callId,
      status: 'error',
      error: {
        code: 'MANIFEST_STALE',
        message: `Call carried manifest revision ${frame.manifestRevision}`,
        // 盲重试同一 revision 只会再被拒一次;Client 必须先按推送的清单重注册工具面。
        retryable: false,
      },
    }
    // 仍进回放缓存:一个 callId 一帧终态的不变量不因拒绝而例外。
    this.completed.set(frame.callId, result)
    this.options.audit.record({
      at: this.options.now(),
      callId: frame.callId,
      clientId,
      capabilityId: frame.capabilityId,
      operation: frame.operation,
      status: 'error',
      durationMs: 0,
      errorCode: 'MANIFEST_STALE',
    })
    this.recordActivity({
      type: 'finished',
      at: this.options.now(),
      callId: frame.callId,
      clientId,
      clientName,
      capabilityId: frame.capabilityId,
      operation: frame.operation,
      status: 'error',
      durationMs: this.options.now() - startedAt,
      error: result.error,
    })
    this.options.deliver(clientId, result)
  }

  private settle(
    call: RemoteNodeInFlightCall,
    status: RemoteNodeResult['status'],
    output: unknown,
    error: Nullable<RemoteNodeError>,
  ): void {
    if (call.settled) return
    call.settled = true
    call.deadline?.cancel()
    call.deadline = null
    this.calls.delete(call.callId)
    const result: RemoteNodeResult = status === 'success'
      ? { type: 'result', callId: call.callId, status, output, error: null }
      : { type: 'result', callId: call.callId, status, error }
    this.completed.set(call.callId, result)
    // 审计只记元数据:input / output 一律不进这条线,跨机链路上流过的可能是 PIN 或 token。
    this.options.audit.record({
      at: this.options.now(),
      callId: call.callId,
      clientId: call.clientId,
      capabilityId: call.capabilityId,
      operation: call.operation,
      status,
      durationMs: this.options.now() - call.startedAt,
      errorCode: toNullable(error?.code),
    })
    this.recordActivity({
      type: 'finished',
      at: this.options.now(),
      callId: call.callId,
      clientId: call.clientId,
      clientName: call.clientName,
      capabilityId: call.capabilityId,
      operation: call.operation,
      status,
      durationMs: this.options.now() - call.startedAt,
      ...(status === 'success' ? { output } : {}),
      error,
    })
    this.options.deliver(call.clientId, result)
  }

  /** Product projection is observability only; it must never affect execution. */
  private recordActivity(event: RemoteNodeActivityEvent): void {
    try {
      this.options.activity?.record(event)
    } catch (error) {
      // 产品活动投影只做可观测性；失败不能反向影响权威安全审计或执行结果。
      log.debug('远程节点活动投影写入失败。', { error, event })
    }
  }
}
