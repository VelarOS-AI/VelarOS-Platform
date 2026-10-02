import {
  isArray,
  isEmpty,
  isFiniteNumber,
  isNull,
  isPlainObject,
  isString,
  optionalWhen,
} from '@velaros-ai/core'

import type {
  ActModelAccounting,
  ActVerificationAttemptSummary,
  ActVerificationCostSummary,
} from '../types/trace.js'

/** 协议接受、拒绝和计数分别解释；没有当前活跃租约时，缺失响应只说明未知。 */
export function modelAccounting(response: unknown, inflight: boolean): ActModelAccounting {
  const decoded = optionalWhen(isPlainObject, response)
  const settled = decoded?.status === 'accepted' || decoded?.status === 'rejected'
  const usage = isPlainObject(decoded?.usage) ? decoded.usage : undefined
  const inputTokens = tokenCount(usage?.inputTokens)
  const outputTokens = tokenCount(usage?.outputTokens)
  const cacheRead = tokenCount(usage?.cacheReadTokens)
  const cacheWrite = tokenCount(usage?.cacheWriteTokens)
  const cachesValid = !isNull(inputTokens) && (cacheRead ?? 0) + (cacheWrite ?? 0) <= inputTokens
  const finish = isPlainObject(decoded?.finish) ? decoded.finish : undefined
  const error = isPlainObject(decoded?.error) ? decoded.error : undefined
  return {
    status: settled ? 'settled' : inflight ? 'inflight' : 'unknown',
    outcome: settled ? (decoded.status as 'accepted' | 'rejected') : null,
    finishReason: finish?.reason === 'stop' || finish?.reason === 'length' ? finish.reason : null,
    error: error
      ? {
          code: isString(error.code) ? error.code : null,
          message: isString(error.message) ? error.message : null,
        }
      : null,
    usage: {
      coverage:
        !isNull(inputTokens) && !isNull(outputTokens) ? 'known' : inflight ? 'inflight' : 'unknown',
      inputTokens,
      outputTokens,
      cacheReadTokens: cachesValid ? cacheRead : null,
      cacheWriteTokens: cachesValid ? cacheWrite : null,
    },
  }
}

/** started 的未知被正常 settled 替代；迟到账单只能增加已知项，不能补成整次已完整。 */
export function summarizeVerificationAttempt(
  events: ReadonlyArray<{
    readonly value: unknown
    readonly ref: { readonly sessionId: string; readonly id: string }
  }>
): Nullable<ActVerificationAttemptSummary> {
  const valid = events.filter(
    (event): event is typeof event & { value: Record<string, unknown> } => {
      const value = event.value
      return (
        isPlainObject(value) &&
        [
          'attemptId',
          'taskId',
          'checkId',
          'scope',
          'verifierId',
          'verifierVersion',
          'startedAt',
        ].every((key) => isString(value[key])) &&
        ['started', 'settled', 'late-result'].includes(String(value.phase))
      )
    }
  )
  const first = valid[0]?.value
  if (!first) return null
  const phases = valid.filter(
    ({ value }) => value.attemptId === first.attemptId && value.taskId === first.taskId
  )
  const settled = phases.findLast(({ value }) => value.phase === 'settled')
  const base = (settled ?? phases.findLast(({ value }) => value.phase === 'started') ?? phases[0])!
    .value
  const late = phases.filter(({ value }) => value.phase === 'late-result')
  const baseCost = verificationCost(base.cost)
  const cost = summarizeVerificationCosts(
    [baseCost, ...late.map(({ value }) => verificationCost(value.cost))],
    baseCost.coverage !== 'complete'
  )
  const latest = phases.at(-1)!.value
  const time = (key: string) => {
    const values = phases
      .map(({ value }) => nonnegative(value[key]))
      .filter((value): value is number => !isNull(value))
    return !isEmpty(values) ? Math.max(...values) : null
  }
  return {
    attemptId: first.attemptId as string,
    taskId: first.taskId as string,
    checkId: first.checkId as string,
    scope: first.scope as string,
    verifierId: first.verifierId as string,
    verifierVersion: first.verifierVersion as string,
    mode: ['executed', 'reused', 'probed'].includes(String(base.mode))
      ? (base.mode as ActVerificationAttemptSummary['mode'])
      : 'probed',
    status: ['pending', 'passed', 'failed', 'unknown', 'cancelled'].includes(String(base.status))
      ? (base.status as ActVerificationAttemptSummary['status'])
      : 'unknown',
    applicability: ['current', 'historical', 'unknown'].includes(String(base.applicability))
      ? (base.applicability as ActVerificationAttemptSummary['applicability'])
      : 'unknown',
    phases: [
      ...new Set(
        phases.map(({ value }) => value.phase as ActVerificationAttemptSummary['phases'][number])
      ),
    ],
    startedAt: first.startedAt as string,
    settledAt: isString(latest.settledAt)
      ? latest.settledAt
      : isString(base.settledAt)
        ? base.settledAt
        : null,
    durationMs: time('durationMs'),
    probeMs: time('probeMs'),
    runMs: time('runMs'),
    records: phases.map(({ ref }) => ref),
    cost,
  }
}

