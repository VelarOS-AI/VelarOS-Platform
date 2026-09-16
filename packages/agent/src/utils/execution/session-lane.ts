import { isPresent, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { AdmitKernelSessionInput, KernelAdmittedInput, KernelChatSubmissionDeferred, KernelInputDelivery, KernelInputRole, KernelSessionDemandSettlement, KernelSessionDrainMode, KernelSessionDrainRunner, KernelSessionDrainTarget, KernelSessionInputSnapshot, KernelSessionRunDeferred, KernelSessionRunDemand, KernelSessionRunEntry } from '../../types/execution.js'
import { compareStableStrings } from '../residency/determinism'

/**
 * 复制一条已准入输入（`metadata` 另建一份浅拷贝）。store 对外交出的每条记录都要过它：
 * 直接把内部数组里的对象递出去，调用方就地改 `status`/`promotedAt` 就绕过了 store 自己的状态流转。
 */
export function cloneInput(input: KernelAdmittedInput): KernelAdmittedInput {
  const cloned: KernelAdmittedInput = { ...input }
  if (input.metadata) cloned.metadata = { ...input.metadata }
  return cloned
}

/**
 * 同一个 `id` 被再次准入时，判断这是不是「同一次提交的重放」：`sessionId`、`role`、`content`、`delivery`
 * 四项全等才为真。为真则幂等地把已有那条交回去；为假说明是另一次提交撞了同一个 id，调用方要抛 `INVARIANT`
 * 而不是覆盖——静默覆盖会让先到的那条输入凭空消失。
 */
export function isSameAdmission(
  existing: KernelAdmittedInput,
  input: AdmitKernelSessionInput,
  role: KernelInputRole,
  delivery: KernelInputDelivery
): boolean {
  return (
    existing.sessionId === input.sessionId &&
    existing.role === role &&
    existing.content === input.content &&
    existing.delivery === delivery
  )
}

/**
 * 准入前的前置校验：`sessionId` 与 `content` 去空白后都必须非空，否则抛 `AppError('VALIDATION')`。
 * 挡的是空白输入进了队列、排到时却跑出一个什么都没说的空回合。
 */
export function assertInputContent(input: AdmitKernelSessionInput): void {
  if (!input.sessionId.trim()) {
    throw new AppError('VALIDATION', '这次输入没有 sessionId：去掉首尾空白后必须仍有内容，否则它排不进任何一条会话的输入队列。')
  }
  if (!input.content.trim()) {
    throw new AppError('VALIDATION', '这次输入的 content 是空的：去掉首尾空白后必须仍有内容，否则排到它时会跑出一个什么都没说的空回合。')
  }
}

/**
 * 从快照还原出 store 的内部结构：快照缺席或 `inputs` 缺席都按空数组处理，逐条 `cloneInput`，
 * 保证恢复出来的 store 与传入的快照对象不共享引用（之后的状态流转不会反写回调用方手里的快照）。
 */
export function cloneSnapshot(
  snapshot?: LooseOptional<KernelSessionInputSnapshot>
): KernelSessionInputSnapshot {
  return {
    inputs: (snapshot?.inputs ?? []).map(cloneInput),
  }
}

/**
 * 就地按 (sessionId, seq) 排序并返回同一个数组：会话 id 用 `compareStableStrings` 比（不看运行环境的 locale），
 * 同会话内按准入序号升序。落快照前必须过它——否则顺序取决于 Map 的插入次序，同一份状态导出两次会不一样。
 */
export function sortInputs(inputs: KernelAdmittedInput[]): KernelAdmittedInput[] {
  return inputs.sort((left, right) => {
    const sessionOrder = compareStableStrings(left.sessionId, right.sessionId)
    if (sessionOrder !== 0) return sessionOrder
    return left.seq - right.seq
  })
}

/**
 * 造一个由外部兑现的 `{ promise, resolve, reject }`：一次 run 的等待者拿着 promise，
 * 协调器在跑完时 resolve、在被中断压制时 reject。
 * 与下面的 `createSubmissionDeferred` 不同，这里**不**预挂 catch —— run 的等待者必须能观察到中断异常。
 */
export function createRunDeferred(): KernelSessionRunDeferred {
  let resolve!: KernelSessionRunDeferred['resolve']
  let reject!: KernelSessionRunDeferred['reject']
  const promise = new Promise<void>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

/**
 * 建一条聊天提交的等待闸：一条 run 的「已获准入」与「已跑完」各用一个，由桥在准入/收敛时兑现。
 * 这里先挂一个吞掉拒绝的 catch —— `send` 的调用者只观察 accepted，没人 await 的那一条不能变成
 * unhandled rejection；原 promise 的拒绝仍然原样留给 `submit` 的调用者读取。
 */
export function createSubmissionDeferred(): KernelChatSubmissionDeferred {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  void promise.catch(() => {
    // arch-guard:silent-catch-ok send 调用者只观察 accepted；原 promise 的拒绝仍供 submit 调用者读取。
  })
  return { promise, resolve, reject }
}

/** 收两种缺席形态，出去只有省略位的 `undefined`（`interruptSeq?: number` 的存储形状）。 */
export function maxSeq(
  left: LooseOptional<number>,
  right: LooseOptional<number>
): number | undefined {
  if (!isPresent(left)) return toOptional(right)
  if (!isPresent(right)) return toOptional(left)
  return Math.max(left, right)
}

/**
 * 把一次需求打包成交给 `drain` 回调的目标描述（`sessionId` + `mode`）。
 * `seq` 只在需求真带序号时才写进去——它是可选属性，缺席就整键省略，不写成 `undefined`。
 */
export function createDrainTarget(
  sessionId: string,
  demand: KernelSessionRunDemand
): KernelSessionDrainTarget {
  const target: KernelSessionDrainTarget = {
    sessionId,
    mode: demand.mode,
  }
  if (isPresent(demand.seq)) {
    target.seq = demand.seq
  }
  return target
}

/**
 * 造一次「要跑」的需求，连同它唯一的等待者一起返回。
 * 等待者的 `rejectWhenSuppressed` 按 `mode` 定：`run`（用户显式发起）标真，被中断压制时要收到拒绝，
 * 调用方必须知道自己那次没跑成；`wake`（尽力而为的唤醒）标假，压制时直接 resolve。
 * `seq` 只有真传了才写进需求（可选属性，缺席即省略）。
 */
export function createDemand(
  mode: KernelSessionDrainMode,
  drain: KernelSessionDrainRunner,
  seq?: number
): { demand: KernelSessionRunDemand; waiter: KernelSessionRunDeferred } {
  const waiter = createRunDeferred()
  const demand: KernelSessionRunDemand = {
    mode,
    drain,
    waiters: [
      {
        deferred: waiter,
        rejectWhenSuppressed: mode === 'run',
      },
    ],
  }
  if (isPresent(seq)) {
    demand.seq = seq
  }
  return { demand, waiter }
}

/** 把一次需求的结算结果派给它的所有等待者：resolved 全部 resolve，rejected 全部按同一个原因 reject。一个需求可能合并了多个等待者，必须一次派完。 */
export function settleKernelSessionDemand(
  demand: KernelSessionRunDemand,
  settlement: KernelSessionDemandSettlement
): void {
  for (const waiter of demand.waiters) {
    if (settlement.status === 'resolved') {
      waiter.deferred.resolve()
    } else {
      waiter.deferred.reject(settlement.error)
    }
  }
}

/**
 * 结算一个**被压制（没轮到跑就被中断）**的需求：按等待者自己的 `rejectWhenSuppressed` 分叉——
 * `run` 的等待者收 `interrupted`（调用方必须知道自己没跑成），`wake` 的等待者直接 resolve
 * （唤醒本就是尽力而为，让它 reject 只会在上层制造大量必须吞掉的异常）。
 *
 * `interrupted` 由调用方构造后传入：utils 不引 impl 的错误类。
 */
export function settleSuppressedKernelSessionDemand(
  demand: KernelSessionRunDemand,
  interrupted: Error
): void {
  for (const waiter of demand.waiters) {
    if (waiter.rejectWhenSuppressed) {
      waiter.deferred.reject(interrupted)
    } else {
      waiter.deferred.resolve()
    }
  }
}

/**
 * 当前这次跑完之后，挂着的 pending 该不该接着跑：没在停就跑；`run`（用户显式发起）无条件跑；
 * `wake` 只有序号严格大于本次中断序号时才跑——这是「中断只杀它之前的唤醒」那条偏序判据的一处，
 * 与 `entryAcceptsKernelSessionWake`、协调器里的 `isAfterInterrupt` 必须同时改。
 */
export function shouldRunPendingKernelSessionDemand(
  entry: KernelSessionRunEntry,
  pending: KernelSessionRunDemand
): boolean {
  if (!entry.stopping) return true
  if (pending.mode === 'run') return true
  return (
    isPresent(entry.interruptSeq) &&
    isPresent(pending.seq) &&
    pending.seq > entry.interruptSeq
  )
}

/**
 * 把新需求并进已挂着的那个，而不是排成无界队列——同一会话攒十次唤醒没有意义，跑一次就都消化了。
 *
 * 合并不对称：只要有一边是 `run`，结果就是 `run`，且用 `run` 那边的 drain（用户显式发起的那次必须真的跑）。
 * 两边都是 `wake` 时取新的 drain 与两者中更大的 seq。等待者一律合并保留，谁也不会被丢掉。
 */
export function coalesceKernelSessionDemands(
  left: LooseOptional<KernelSessionRunDemand>,
  right: KernelSessionRunDemand
): KernelSessionRunDemand {
  if (!left) return right

  const waiters = [...left.waiters, ...right.waiters]
  if (left.mode === 'run' || right.mode === 'run') {
    const dominant = right.mode === 'run' ? right : left
    return {
      mode: 'run',
      drain: dominant.drain,
      waiters,
    }
  }

  const coalesced: KernelSessionRunDemand = {
    mode: 'wake',
    drain: right.drain,
    waiters,
  }
  const seq = maxSeq(left.seq, right.seq)
  if (isPresent(seq)) {
    coalesced.seq = seq
  }
  return coalesced
}

/** 这个已在跑的条目还收不收新的唤醒：没在停就收；正在停时只收序号严格大于本次中断序号的那些（判据同 `shouldRunPendingKernelSessionDemand`）。 */
export function entryAcceptsKernelSessionWake(
  entry: KernelSessionRunEntry,
  seq: LooseOptional<number>
): boolean {
  return (
    !entry.stopping ||
    (isPresent(entry.interruptSeq) && isPresent(seq) && seq > entry.interruptSeq)
  )
}

/**
 * 中断时清掉「这次中断之前」的那个 pending：序号严格更大的 `wake` 留着（它是中断之后才发生的，不该被连坐），
 * 其余一律摘下并按压制语义结算。`interrupted` 由调用方构造后传入。
 */
export function suppressKernelSessionPendingAtOrBefore(
  entry: KernelSessionRunEntry,
  seq: LooseOptional<number>,
  interrupted: Error
): void {
  const pending = entry.pending
  if (!pending) return
  if (
    pending.mode === 'wake' &&
    isPresent(seq) &&
    isPresent(pending.seq) &&
    pending.seq > seq
  ) return

  entry.pending = undefined
  settleSuppressedKernelSessionDemand(pending, interrupted)
}
