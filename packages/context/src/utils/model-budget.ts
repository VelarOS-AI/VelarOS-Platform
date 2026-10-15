import { isUndefined } from '@velaros-ai/core'
import { isArray, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { ContextLimits } from '../contract/constants.js'
import type {
  ContextHourlyUsage,
  ContextTaskState,
  ContextTaskUsage,
  ContextViewLimits,
} from '../types/context.js'
import type {
  ContextLegacyModelUsage,
  ContextModelBudgetRequest,
  ContextModelBudgetState,
  ContextModelBudgetUpdate,
} from '../types/model-budget.js'

import { contextFailure } from './state.js'
import { hourlyRetryMs, recentHourlyTokens, rolledHourly } from './usage.js'

/** 从旧总量保留保守底座，不为没有请求身份的历史记录推算退款。 */
function legacyUsage(usage: ContextTaskUsage): ContextLegacyModelUsage {
  return {
    mainCalls: usage.mainCalls,
    contextCalls: usage.contextCalls,
    reservedTokens: usage.reservedTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    unmeasuredCalls: usage.unmeasuredCalls,
  }
}

/** 按身份重建汇总：已知实际与其他请求的未知预留相加，原始预估另行保留。 */
export function modelBudgetUsage(
  ledger: ContextModelBudgetState,
  hourly: Optional<ContextHourlyUsage>
): ContextTaskUsage {
  const usage = { ...ledger.legacy }
  let budgetTokens = Math.max(usage.reservedTokens, usage.inputTokens + usage.outputTokens)
  for (const request of Object.values(ledger.requests)) {
    if (request.status === 'released' || request.status === 'transferred') continue
    usage[request.role === 'main' ? 'mainCalls' : 'contextCalls']++
    usage.reservedTokens += request.tokens
    if (request.status === 'settled') {
      usage.inputTokens += request.inputTokens!
      usage.outputTokens += request.outputTokens!
      budgetTokens += request.inputTokens! + request.outputTokens!
    } else {
      usage.unmeasuredCalls++
      budgetTokens += request.tokens
    }
  }
  return { ...usage, budgetTokens, hourly }
}

/** 校验持久账本与汇总一致；损坏记录不能被当作未使用的额度。 */
export function checkModelBudget(task: ContextTaskState): void {
  if (!task.modelBudget) return
  const { legacy, requests } = task.modelBudget
  if (!legacy || !requests || isArray(requests))
    throw contextFailure('TASK_STATE', '模型请求账本无效')
  for (const key of [
    'mainCalls',
    'contextCalls',
    'reservedTokens',
    'inputTokens',
    'outputTokens',
    'unmeasuredCalls',
  ] as const)
    if (!Number.isSafeInteger(legacy[key]) || legacy[key] < 0)
      throw contextFailure('TASK_STATE', '旧模型用量无效')
  for (const [id, request] of Object.entries(requests)) {
    if (
      !id ||
      id.length > 256 ||
      !request ||
      !['main', 'context'].includes(request.role) ||
      !['reserved', 'dispatched', 'settled', 'released', 'transferred'].includes(request.status) ||
      !Number.isSafeInteger(request.tokens) ||
      request.tokens < 1 ||
      !Number.isSafeInteger(request.hourStart) ||
      request.hourStart < 0 ||
      (request.status === 'settled'
        ? !Number.isSafeInteger(request.inputTokens! + request.outputTokens!) ||
          ![request.inputTokens, request.outputTokens].every(
            (value) => Number.isSafeInteger(value) && value! >= 0
          )
        : !isUndefined(request.inputTokens) || !isUndefined(request.outputTokens))
    )
      throw contextFailure('TASK_STATE', '模型请求记录无效')
    if (request.status === 'transferred') {
      const target =
        request.transferredTo && Object.hasOwn(requests, request.transferredTo)
          ? requests[request.transferredTo]
          : undefined
      if (
        !target ||
        target.status === 'transferred' ||
        target.role !== request.role ||
        target.tokens !== request.tokens ||
        target.hourStart !== request.hourStart
      )
        throw contextFailure('TASK_STATE', '模型预算转交记录无效')
    } else if (!isUndefined(request.transferredTo))
      throw contextFailure('TASK_STATE', '模型请求包含无效转交身份')
  }
  const expected = modelBudgetUsage(task.modelBudget, task.usage.hourly)
  for (const key of [
    'mainCalls',
    'contextCalls',
    'reservedTokens',
    'inputTokens',
    'outputTokens',
    'unmeasuredCalls',
    'budgetTokens',
  ] as const)
    if (task.usage[key] !== expected[key])
      throw contextFailure('TASK_STATE', '模型预算汇总与请求账本不一致')
}

/** 只修改预留时所属的小时桶，已经淡出的旧桶不抵扣当前用量。 */
function adjustHourly(
  hourly: Optional<ContextHourlyUsage>,
  start: number,
  delta: number,
  now: number
): ContextHourlyUsage {
  const current = rolledHourly(hourly, now)
  const key =
    start === current.start
      ? 'tokens'
      : start === current.start - ContextLimits.hourlyWindowMs
        ? 'previous'
        : undefined
  return key ? { ...current, [key]: Math.max(0, current[key] + delta) } : current
}

/** 对整个任务原子检查调用次数、已知实际加未知预留和小时额度。 */
function admittedHourly(
  task: ContextTaskState,
  tokens: number,
  limits: ContextViewLimits,
  now: number
): ContextHourlyUsage {
  if (tokens > limits.modelTokensPerHour)
    throw contextFailure('MODEL_BUDGET', '单次模型请求超过任务每小时用量上限')
  const usage = task.usage
  const charged = task.modelBudget
    ? usage.budgetTokens!
    : Math.max(usage.reservedTokens, usage.inputTokens + usage.outputTokens)
  if (
    usage.mainCalls + usage.contextCalls >= limits.modelCalls ||
    charged + tokens > limits.modelTokens
  )
    throw contextFailure('MODEL_BUDGET', '任务共享模型预算耗尽')
  const hourly = rolledHourly(usage.hourly, now)
  if (recentHourlyTokens(hourly, now) + tokens > limits.modelTokensPerHour)
    throw AppError.withFields('MODEL_RATE', '任务每小时的模型用量已到上限，稍后继续', {
      retryAfterMs: hourlyRetryMs(hourly, tokens, limits.modelTokensPerHour, now),
    })
  return { ...hourly, tokens: hourly.tokens + tokens }
}

/** 更新旧聚合接口；与新账本混用时不允许匿名退款抵扣其他请求的小时桶。 */
function updateLegacy(
  task: ContextTaskState,
  update: Exclude<ContextModelBudgetUpdate, { type: 'dispatch' | 'transfer' }>,
  limits: ContextViewLimits,
  now: number
): ContextTaskState {
  const before = task.modelBudget?.legacy ?? legacyUsage(task.usage)
  let hourly = task.usage.hourly
  let usage: ContextLegacyModelUsage
  if (update.type === 'usage') {
    usage = {
      ...before,
      inputTokens: before.inputTokens + update.inputTokens,
      outputTokens: before.outputTokens + update.outputTokens,
      unmeasuredCalls: Math.max(0, before.unmeasuredCalls - 1),
    }
  } else {
    const key = update.role === 'main' ? 'mainCalls' : 'contextCalls'
    const direction = update.type === 'reserve' ? 1 : -1
    if (update.type === 'reserve') hourly = admittedHourly(task, update.tokens, limits, now)
    else if (hourly && !task.modelBudget)
      hourly = { ...hourly, tokens: Math.max(0, hourly.tokens - update.tokens) }
    usage = {
      ...before,
      [key]: Math.max(0, before[key] + direction),
      reservedTokens: Math.max(0, before.reservedTokens + direction * update.tokens),
      unmeasuredCalls: Math.max(0, before.unmeasuredCalls + direction),
    }
  }
  if (!task.modelBudget) return { ...task, usage: { ...usage, hourly } }
  const modelBudget = { ...task.modelBudget, legacy: usage }
  return { ...task, modelBudget, usage: modelBudgetUsage(modelBudget, hourly) }
}

/** 请求生命周期在同一任务 CAS 内幂等更新；取消后仍能按原任务身份结算。 */
export function updateModelBudget(
  task: ContextTaskState,
  update: ContextModelBudgetUpdate,
  limits: ContextViewLimits,
  now: number
): ContextTaskState {
  if (update.type === 'reserve' || update.type === 'release') {
    if (
      !['main', 'context'].includes(update.role) ||
      !Number.isSafeInteger(update.tokens) ||
      update.tokens < 1
    )
      throw contextFailure('MODEL_BUDGET', '模型预留预算无效')
  } else if (
    update.type === 'usage' &&
    (!Number.isSafeInteger(update.inputTokens + update.outputTokens) ||
      ![update.inputTokens, update.outputTokens].every(
        (value) => Number.isSafeInteger(value) && value >= 0
      ))
  ) {
    throw contextFailure('MODEL_USAGE', '供应商用量无效')
  }
  if (!update.request && update.type !== 'dispatch' && update.type !== 'transfer')
    return updateLegacy(task, update, limits, now)
  const identity = update.request!
  if (!identity.taskId || identity.taskId !== task.id)
    throw contextFailure('MODEL_REQUEST_TASK', '模型回执不属于当前逻辑任务')
  if (!isString(identity.requestId) || !identity.requestId || identity.requestId.length > 256)
    throw contextFailure('MODEL_REQUEST_CONFLICT', '模型请求身份无效')
  const ledger = task.modelBudget ?? { legacy: legacyUsage(task.usage), requests: {} }
  const previous = Object.hasOwn(ledger.requests, identity.requestId)
    ? ledger.requests[identity.requestId]
    : undefined
  if (update.type === 'transfer') {
    if (
      !update.requestId ||
      update.requestId.length > 256 ||
      update.requestId === identity.requestId
    )
      throw contextFailure('MODEL_REQUEST_CONFLICT', '模型预算转交身份无效')
    if (previous?.status === 'transferred' && previous.transferredTo === update.requestId)
      return task
    if (previous?.status !== 'reserved' || Object.hasOwn(ledger.requests, update.requestId))
      throw contextFailure('MODEL_REQUEST_CONFLICT', '模型预算只能转交尚未派发的占位')
    const modelBudget: ContextModelBudgetState = {
      ...ledger,
      requests: {
        ...ledger.requests,
        [identity.requestId]: {
          ...previous,
          status: 'transferred',
          transferredTo: update.requestId,
        },
        [update.requestId]: previous,
      },
    }
    return { ...task, modelBudget, usage: modelBudgetUsage(modelBudget, task.usage.hourly) }
  }
  if (previous?.status === 'transferred') {
    if (update.type !== 'release')
      throw contextFailure('MODEL_REQUEST_CONFLICT', '模型预算已转交给实际请求')
    return updateModelBudget(
      task,
      {
        ...update,
        request: { ...identity, requestId: previous.transferredTo! },
      },
      limits,
      now
    )
  }
  let next: ContextModelBudgetRequest
  let hourly = task.usage.hourly
  if (update.type === 'reserve') {
    if (previous) {
      if (
        previous.role !== update.role ||
        previous.tokens !== update.tokens ||
        previous.status === 'released'
      )
        throw contextFailure('MODEL_REQUEST_CONFLICT', '模型请求身份已绑定另一预留')
      return task
    }
    hourly = admittedHourly(task, update.tokens, limits, now)
    next = { role: update.role, tokens: update.tokens, hourStart: hourly.start, status: 'reserved' }
  } else {
    if (!previous) throw contextFailure('MODEL_REQUEST_NOT_FOUND', '模型请求预留不存在')
    if (update.type === 'dispatch') {
      if (previous.status === 'released')
        throw contextFailure('MODEL_REQUEST_RELEASED', '已归还的模型请求不能派发')
      if (previous.status !== 'reserved') return task
      next = { ...previous, status: 'dispatched' }
    } else if (update.type === 'release') {
      if (previous.role !== update.role || previous.tokens !== update.tokens)
        throw contextFailure('MODEL_REQUEST_CONFLICT', '预算归还与原预留不匹配')
      if (previous.status === 'released') return task
      if (
        previous.status !== 'reserved' &&
        !(previous.status === 'dispatched' && update.confirmedNotDispatched)
      )
        throw contextFailure('MODEL_REQUEST_DISPATCHED', '已派发请求的未知用量必须保留占位')
      hourly = adjustHourly(hourly, previous.hourStart, -previous.tokens, now)
      next = { ...previous, status: 'released' }
    } else {
      if (previous.status === 'settled') {
        if (
          previous.inputTokens !== update.inputTokens ||
          previous.outputTokens !== update.outputTokens
        )
          throw contextFailure('MODEL_REQUEST_CONFLICT', '同一模型请求收到冲突用量')
        return task
      }
      if (previous.status !== 'dispatched')
        throw contextFailure('MODEL_REQUEST_NOT_DISPATCHED', '模型用量没有对应的实际派发')
      hourly = adjustHourly(
        hourly,
        previous.hourStart,
        update.inputTokens + update.outputTokens - previous.tokens,
        now
      )
      next = {
        ...previous,
        status: 'settled',
        inputTokens: update.inputTokens,
        outputTokens: update.outputTokens,
      }
    }
  }
  const modelBudget = { ...ledger, requests: { ...ledger.requests, [identity.requestId]: next } }
  return { ...task, modelBudget, usage: modelBudgetUsage(modelBudget, hourly) }
}
