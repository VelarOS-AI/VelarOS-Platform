import { BrowserPageScriptBuilder } from '@velaros-ai/browser-core'
import { AppError } from '@velaros-ai/core/error'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type {
  BrowserRecipeRunStepResult,
  BrowserRecipeStepOperation,
  BrowserRecipeStepPlan,
} from './RecipePlan'
import { performTargetActionWithRecovery } from './TargetActionRecovery'
import type { ToolContext } from './Types'

/** 执行 recipe 步骤列表的入参。 */
interface ExecuteBrowserRecipeStepsInput {
  /** 已经由 plan helper 编译好的步骤计划。 */
  stepPlan: BrowserRecipeStepPlan[]
  /** target 未命中时是否立即抛错停止。 */
  stopOnMiss?: boolean
}

function previewActionForOperation(
  operation: Nullable<BrowserRecipeStepOperation>
): Nullable<'click' | 'fill'> {
  if (!operation || operation.kind !== 'target_action') return null

  return operation.action.action
}

function readTargetHints(operation: BrowserRecipeStepOperation, stepId: string) {
  if (operation.kind !== 'target_action') return {
      targetCss: null,
      targetRole: null,
      targetText: null,
      selectorDesc: stepId,
    }

  const target = operation.action.target
  const targetCss = target?.css ?? null
  const targetRole = target?.role ?? null
  const targetText = target?.text ?? null

  return {
    targetCss,
    targetRole,
    targetText,
    selectorDesc: targetCss ?? targetText ?? targetRole ?? stepId,
  }
}

function isOperationMiss(operation: BrowserRecipeStepOperation, result: unknown): boolean {
  if (!result || typeof result !== 'object') return false

  const record = result as Record<string, unknown>
  if (operation.kind === 'target_action' || operation.kind === 'wait_for_selector') return record.matched === false

  return false
}

async function executeRecipeStepOperation(
  operation: BrowserRecipeStepOperation,
  stepKind: BrowserRecipeStepPlan['step']['kind'],
  ctx: ToolContext
): Promise<unknown> {
  switch (operation.kind) {
    case 'target_action':
      return performTargetActionWithRecovery(operation.action, ctx)
    case 'inspect_page': {
      const inspection = await ctx.browser.inspectPage({ maxTextChars: 20_000 })
      if (stepKind === 'extract_links') return {
          url: inspection.url,
          title: inspection.title,
          links: inspection.links,
          capturedAt: inspection.capturedAt,
        }

      return inspection
    }
    case 'navigate':
      return ctx.browser.navigatePage(operation.options)
    case 'scroll':
      return ctx.browser.scrollPage(operation.options)
    case 'wait_for_selector':
      return ctx.browser.waitForSelector(operation.options)
    case 'extract_table': {
      const scripts = new BrowserPageScriptBuilder()
      return ctx.browser.evaluateScript({
        script: scripts.buildTableExtractionScript({
          selector: operation.selector,
          tableIndex: operation.tableIndex ?? 0,
          maxRows: operation.maxRows ?? 200,
        }),
        mode: 'expression',
        timeoutMs: 10_000,
      })
    }
    case 'extract_list': {
      const scripts = new BrowserPageScriptBuilder()
      return ctx.browser.evaluateScript({
        script: scripts.buildListExtractionScript({
          selector: operation.selector,
          maxItems: operation.maxItems ?? 50,
        }),
        mode: 'expression',
        timeoutMs: 10_000,
      })
    }
  }
}

/** 顺序执行 recipe stepPlan 中的浏览器动作。 */
export async function executeBrowserRecipeSteps(
  input: ExecuteBrowserRecipeStepsInput,
  ctx: ToolContext
): Promise<BrowserRecipeRunStepResult[]> {
  const stepResults: BrowserRecipeRunStepResult[] = []

  for (const entry of input.stepPlan) {
    ctx.abortSignal.throwIfAborted()
    const { operation, step } = entry

    if (!operation) {
      stepResults.push({
        id: step.id,
        kind: step.kind,
        status: entry.status,
        action: null,
        message: entry.message,
        inputName: entry.inputName,
      })
      continue
    }

    const { targetCss, targetRole, targetText, selectorDesc } = readTargetHints(operation, step.id)
    const maxAttempts = Math.max(1, (step.retryCount ?? 0) + 1)
    let result = await executeRecipeStepOperation(operation, step.kind, ctx)

    for (let attempt = 1; isOperationMiss(operation, result) && attempt < maxAttempts; attempt++) {
      await TimerScope.sleep(300, { signal: ctx.abortSignal })
      ctx.abortSignal.throwIfAborted()
      result = await executeRecipeStepOperation(operation, step.kind, ctx)
    }

    if (isOperationMiss(operation, result)) {
      const retryNote = maxAttempts > 1 ? `（重试 ${maxAttempts - 1} 次后仍失败）` : ''
      const message = `步骤未命中：${step.id}（尝试的 selector: ${selectorDesc}）${retryNote}`
      if (input.stopOnMiss ?? true) {
        throw new AppError('VALIDATION', message)
      }

      stepResults.push({
        id: step.id,
        kind: step.kind,
        status: 'not_found',
        action: previewActionForOperation(operation),
        message,
        targetCss,
        targetRole,
        targetText,
        result,
      })
      continue
    }

    stepResults.push({
      id: step.id,
      kind: step.kind,
      status: 'executed',
      action: previewActionForOperation(operation),
      message: '已执行。',
      targetCss,
      targetRole,
      targetText,
      result,
    })
  }

  return stepResults
}
