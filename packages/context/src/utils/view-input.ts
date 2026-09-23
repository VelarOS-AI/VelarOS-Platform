import { isArray, isPlainObject, isString, isUndefined } from '@velaros-ai/core'

import { ContextPlannerLimits, ContextViewForms, TaskCapsuleLimits, ViewIntentLimits } from '../contract/constants.js'
import type { ContextPlannerDecision, TaskCapsule, ViewIntentInput } from '../types/context.js'

import { contextFailure } from './state.js'

/** 观察协议的入参不合约定：在任何状态改动之前拒绝，不默认填充，也不转换。 */
function viewInput(message: string): Error {
  return contextFailure('VIEW_SCHEMA', `观察协议不合法：${message}`)
}

/** 只含这些字段的普通对象。 */
function checkFields(value: unknown, allowed: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) throw viewInput(`${label} 必须是对象`)
  const extra = Object.keys(value).find((key) => !allowed.includes(key))
  if (extra) throw viewInput(`${label} 不接受字段 ${extra}`)
}

/** 长度在范围内的字符串。 */
function checkText(value: unknown, label: string, min: number, max: number = Number.MAX_SAFE_INTEGER): void {
  if (!isString(value) || value.length < min || value.length > max) throw viewInput(`${label} 需要 ${min} 到 ${max} 个字符`)
}

/** 范围内的整数。 */
function checkInteger(value: unknown, label: string, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw viewInput(`${label} 需要 ${min} 到 ${max} 的整数`)
}

/** 条数在范围内、每一项都合格的数组。 */
function checkList(value: unknown, label: string, min: number, max: number, item: (entry: unknown, label: string) => void): void {
  if (!isArray(value) || value.length < min || value.length > max) throw viewInput(`${label} 需要 ${min} 到 ${max} 项`)
  value.forEach((entry, index) => item(entry, `${label}[${index}]`))
}

/** 表示形式只能取约定的几种。 */
function checkForm(value: unknown, label: string): void {
  if (!(ContextViewForms as readonly unknown[]).includes(value)) throw viewInput(`${label} 只能是 ${ContextViewForms.join('、')}`)
}

/** 资源的选择器：整份、按行（从 1 数）或按符号名。 */
function checkSelector(value: unknown, label: string): void {
  if (!isPlainObject(value)) throw viewInput(`${label} 必须是对象`)
  if (value.kind === 'whole') return checkFields(value, ['kind'], label)
  if (value.kind === 'lines') {
    checkFields(value, ['kind', 'start', 'end'], label)
    checkInteger(value.start, `${label}.start`, 1, Number.MAX_SAFE_INTEGER)
    return checkInteger(value.end, `${label}.end`, 1, Number.MAX_SAFE_INTEGER)
  }
  if (value.kind === 'symbol') {
    checkFields(value, ['kind', 'name'], label)
    return checkText(value.name, `${label}.name`, 1)
  }
  throw viewInput(`${label}.kind 只能是 whole、lines 或 symbol`)
}

/** 观察目标：来源里的资源，或会话里的一份原文。 */
function checkTarget(value: unknown, label: string): void {
  if (!isPlainObject(value)) throw viewInput(`${label} 必须是对象`)
  if (value.kind === 'artifact') {
    checkFields(value, ['kind', 'ref'], label)
    checkFields(value.ref, ['sessionId', 'id'], `${label}.ref`)
    checkText(value.ref.sessionId, `${label}.ref.sessionId`, 1)
    return checkText(value.ref.id, `${label}.ref.id`, 1)
  }
  if (value.kind === 'resource') {
    checkFields(value, ['kind', 'sourceId', 'resourceId', 'selector'], label)
    checkText(value.sourceId, `${label}.sourceId`, 1)
    checkText(value.resourceId, `${label}.resourceId`, 1)
    if (!isUndefined(value.selector)) checkSelector(value.selector, `${label}.selector`)
    return
  }
  throw viewInput(`${label}.kind 只能是 artifact 或 resource`)
}

/** 观察的时间要求：步后、历史，或指定快照。 */
function checkTime(value: unknown, label: string): void {
  if (!isPlainObject(value)) throw viewInput(`${label} 必须是对象`)
  if (value.kind === 'after-step' || value.kind === 'historical') return checkFields(value, ['kind'], label)
  if (value.kind === 'snapshot') {
    checkFields(value, ['kind', 'snapshotId'], label)
    return checkText(value.snapshotId, `${label}.snapshotId`, 1)
  }
  throw viewInput(`${label}.kind 只能是 after-step、historical 或 snapshot`)
}

