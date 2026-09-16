import { isArray, isEmpty, isNonBlankString, isNull, isNumber, isPlainObject, isString } from '@velaros-ai/core'

import type { AgentPlan, AgentPlanStep, AgentPlanStepStatus } from '../../types/product-session.js'

/**
 * 把纯文本步骤列表变成带 id 与初始状态的步骤对象，状态一律 `pending`。
 * id 由**位置**生成（`step-1`、`step-2`…）而非内容，所以重写草稿后同一位置仍是同一个 id：
 * 之前落在 `step-2` 上的 `plan.step.updated` 会继续作用在新的第二步上。
 */
export function createSteps(values: readonly string[]): AgentPlanStep[] {
  return values.map((text, index) => ({ id: `step-${index + 1}`, text, status: 'pending' }))
}

/**
 * 收敛一份计划的步骤文本：逐条去空白（有空白条直接抛），步数必须落在 1–24 之间，单步文本超 1000 字符则截断保留前 1000。
 * 两种越界的处理故意不同——**步数越界抛错**（多写少写几步是调用方必须自己改的事，替他删步等于篡改计划），
 * **单步过长静默截断**（截掉的部分不再找得回来，但一整篇文档塞进一步会被带进之后每一轮上下文）。
 */
export function normalizeSteps(values: readonly string[]): string[] {
  const steps = values.map((value) => requireText(value, '计划步骤'))
  if (isEmpty(steps) || steps.length > 24) throw new Error('一份计划的步骤数必须在 1 到 24 之间：多写少写几步请自己改，这里不会替你删减。')
  return steps.map((step) => step.slice(0, 1_000))
}

/**
 * 交出计划前把它和每个步骤都 `Object.freeze` 一层。计划是由事件流重放出来的派生物：
 * 调用方就地改返回对象并不会写进事件，下次重放又变回原样；冻上让这种改动当场抛错，而不是悄悄失效。
 */
export function freezePlan(plan: AgentPlan): AgentPlan {
  return Object.freeze({
    ...plan,
    steps: Object.freeze(plan.steps.map((step) => Object.freeze({ ...step }))),
  })
}

/**
 * 判定一个 `plan.created` 事件的 payload 能不能当作重放的起点：普通对象，`id`/`sessionId`/`objective` 都是字符串，
 * `steps` 每条都过 `isPlanStep`，`status` **只能是 `draft`**（计划只从草稿态诞生），`reviewFeedback` 是 null 或字符串，
 * 两个时间戳是数字。有一项不满足就整条事件跳过——宁可当这个计划不存在，也不让半截 payload 变成计划再往后叠状态。
 */
export function isPlan(value: unknown): value is AgentPlan {
  return isRecord(value)
    && isString(value.id)
    && isString(value.sessionId)
    && isString(value.objective)
    && isArray(value.steps)
    && value.steps.every(isPlanStep)
    && value.status === 'draft'
    && (isNull(value.reviewFeedback) || isString(value.reviewFeedback))
    && isNumber(value.createdAt)
    && isNumber(value.updatedAt)
}

/**
 * 判定一个 `plan.drafted` 事件的 payload 够不够改写现有计划：`objective` 是字符串、`steps` 每条都过 `isPlanStep` 即为真。
 * 不查 `id`——调用方在重放循环里已经先比过 `payload.id === plan.id`，这里只管形状。
 */
export function isPlanDraft(value: Record<string, unknown>): value is Record<string, unknown> & {
  objective: string
  steps: AgentPlanStep[]
} {
  return isString(value.objective)
    && isArray(value.steps)
    && value.steps.every(isPlanStep)
}

/** 一个步骤对象合法的条件：普通对象，`id` 与 `text` 都是字符串，`status` 是四个已知状态之一。计划里每条步骤都要过它，才不会把别的事件 payload 误当成步骤。 */
export function isPlanStep(value: unknown): value is AgentPlanStep {
  return isRecord(value)
    && isString(value.id)
    && isString(value.text)
    && isPlanStepStatus(value.status)
}

/** 判定一个 `plan.step.updated` 事件的 payload 可不可用：有字符串 `stepId` 且 `status` 是合法步骤状态即为真。为假时整条事件被跳过，那一步的状态停在原处，不会被写成 `undefined`。 */
export function isPlanStepUpdate(value: Record<string, unknown>): value is Record<string, unknown> & {
  stepId: string
  status: AgentPlanStepStatus
} {
  return isString(value.stepId) && isPlanStepStatus(value.status)
}

/** 步骤状态的白名单判定：只有 `pending`、`in_progress`、`complete`、`skipped` 四个为真。历史事件里写着别的值（旧版本留下的或手改过的）一律当非法，不会被放进计划。 */
export function isPlanStepStatus(value: unknown): value is AgentPlanStepStatus {
  return value === 'pending' || value === 'in_progress' || value === 'complete' || value === 'skipped'
}

/** 取一个必填文本：去首尾空白后必须非空，否则抛 `${label} 不能为空：…`；返回的是去过空白的值，调用方要用返回值而不是原值。 */
export function requireText(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} 不能为空：去掉首尾空白后必须仍有内容。`)
  return normalized
}

/**
 * 把事件 payload 里可有可无的文本字段（如驳回意见 `feedback`）收敛成两种形态：有内容就返回去空白后的字符串，
 * 其余一切（缺席、空串、纯空白、非字符串）都返回 `null`。不留空串这个第三态，界面上就不用同时判 `!= null` 和 `!== ''`。
 */
export function stringValue(value: unknown): Nullable<string> {
  return isNonBlankString(value) ? value.trim() : null
}

/** 只有普通对象才为真（数组、null、类实例一律为假）。事件 payload 是任意 JSON，重放时取字段前先过它。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value)
}
