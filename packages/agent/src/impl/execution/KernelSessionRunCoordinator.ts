// 域：会话「输入准入」与「运行权协调」两条并发闸——kernel 侧唯一决定「哪条输入什么时候被跑」的地方。
//
// 文件分两半，**共用一个 sessionId 轴但互不引用**：
//  1. 前半 `*KernelSessionInputStore` —— 输入账本（admit / promote / cancel），回答「有什么在排队」；
//  2. 后半 `KernelSessionRunCoordinator` —— 运行权协调器，回答「现在谁在跑、下一个跑谁、打断算谁的」。
//
// ## ① 输入账本：两条投递轴不是同一件事
//  - `queue`（普通发送）：排队，一次 promote 一条（`promoteNextQueued`）；
//  - `steer`（运行中追加引导）：可**批量**在同一 cutoffSeq 前一次性 promote，因为它们要作为「同一轮
//    的补充指令」整体进入本轮，拆散会让引导被切到不同轮次而失去语义。
//  `admit` 对同 id 的重复准入**幂等**（内容一致返回原件、不一致抛 INVARIANT）——重试与重放共用一条路径，
//  没有这条幂等，网络重试会静默变成两条排队输入。
//  `cancel` 的语义按是否指定 inputId 分档：指定 id 时**允许撤回刚 promote 但还没被下一轮消费的输入**
//  （用户点了撤销），不指定时只动 admitted。合并这两档会让「撤销」要么撤不掉、要么误撤正在跑的。
//
// ## ② 运行权协调器：中断序号（seq）是整套时序的唯一裁判
// 一个 sessionId 同一时刻只有一个 `current` demand 在跑，最多再挂一个 `pending`；新需求到来时与
// `pending` **合并**（`coalesceKernelSessionDemands`）而不是排成无界队列——同一会话攒十条唤醒没有意义，跑一次就都消化了。
// 合并规则不对称：`run`（用户显式发起）**支配** `wake`（内部唤醒），因为 run 带用户可见的等待语义、
// 必须真的跑一次；wake 只需保证「醒过」。
//
// **为什么到处带 seq**：中断是异步的，可能早于、晚于、或正好撞上一次 wake 的入队。用「有没有在跑」
// 判定必然产生两种坏结果之一——早到的中断被无视（用户点了停止但下一轮照跑），或晚到的中断误杀之后
// 才发起的新输入。改用单调 seq 后判据变成纯偏序：**只有 seq 严格大于最近一次中断 seq 的需求才配跑**
// （`isAfterInterrupt` 在本文件，`entryAcceptsKernelSessionWake` / `shouldRunPendingKernelSessionDemand`
// 在 utils/execution/session-lane.ts，三处同一条判据，改一处必须改三处）。
// 无 seq 的 `run` 刻意豁免于该偏序（用户新发的消息不该被上一次中断连坐）。
//
// **被压制的需求怎么收尾**：`settleSuppressedKernelSessionDemand` 按 `rejectWhenSuppressed` 分叉——run 的等待者
// 收 `KernelSessionRunInterruptedError`（调用方必须知道自己没跑成），wake 的等待者直接 resolve
// （唤醒本就是尽力而为，让它 reject 只会在上层制造大量必须吞掉的异常）。
// **失败方向**：`start` 的 drain 无论 resolve 还是 reject 都走 `settle`——漏掉任一分支就会永久占着
// 运行权，该会话此后所有输入静默排队不跑（最坏失败模式，比抛错难查得多）。
//
import { isPresent } from '@velaros-ai/core'

import type { KernelSessionDemandSettlement, KernelSessionDrainRunner, KernelSessionRunDemand, KernelSessionRunEntry } from '../../types/execution.js'
import { coalesceKernelSessionDemands, createDemand, createDrainTarget, createRunDeferred, entryAcceptsKernelSessionWake, maxSeq, settleKernelSessionDemand, settleSuppressedKernelSessionDemand, shouldRunPendingKernelSessionDemand, suppressKernelSessionPendingAtOrBefore } from '../../utils/execution/session-lane'
import { KernelSessionRunInterruptedError } from '../errors/KernelSessionRunInterruptedError'























/**
 * 会话运行权协调器：回答「现在谁在跑、下一个跑谁、这次打断算谁的」。一个 sessionId 同时只有一个需求在跑，
 * 最多再挂一个 pending，新需求与 pending **合并**而不是排队。
 *
 * 整套时序的唯一裁判是单调的中断序号：只有序号严格大于最近一次中断的需求才配跑；
 * 没带序号的 `run`（用户新发的消息）刻意豁免，不被上一次中断连坐。由内核会话通道持有一份，跨会话共用同一实例。
 */
