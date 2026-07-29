import type { BrowserPageNavigationOptions, BrowserPageScrollOptions, BrowserRecipeSkeleton, BrowserRecipeSkeletonStep, BrowserTargetActionOptions, BrowserWaitForSelectorOptions } from '@velaros-ai/browser-core'
import { isPresent, toOptional } from '@velaros-ai/core'

const ExecutableRecipeStepKinds = new Set<BrowserRecipeSkeletonStep['kind']>([
  'click_action',
  'fill_field',
  'follow_link',
  'review_page',
  'review_section',
  'extract_links',
  'wait_for_selector',
  'scroll',
  'navigate',
  'extract_table',
  'extract_list',
])

/** 判断 recipe step 是否属于当前 runner 支持执行的步骤类型。 */
function isExecutableRecipeStep(step: BrowserRecipeSkeletonStep): boolean {
  return ExecutableRecipeStepKinds.has(step.kind)
}

/** recipe 步骤在预览/执行过程中的状态。 */
export type BrowserRecipeRunStepStatus =
  | 'ready'
  | 'executed'
  | 'skipped'
  | 'not_found'
  | 'missing_input'

/** 单个 recipe 步骤的预览或执行结果。 */
export interface BrowserRecipeRunStepResult {
  /** recipe step id。 */
  id: string
  /** step 类型。 */
  kind: BrowserRecipeSkeletonStep['kind']
  /** 当前步骤状态。 */
  status: BrowserRecipeRunStepStatus
  /** 实际要执行的浏览器动作。 */
  action: Nullable<'click' | 'fill'>
  /** 给模型/用户看的状态说明。 */
  message: string
  /** fill_field 对应的 input.name。 */
  inputName?: string
  /** target CSS，便于调试未命中。 */
  targetCss?: LooseOptional<string>
  /** target role，便于调试未命中。 */
  targetRole?: LooseOptional<string>
  /** target text，便于调试未命中。 */
  targetText?: LooseOptional<string>
  /** runtime 返回的原始执行结果。 */
  result?: unknown
  /** 执行错误信息。 */
  error?: string
}

export type BrowserRecipeTargetActionOptions = BrowserTargetActionOptions & {
  action: 'click' | 'fill'
}

export type BrowserRecipeStepOperation =
  | { kind: 'target_action'; action: BrowserRecipeTargetActionOptions }
  | { kind: 'inspect_page' }
  | { kind: 'navigate'; options: BrowserPageNavigationOptions }
  | { kind: 'scroll'; options: BrowserPageScrollOptions }
  | { kind: 'wait_for_selector'; options: BrowserWaitForSelectorOptions }
  | { kind: 'extract_table'; selector?: string; tableIndex?: number; maxRows?: number }
  | { kind: 'extract_list'; selector?: string; maxItems?: number }

/** 单个步骤的执行计划：是否 ready、动作是什么、缺什么输入。 */
export interface BrowserRecipeStepPlan {
  /** 原始 recipe step。 */
  step: BrowserRecipeSkeletonStep
  /** 预执行状态。 */
  status: Extract<BrowserRecipeRunStepStatus, 'ready' | 'skipped' | 'missing_input'>
  /** 可直接交给 browser runtime 的操作。 */
  operation: Nullable<BrowserRecipeStepOperation>
  /** 计划说明。 */
  message: string
  /** 该步骤使用的 input.name。 */
  inputName?: string
}

function readRecipeStepSelector(step: BrowserRecipeSkeletonStep): Nullable<string> {
  return step.selector?.trim() || step.target?.css?.trim() || null
}

function requiresRecipeStepTarget(step: BrowserRecipeSkeletonStep): boolean {
  return step.kind === 'click_action' || step.kind === 'fill_field' || step.kind === 'follow_link'
}

