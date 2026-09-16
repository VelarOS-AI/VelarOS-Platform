import { isPresent, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { AdmitKernelSessionInput, KernelAdmittedInput, KernelInputDelivery, KernelInputRole, KernelSessionDrainMode, KernelSessionDrainRunner, KernelSessionDrainTarget, KernelSessionInputSnapshot, KernelSessionRunDeferred, KernelSessionRunDemand } from '../../types/execution.js'
import { compareStableStrings } from '../residency/determinism'

export function cloneInput(input: KernelAdmittedInput): KernelAdmittedInput {
  const cloned: KernelAdmittedInput = { ...input }
  if (input.metadata) cloned.metadata = { ...input.metadata }
  return cloned
}

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

export function assertInputContent(input: AdmitKernelSessionInput): void {
  if (!input.sessionId.trim()) {
    throw new AppError('VALIDATION', 'Kernel session input requires a sessionId')
  }
  if (!input.content.trim()) {
    throw new AppError('VALIDATION', 'Kernel session input requires non-empty content')
  }
}

export function cloneSnapshot(
  snapshot?: LooseOptional<KernelSessionInputSnapshot>
): KernelSessionInputSnapshot {
  return {
    inputs: (snapshot?.inputs ?? []).map(cloneInput),
  }
}

export function sortInputs(inputs: KernelAdmittedInput[]): KernelAdmittedInput[] {
  return inputs.sort((left, right) => {
    const sessionOrder = compareStableStrings(left.sessionId, right.sessionId)
    if (sessionOrder !== 0) return sessionOrder
    return left.seq - right.seq
  })
}

export function createRunDeferred(): KernelSessionRunDeferred {
  let resolve!: KernelSessionRunDeferred['resolve']
  let reject!: KernelSessionRunDeferred['reject']
  const promise = new Promise<void>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
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
