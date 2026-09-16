import { isArray, isEmpty,isNumber } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { StepCompletionResult, StepEngineOptions, StepRef,UserPlanStatus, UserStep } from '../../types/builtin.js'


/** 把步骤格式化成可引用清单:"1. 标题 (id:x) [状态]; …",供匹配失败时回给模型自纠。 */
function describeStepRefs(steps: readonly UserStep[]): string {
  return steps
    .map((step, index) => {
      const idPart = step.id ? ` (id:${step.id})` : ''
      return `${index + 1}. ${step.step}${idPart} [${step.status}]`
    })
    .join('; ')
}

/** 回带每步的可引用 ref(1-based 序号)+标题+状态,供模型下次 complete_step 照 ref 传,不必猜 id。 */
function describeStepRefsForModel<T extends { status: string }>(
  steps: readonly T[],
  getTitle: (step: T) => string
): Array<{ ref: number; title: string; status: string }> {
  return steps.map((step, index) => ({
    ref: index + 1,
    title: getTitle(step),
    status: step.status,
  }))
}

/**
 * 步骤引用解析:1-based 序号(数字或数字串)→ 精确 id → 归一化标题精确 → 唯一子串。
 * 归一化 = NFKC + 折叠空白 + 全角冒号→半角 + 小写(对中英混排标题宽容)。
 */
function findStepIndex(steps: readonly UserStep[], stepRef: StepRef): number {
  if (isNumber(stepRef)) return validStepIndex(steps, stepRef)

  const raw = String(stepRef).trim()
  if (!raw) return -1

  const numeric = Number(raw)
  if (Number.isInteger(numeric) && String(numeric) === raw) return validStepIndex(steps, numeric)

  const byId = steps.findIndex((step) => step.id === raw)
  if (byId >= 0) return byId

  const normalizedRef = normalizeStepText(raw)
  const exact = steps.findIndex((step) => normalizeStepText(step.step) === normalizedRef)
  if (exact >= 0) return exact

  const containing = steps
    .map((step, index) => ({ index, title: normalizeStepText(step.step) }))
    .filter(
      ({ title }) =>
        title.length >= 4 && (title.includes(normalizedRef) || normalizedRef.includes(title))
    )
  return containing.length === 1 ? containing[0]!.index : -1
}

/**
 * 把模型给的 1-based 序号换成数组下标：必须是整数且落在 1..steps.length 内，否则返回 -1。
 * 越界不夹取——夹到首尾会把「引用错了」变成「静默收尾了另一步」，只能判不匹配让上层报可操作错误。
 */
function validStepIndex(steps: readonly UserStep[], oneBased: number): number {
  if (!Number.isInteger(oneBased) || oneBased < 1 || oneBased > steps.length) return -1
  return oneBased - 1
}

/**
 * 归一步骤标题以便宽容匹配：NFKC 正规化（全角字母数字折成半角）→ trim → 连续空白折成一个空格 →
 * 全角冒号 `：` 换半角 `:` → 转小写。缺席返回空串。
 * 这几刀专治中英混排标题：模型复述标题时常在冒号、空格、全半角上与原文差一点。
 */
function normalizeStepText(text: LooseOptional<string>): string {
  return (
    text
      ?.normalize('NFKC')
      .trim()
      .replace(/\s+/gu, ' ')
      .replace(/：/gu, ':')
      .toLowerCase() ?? ''
  )
}

/**
 * 判断一个步骤状态能否被 complete_step 收尾：`pending`、`in_progress`、`completed` 三种为真。
 * `completed` 也算真是刻意的——重复收尾同一步是幂等 no-op，不该报错。
 * `skipped` / `failed` 为假，它们要么已由本引擎算作已解决、要么得先在 steps 里改状态。
 */
function isCompletableStepStatus(status: UserPlanStatus): boolean {
  return status === 'pending' || status === 'in_progress' || status === 'completed'
}

/** 完成一个或多个引用步骤;匹配失败抛可操作错误(列出有效步骤清单)。 */
function completeSteps<T extends UserStep>(
  steps: readonly T[],
  stepRefs: StepRef | readonly StepRef[],
  options: StepEngineOptions
): StepCompletionResult<T> {
  const refs: readonly StepRef[] = isArray(stepRefs) ? (stepRefs as readonly StepRef[]) : [stepRefs as StepRef]
  if (isEmpty(refs)) {
    throw new AppError('VALIDATION', 'complete_step 至少要给一个计划步骤引用（步骤 id 或序号），这次一个都没传。')
  }

  let nextSteps = steps.map((step) => ({ ...step }))
  const completedSteps: T[] = []
  let promotedStep: Nullable<T> = null

  for (const stepRef of refs) {
    const completion = completeSingleStep(nextSteps, stepRef, options)
    nextSteps = completion.steps
    completedSteps.push(completion.completedStep)
    if (completion.promotedStep) promotedStep = completion.promotedStep
  }

  return {
    steps: nextSteps,
    completedStep: completedSteps[completedSteps.length - 1]!,
    completedSteps,
    promotedStep,
    allStepsResolved: allResolved(nextSteps, options),
  }
}