function buildTargetActionPlan(
  step: BrowserRecipeSkeletonStep,
  inputs: Record<string, string>
): BrowserRecipeStepPlan {
  if (!step.target) return {
      step,
      status: 'skipped',
      operation: null,
      message: '缺少 target，已跳过。',
    }

  if (step.kind === 'fill_field') {
    if (!step.input) return {
        step,
        status: 'skipped',
        operation: null,
        message: '缺少 input schema，已跳过。',
      }

    const inputName = step.input.name
    const hasInput = !Object.is(inputs[inputName], undefined)
    if (!hasInput) return {
        step,
        status: step.input.required ? 'missing_input' : 'skipped',
        operation: null,
        message: step.input.required ? `缺少必填输入：${inputName}` : `缺少可选输入：${inputName}`,
        inputName,
      }

    return {
      step,
      status: 'ready',
      operation: {
        kind: 'target_action',
        action: {
          action: 'fill',
          target: step.target,
          value: inputs[inputName],
        },
      },
      message: '准备填入字段。',
      inputName,
    }
  }

  return {
    step,
    status: 'ready',
    operation: {
      kind: 'target_action',
      action: {
        action: 'click',
        target: step.target,
      },
    },
    message: '准备点击目标。',
  }
}

/** 将一个 recipe step 编译成可执行动作或跳过/缺输入状态。 */
function buildRecipeStepPlan(
  step: BrowserRecipeSkeletonStep,
  inputs: Record<string, string>
): BrowserRecipeStepPlan {
  if (isPresent(step.condition)) {
    const resolved = step.condition.replace(/\{\{(\w+)\}\}/g, (_m, key) => inputs[key] ?? '')
    if (!resolved.trim()) return {
        step,
        status: 'skipped',
        operation: null,
        message: `条件不满足（condition: ${step.condition}），已跳过。`,
      }
  }

  if (!isExecutableRecipeStep(step)) return {
      step,
      status: 'skipped',
      operation: null,
      message: '不可执行步骤，已跳过。',
    }

  if (requiresRecipeStepTarget(step)) return buildTargetActionPlan(step, inputs)

  switch (step.kind) {
    case 'review_page':
      return {
        step,
        status: 'ready',
        operation: { kind: 'inspect_page' },
        message: '准备检查当前页面。',
      }
    case 'review_section':
      return {
        step,
        status: 'ready',
        operation: { kind: 'inspect_page' },
        message: step.heading
          ? `准备检查分区“${step.heading}”。`
          : '准备检查页面分区。',
      }
    case 'extract_links':
      return {
        step,
        status: 'ready',
        operation: { kind: 'inspect_page' },
        message: '准备提取页面链接。',
      }
    case 'navigate': {
      const action = step.navigationAction ?? (step.href?.trim() ? 'goto' : 'reload')
      if (action === 'goto' && !step.href?.trim()) return {
          step,
          status: 'skipped',
          operation: null,
          message: 'navigate(goto) 缺少 href，已跳过。',
        }

      return {
        step,
        status: 'ready',
        operation: {
          kind: 'navigate',
          options: {
            action,
            url: step.href?.trim() || undefined,
          },
        },
        message:
          action === 'goto'
            ? `准备跳转到 ${step.href}.`
            : `准备执行导航动作：${action}。`,
      }
    }
    case 'scroll':
      return {
        step,
        status: 'ready',
        operation: {
          kind: 'scroll',
          options: {
            direction: step.direction,
            amount: step.amount,
            x: step.scrollX,
            y: step.scrollY,
          },
        },
        message: '准备滚动页面。',
      }
    case 'wait_for_selector': {
      const selector = readRecipeStepSelector(step)
      if (!selector) return {
          step,
          status: 'skipped',
          operation: null,
          message: 'wait_for_selector 缺少 selector，已跳过。',
        }

      return {
        step,
        status: 'ready',
        operation: {
          kind: 'wait_for_selector',
          options: {
            selector,
            visible: step.visible,
            timeoutMs: step.timeoutMs,
          },
        },
        message: `准备等待 selector：${selector}。`,
      }
    }
    case 'extract_table':
      return {
        step,
        status: 'ready',
        operation: {
          kind: 'extract_table',
          selector: toOptional(readRecipeStepSelector(step)),
          tableIndex: step.tableIndex,
          maxRows: step.maxRows,
        },
        message: '准备提取表格数据。',
      }
    case 'extract_list':
      return {
        step,
        status: 'ready',
        operation: {
          kind: 'extract_list',
          selector: toOptional(readRecipeStepSelector(step)),
          maxItems: step.maxItems,
        },
        message: '准备提取列表数据。',
      }
    default:
      return {
        step,
        status: 'skipped',
        operation: null,
        message: '不可执行步骤，已跳过。',
      }
  }
}

