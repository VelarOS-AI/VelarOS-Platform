import { isArray, isEmpty,isNumber } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { UserPlanStatus } from './Plans'

/**
 * 计划/目标共享的步骤引擎。
 *
 * Plans 与 Goals 的步骤形状完全同构(`{id?, step, objective?, status}`),此前
 * 匹配/完成/晋升/引用清单四套逻辑是两份近拷贝(修 scaffold-clobber 时逐行比对过)。
 * 本模块收敛为单一实现;两侧语义差异(已解决状态集/晋升回退策略)显式参数化,
 * 不做静默行为漂移。匹配器统一采用更宽容的版本(NFKC/全角冒号归一/唯一子串命中)。
 */
interface UserStep {
  /** 稳定步骤 id;通常没有(创建时未指定),引用优先用序号。 */
  id?: string
  /** 步骤标题。 */
  step: string
  /** 可选步骤目标。 */
  objective?: string
  /** 当前状态。 */
  status: UserPlanStatus
}

interface StepEngineOptions {
  /** 错误文案里的种类名(plan/goal),保持与历史报错逐字一致。 */
  kindLabel: 'plan' | 'goal'
  /** 匹配失败时清单前缀,如「当前计划步骤」/「当前目标步骤」。 */
  listLabel: string
  /** 空列表报错文案。 */
  emptyMessage: string
  /** 计入 allStepsResolved 的终态集合。 */
  resolvedStatuses: readonly UserPlanStatus[]
  /**
   * 晋升回退策略:完成一步后若无 in_progress,优先晋升「完成位之后的第一个 pending」;
   * true 时找不到则回退「任意位置的第一个 pending」(goal 语义),false 则不晋升(plan 语义)。
   */
  promoteFallbackAnywhere: boolean
}

interface StepCompletionResult<T extends UserStep> {
  steps: T[]
  completedStep: T
  completedSteps: T[]
  promotedStep: Nullable<T>
  allStepsResolved: boolean
}

type StepRef = string | number

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

function validStepIndex(steps: readonly UserStep[], oneBased: number): number {
  if (!Number.isInteger(oneBased) || oneBased < 1 || oneBased > steps.length) return -1
  return oneBased - 1
}

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
    throw new AppError('VALIDATION', 'complete_step requires at least one plan step reference.')
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

function allResolved(steps: readonly UserStep[], options: StepEngineOptions): boolean {
  return steps.every((step) => options.resolvedStatuses.includes(step.status))
}

export { completeSteps, describeStepRefs, describeStepRefsForModel, findStepIndex }
export type { StepCompletionResult, StepEngineOptions, StepRef, UserStep }