export interface KernelSessionRunCoordinatorApi {
  /** 这个会话此刻有没有需求在跑（挂着 pending 也算在跑，因为运行权还没释放）。 */
  isRunning(sessionId: string): boolean
  /**
   * 内部唤醒：跑一次 drain 把排队的输入消化掉。返回的 Promise 在这次唤醒真正被消化后 resolve；
   * 被中断压制掉的唤醒也 **resolve**（唤醒是尽力而为），所以调用方不必为它准备异常分支。
   * `seq` 小于等于最近一次中断序号时直接当作已完成，不会真的跑。
   */
  wake(sessionId: string, drain: KernelSessionDrainRunner, seq?: number): Promise<void>
  /**
   * 用户显式发起的一次运行：一定会真的跑一次。已经有 run 在跑就挂到它后面一起等，正在停就等它停完再重来。
   * 若这次需求被中断压制掉，返回的 Promise 以 `KernelSessionRunInterruptedError` reject——调用方必须知道自己没跑成。
   */
  run(sessionId: string, drain: KernelSessionDrainRunner): Promise<void>
  /** 等这个会话把运行权彻底交回来（没有在跑时立即 resolve）；用于收尾与顺序化的外部操作。 */
  awaitIdle(sessionId: string): Promise<void>
  /**
   * 打断这个会话：记下中断序号（只前进不后退），把正在跑的条目标记为停止，并结算掉这次中断之前挂着的 pending。
   * 中断可能早于任何运行到达——序号仍会被记住，后来序号更小的唤醒不会再跑。
   */
  interrupt(sessionId: string, seq?: number): void
}

export class KernelSessionRunCoordinator implements KernelSessionRunCoordinatorApi {
  /** 「这次诉求已经兑现」的定局结论：内容恒定，全实例共用一份。 */
  private static readonly KernelSessionDemandResolved: KernelSessionDemandSettlement = { status: 'resolved' }

  private readonly entries = new Map<string, KernelSessionRunEntry>()
  private readonly interruptSeqBySession = new Map<string, number>()

  public isRunning(sessionId: string): boolean {
    return this.entries.has(sessionId)
  }

  public wake(
    sessionId: string,
    drain: KernelSessionDrainRunner,
    seq?: number
  ): Promise<void> {
    const { demand, waiter } = createDemand('wake', drain, seq)
    if (!this.isAfterInterrupt(sessionId, seq)) {
      waiter.resolve()
      return waiter.promise
    }

    const entry = this.entries.get(sessionId)
    if (!entry) {
      this.start(sessionId, {
        current: demand,
        idle: createRunDeferred(),
        stopping: false,
      })
      return waiter.promise
    }

    if (!entryAcceptsKernelSessionWake(entry, seq)) {
      waiter.resolve()
      return waiter.promise
    }

    entry.pending = coalesceKernelSessionDemands(entry.pending, demand)
    return waiter.promise
  }

  public run(sessionId: string, drain: KernelSessionDrainRunner): Promise<void> {
    const { demand, waiter } = createDemand('run', drain)
    const entry = this.entries.get(sessionId)
    if (!entry) {
      this.start(sessionId, {
        current: demand,
        idle: createRunDeferred(),
        stopping: false,
      })
      return waiter.promise
    }

    if (entry.stopping) return entry.idle.promise.then(() => this.run(sessionId, drain))

    if (entry.current.mode === 'run') {
      entry.current.waiters.push({
        deferred: waiter,
        rejectWhenSuppressed: true,
      })
      return waiter.promise
    }

    entry.pending = coalesceKernelSessionDemands(entry.pending, demand)
    return waiter.promise
  }

  public awaitIdle(sessionId: string): Promise<void> {
    return this.entries.get(sessionId)?.idle.promise ?? Promise.resolve()
  }

  public interrupt(sessionId: string, seq?: number): void {
    const latestInterruptSeq = this.interruptSeqBySession.get(sessionId)
    if (isPresent(seq)) {
      if (isPresent(latestInterruptSeq) && seq <= latestInterruptSeq) return
      this.interruptSeqBySession.set(sessionId, seq)
    }

    const entry = this.entries.get(sessionId)
    if (!entry) return

    entry.stopping = true
    entry.interruptSeq = maxSeq(entry.interruptSeq, seq)
    suppressKernelSessionPendingAtOrBefore(entry, seq, new KernelSessionRunInterruptedError())
  }

  private start(sessionId: string, entry: KernelSessionRunEntry): void {
    this.entries.set(sessionId, entry)
    const demand = entry.current
    Promise.resolve()
      .then(() => demand.drain(createDrainTarget(sessionId, demand)))
      .then(
        () => this.settle(sessionId, entry, demand, KernelSessionRunCoordinator.KernelSessionDemandResolved),
        (error: unknown) => this.settle(sessionId, entry, demand, {
          status: 'rejected',
          error,
        })
      )
  }

  private settle(
    sessionId: string,
    entry: KernelSessionRunEntry,
    demand: KernelSessionRunDemand,
    settlement: KernelSessionDemandSettlement
  ): void {
    settleKernelSessionDemand(demand, settlement)
    if (this.entries.get(sessionId) !== entry) return

    const pending = entry.pending
    if (pending && shouldRunPendingKernelSessionDemand(entry, pending)) {
      entry.pending = undefined
      entry.current = pending
      entry.stopping = false
      this.start(sessionId, entry)
      return
    }

    if (pending) {
      settleSuppressedKernelSessionDemand(pending, new KernelSessionRunInterruptedError())
      entry.pending = undefined
    }
    this.entries.delete(sessionId)
    entry.idle.resolve()
  }

  private isAfterInterrupt(sessionId: string, seq: LooseOptional<number>): boolean {
    const latest = this.interruptSeqBySession.get(sessionId)
    return !isPresent(latest) || (isPresent(seq) && seq > latest)
  }
}