function previewActionForOperation(
  operation: Nullable<BrowserRecipeStepOperation>
): Nullable<'click' | 'fill'> {
  if (!operation || operation.kind !== 'target_action') return null

  return operation.action.action
}

/** 收集 recipe 声明的必填/可选输入名。 */
function getRecipeInputNames(recipe: BrowserRecipeSkeleton): {
  requiredInputNames: string[]
  optionalInputNames: string[]
} {
  const requiredInputNames = new Set<string>()
  const optionalInputNames = new Set<string>()

  for (const step of recipe.suggestedSteps) {
    if (!step.input) {
      continue
    }

    if (step.input.required) {
      requiredInputNames.add(step.input.name)
    } else {
      optionalInputNames.add(step.input.name)
    }
  }

  return {
    requiredInputNames: [...requiredInputNames],
    optionalInputNames: [...optionalInputNames],
  }
}

/** 为整个 recipe 构建执行计划；dryRun 和真实执行都会先走这里。 */
export function buildRecipeExecutionPlan(
  recipe: BrowserRecipeSkeleton,
  inputs: Record<string, string>,
  maxSteps?: number
): {
  executableSteps: BrowserRecipeSkeletonStep[]
  limitedSteps: BrowserRecipeSkeletonStep[]
  inputNames: {
    requiredInputNames: string[]
    optionalInputNames: string[]
  }
  unusedInputNames: string[]
  stepPlan: BrowserRecipeStepPlan[]
  missingInputs: Array<{
    stepId: string
    name: string
    label: string
    type: string
    required: boolean
  }>
  previewStepResults: BrowserRecipeRunStepResult[]
  readyStepCount: number
  missingInputCount: number
  skippedStepCount: number
} {
  const executableSteps = recipe.suggestedSteps.filter(isExecutableRecipeStep)
  const limitedSteps = executableSteps.slice(0, maxSteps ?? executableSteps.length)
  const inputNames = getRecipeInputNames(recipe)
  const unusedInputNames = Object.keys(inputs).filter(
    (inputName) =>
      !inputNames.requiredInputNames.includes(inputName) &&
      !inputNames.optionalInputNames.includes(inputName)
  )
  const stepPlan = limitedSteps.map((step) => buildRecipeStepPlan(step, inputs))
  const missingInputs = stepPlan
    .filter((entry) => entry.status === 'missing_input')
    .map((entry) => ({
      stepId: entry.step.id,
      name: entry.step.input?.name ?? entry.inputName ?? entry.step.id,
      label: entry.step.input?.label ?? entry.step.text ?? entry.step.id,
      type: entry.step.input?.type ?? 'text',
      required: entry.step.input?.required ?? true,
    }))
  const previewStepResults: BrowserRecipeRunStepResult[] = stepPlan.map((entry) => ({
    id: entry.step.id,
    kind: entry.step.kind,
    status: entry.status,
    action: previewActionForOperation(entry.operation),
    message: entry.message,
    inputName: entry.inputName,
  }))

  return {
    executableSteps,
    limitedSteps,
    inputNames,
    unusedInputNames,
    stepPlan,
    missingInputs,
    previewStepResults,
    readyStepCount: previewStepResults.filter((step) => step.status === 'ready').length,
    missingInputCount: missingInputs.length,
    skippedStepCount: previewStepResults.filter(
      (step) => step.status !== 'ready' && step.status !== 'executed'
    ).length,
  }
}

export type BrowserRecipeExecutionPlan = ReturnType<typeof buildRecipeExecutionPlan>