/** 一次费用依据去重后再累加；同 ID 缺金额可补齐，同 ID 不同金额保留冲突。 */
export function summarizeVerificationCosts(
  costs: readonly ActVerificationCostSummary[],
  incomplete = false
): ActVerificationCostSummary {
  const charges = new Map<string, ActVerificationCostSummary['charges'][number]>()
  const conflicts = new Set(costs.flatMap((cost) => [...cost.conflictingChargeIds]))
  for (const cost of costs)
    for (const charge of cost.charges) {
      const old = charges.get(charge.id)
      if (
        old &&
        (old.kind !== charge.kind ||
          old.currency !== charge.currency ||
          old.basis !== charge.basis ||
          (!isNull(old.amount) && !isNull(charge.amount) && old.amount !== charge.amount))
      )
        conflicts.add(charge.id)
      if (!old || isNull(old.amount)) charges.set(charge.id, charge)
    }
  const list = [...charges.values()].map((charge) =>
    conflicts.has(charge.id) ? { ...charge, amount: null } : charge
  )
  const totals = new Map<string, ActVerificationCostSummary['totals'][number]>()
  for (const charge of list)
    if (!isNull(charge.amount)) {
      const key = JSON.stringify([charge.kind, charge.currency, charge.basis])
      totals.set(key, {
        kind: charge.kind,
        currency: charge.currency,
        basis: charge.basis,
        amount: (totals.get(key)?.amount ?? 0) + charge.amount,
      })
    }
  const complete =
    !incomplete &&
    costs.every((cost) => cost.coverage === 'complete') &&
    !conflicts.size &&
    list.every((charge) => !isNull(charge.amount))
  return {
    coverage: complete
      ? 'complete'
      : list.some((charge) => !isNull(charge.amount))
        ? 'partial'
        : 'unknown',
    charges: list,
    totals: [...totals.values()],
    conflictingChargeIds: [...conflicts],
  }
}

/** 只从可信持久记录提取费用字段，缺失或损坏的金额保持未知。 */
function verificationCost(value: unknown): ActVerificationCostSummary {
  if (!isPlainObject(value) || !isArray(value.charges))
    return { coverage: 'unknown', charges: [], totals: [], conflictingChargeIds: [] }
  const charges: Array<ActVerificationCostSummary['charges'][number]> = []
  let valid = true
  for (const item of value.charges) {
    if (
      !isPlainObject(item) ||
      !isString(item.id) ||
      !isString(item.currency) ||
      !['model', 'external'].includes(String(item.kind)) ||
      !['actual', 'reference'].includes(String(item.basis))
    ) {
      valid = false
      continue
    }
    const amount = nonnegative(item.amount)
    if (isNull(amount)) valid = false
    charges.push({
      id: item.id,
      kind: item.kind as 'model' | 'external',
      currency: item.currency,
      basis: item.basis as 'actual' | 'reference',
      amount,
    })
  }
  return {
    coverage:
      valid && value.coverage === 'complete'
        ? 'complete'
        : value.coverage === 'partial' || charges.some((charge) => !isNull(charge.amount))
          ? 'partial'
          : 'unknown',
    charges,
    totals: [],
    conflictingChargeIds: [],
  }
}

/** token 必须是实际报告的非负整数，缺失保持 null。 */
function tokenCount(value: unknown): Nullable<number> {
  return isFiniteNumber(value) && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/** 耗时和费用可以是小数，缺失与负数都不补零。 */
function nonnegative(value: unknown): Nullable<number> {
  return isFiniteNumber(value) && value >= 0 ? value : null
}