/**
 * 收尾一个被引用的步骤，返回全新的步骤数组（不改入参）。三条分支：
 * ① 引用匹配不上 → 抛 `VALIDATION`，错误里附**当前全部步骤的可引用清单**（序号+标题+状态），
 *    让模型照着改而不是自造 id；步骤列表为空时抛 options 里那句 `emptyMessage`。
 * ② 目标步骤已处在本引擎语义下的「已解决」态（plan 的 failed、goal 的 skipped 等，`completed` 除外）
 *    → 幂等 no-op，保留原状态不报错——steps 与 complete_step 同轮提交时这是常态。
 * ③ 状态不可收尾（如 goals 的 failed）→ 抛 `VALIDATION` 并给出路：先在 steps 里改成 completed/skipped。
 * 正常收尾把该步置 `completed`。以上三种落地路径（②与正常收尾）都会顺带做一件事：
 * 当前**没有任何 in_progress** 时自动晋升下一个 pending 步为 in_progress，模型不必额外发一轮。
 */
function completeSingleStep<T extends UserStep>(
  steps: readonly T[],
  stepRef: StepRef,
  options: StepEngineOptions
): StepCompletionResult<T> {
  if (isEmpty(steps)) {
    throw new AppError('VALIDATION', options.emptyMessage)
  }

  const index = findStepIndex(steps, stepRef)
  if (index < 0) {
    // 可操作错误:列出当前有效步骤(1-based 序号 + 标题 + 状态),让模型不必瞎猜 id。
    throw new AppError(
      'VALIDATION',
      `No ${options.kindLabel} step matches "${String(stepRef)}"。用 1-based 序号或精确标题引用(步骤通常没有 id,别自造 id)。${options.listLabel}:${describeStepRefs(steps)}`
    )
  }

  const currentStep = steps[index]!
  // 宽容铁律:complete_step 指向「本引擎语义下已解决」的步骤(如 goals 的 skipped、
  // plans 的 failed)= 模型在说"这步已收尾",幂等 no-op 保留原状态,不作为错误——
  // steps 与 complete_step 允许同传,steps 先落后引用步常已是 skipped(真机 F5 五连拒实证)。
  if (options.resolvedStatuses.includes(currentStep.status) && currentStep.status !== 'completed') {
    const nextSteps = steps.map((step) => ({ ...step }))
    let promotedStep: Nullable<T> = null
    if (!nextSteps.some((step) => step.status === 'in_progress')) {
      const promotedIndex = findPromotableStepIndex(nextSteps, index, options)
      if (promotedIndex >= 0) {
        promotedStep = { ...nextSteps[promotedIndex]!, status: 'in_progress' as const }
        nextSteps[promotedIndex] = promotedStep
      }
    }
    return {
      steps: nextSteps,
      completedStep: nextSteps[index]!,
      completedSteps: [],
      promotedStep,
      allStepsResolved: allResolved(nextSteps, options),
    }
  }
  if (!isCompletableStepStatus(currentStep.status)) {
    // 未解决且不可收尾(如 goals 的 failed):给出出路而不是死胡同。
    throw new AppError(
      'VALIDATION',
      `Step "${currentStep.step}" is ${currentStep.status}; 若该步已解决,在 steps 里把它改成 completed/skipped 再提交;complete_step 只收尾 pending/in_progress/completed 的步骤。`
    )
  }

  const nextSteps = steps.map((step) => ({ ...step }))
  const completedStep = {
    ...nextSteps[index]!,
    status: 'completed' as const,
  }
  nextSteps[index] = completedStep

  let promotedStep: Nullable<T> = null
  if (!nextSteps.some((step) => step.status === 'in_progress')) {
    const promotedIndex = findPromotableStepIndex(nextSteps, index, options)
    if (promotedIndex >= 0) {
      promotedStep = {
        ...nextSteps[promotedIndex]!,
        status: 'in_progress' as const,
      }
      nextSteps[promotedIndex] = promotedStep
    }
  }

  return {
    steps: nextSteps,
    completedStep,
    completedSteps: [completedStep],
    promotedStep,
    allStepsResolved: allResolved(nextSteps, options),
  }
}

/**
 * 挑出自动晋升为 in_progress 的下一步：优先取**刚收尾那步之后**的第一个 pending。
 * 后面没有了才看 `promoteFallbackAnywhere`——为 true 时回头找全表第一个 pending（goals 用），
 * 为 false 就返回 -1、不晋升（plans 用，计划步骤有先后，往回跳会打乱模型自己的顺序）。
 */
function findPromotableStepIndex(
  steps: readonly UserStep[],
  completedIndex: number,
  options: StepEngineOptions
): number {
  const afterCompleted = steps.findIndex(
    (step, index) => index > completedIndex && step.status === 'pending'
  )
  if (afterCompleted >= 0) return afterCompleted
  if (!options.promoteFallbackAnywhere) return -1
  return steps.findIndex((step) => step.status === 'pending')
}

/**
 * 判断是否每一步都落到了本引擎的「已解决」状态集（`options.resolvedStatuses`，plan 含 failed、
 * goal 含 skipped）。空步骤列表按 `every` 语义为真。为真意味着整个计划/目标可以收口了。
 */
function allResolved(steps: readonly UserStep[], options: StepEngineOptions): boolean {
  return steps.every((step) => options.resolvedStatuses.includes(step.status))
}

export { completeSteps, describeStepRefs, describeStepRefsForModel, findStepIndex }