/** 模型提出的一项观察需求，按 `ViewIntentInput` 与 `ViewIntentLimits` 逐项核对。 */
export function checkViewIntent(value: unknown): asserts value is ViewIntentInput {
  const common = ['kind', 'purpose', 'importance', 'time', 'forms', 'maxTokensHint']
  if (!isPlainObject(value)) throw viewInput('观察需求必须是对象')
  if (value.kind === 'direct') checkFields(value, [...common, 'target'], '观察需求')
  else if (value.kind === 'semantic') checkFields(value, [...common, 'objective', 'anchors'], '观察需求')
  else throw viewInput('kind 只能是 direct 或 semantic')
  if (!isUndefined(value.purpose)) checkText(value.purpose, 'purpose', 0, ViewIntentLimits.purposeChars)
  if (!isUndefined(value.importance) && value.importance !== 'required' && value.importance !== 'preferred') throw viewInput('importance 只能是 required 或 preferred')
  if (!isUndefined(value.time)) checkTime(value.time, 'time')
  if (!isUndefined(value.forms)) checkList(value.forms, 'forms', 1, ViewIntentLimits.forms, checkForm)
  if (!isUndefined(value.maxTokensHint)) checkInteger(value.maxTokensHint, 'maxTokensHint', 1, ViewIntentLimits.maxTokensHint)
  if (value.kind === 'direct') return checkTarget(value.target, 'target')
  checkText(value.objective, 'objective', 1, ViewIntentLimits.objectiveChars)
  if (!isUndefined(value.anchors)) checkList(value.anchors, 'anchors', 0, ViewIntentLimits.anchors, checkTarget)
}

/** 上下文规划器的一次决定，按 `ContextPlannerDecision` 与 `ContextPlannerLimits` 逐项核对。 */
export function checkPlannerDecision(value: unknown): asserts value is ContextPlannerDecision {
  const id = (entry: unknown, label: string) => checkText(entry, label, 0)
  if (!isPlainObject(value)) throw viewInput('规划决定必须是对象')
  switch (value.kind) {
    case 'select':
      checkFields(value, ['kind', 'selections'], '规划决定')
      return checkList(value.selections, 'selections', 0, ContextPlannerLimits.selections, (entry, label) => {
        checkFields(entry, ['candidateId', 'intentIds', 'form'], label)
        id(entry.candidateId, `${label}.candidateId`)
        checkList(entry.intentIds, `${label}.intentIds`, 1, ContextPlannerLimits.intentIds, id)
        checkForm(entry.form, `${label}.form`)
      })
    case 'search':
      checkFields(value, ['kind', 'intentId', 'sourceId', 'query', 'limit'], '规划决定')
      id(value.intentId, 'intentId')
      id(value.sourceId, 'sourceId')
      checkText(value.query, 'query', 1, ContextPlannerLimits.queryChars)
      return checkInteger(value.limit, 'limit', 1, ContextPlannerLimits.searchLimit)
    case 'inspect':
      checkFields(value, ['kind', 'candidateIds'], '规划决定')
      return checkList(value.candidateIds, 'candidateIds', 1, ContextPlannerLimits.candidateIds, id)
    case 'insufficient':
      checkFields(value, ['kind', 'intentIds', 'reason'], '规划决定')
      checkList(value.intentIds, 'intentIds', 1, ContextPlannerLimits.intentIds, id)
      return checkText(value.reason, 'reason', 1, ContextPlannerLimits.reasonChars)
    default:
      throw viewInput('kind 只能是 select、search、inspect 或 insufficient')
  }
}

/** 模型对任务计划的一次修改（只给要改的字段），按 `TaskCapsule` 与 `TaskCapsuleLimits` 逐项核对。 */
export function checkTaskCapsule(value: unknown): asserts value is Partial<TaskCapsule> {
  const item = (entry: unknown, label: string) => checkText(entry, label, 0, TaskCapsuleLimits.itemChars)
  checkFields(value, ['nextObjective', 'hypotheses', 'decisions', 'openQuestions'], 'plan')
  if (!isUndefined(value.nextObjective)) checkText(value.nextObjective, 'plan.nextObjective', 0, TaskCapsuleLimits.objectiveChars)
  for (const key of ['hypotheses', 'decisions', 'openQuestions']) {
    if (!isUndefined(value[key])) checkList(value[key], `plan.${key}`, 0, TaskCapsuleLimits.items, item)
  }
}
