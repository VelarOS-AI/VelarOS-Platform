import { isEmpty, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { ToolContext } from '../../contract/requires'
import type { BrowserRecipeDryRunSummary, BrowserRecipeSkeleton } from '../../types/browser'
import type { BrowserRecipeRunOutcome } from '../../types/recipes'
import type { BrowserRecipeRunSnapshot, BrowserRecipeRunStepResult,RunBrowserRecipeSkeletonInput } from '../../types/recipes.js'
import { isSameBrowserOrigin } from '../../utils/recipes/paths'
import { buildRecipeExecutionPlan } from '../../utils/recipes/plan'
import {
  buildBrowserRecipeRunRecord,
  writeBrowserRecipeRunRecord,
} from '../../utils/recipes/records'
import { executeBrowserRecipeSteps } from '../../utils/recipes/steps'
import { resolveBrowserRecipeInputVariables } from '../../utils/recipes/variables'
import { getActiveBrowserContext } from '../../utils/tool.js'

import { createArtifactManager } from './Artifacts.js'
import { browserRecipeReader } from './RecipeReader'

/** 读取、预检并执行 browser recipe skeleton。 */
export interface BrowserRecipeRunnerApi {
  /** 按 recipe 骨架逐步执行，落盘运行记录与页面快照。 */
  runSkeleton(input: RunBrowserRecipeSkeletonInput, ctx: ToolContext): Promise<BrowserRecipeRunOutcome>
}

class BrowserRecipeRunner implements BrowserRecipeRunnerApi {
  private readonly inspectMaxTextChars = 20_000

  public async runSkeleton(
    input: RunBrowserRecipeSkeletonInput,
    ctx: ToolContext
  ): Promise<BrowserRecipeRunOutcome> {
    ctx.abortSignal.throwIfAborted()

    const {
      path,
      inputs,
      variables,
      maxSteps,
      dryRun,
      stopOnMiss,
      saveRun,
      saveSnapshots,
      runName,
    } = input
    const startedAt = Date.now()
    const { path: recipePath, recipe } = await browserRecipeReader.readRecipeSkeleton(path, ctx)
    const providedInputs = inputs ?? {}
    const variableResolution = resolveBrowserRecipeInputVariables(providedInputs, variables)
    const executionPlan = buildRecipeExecutionPlan(recipe, providedInputs, maxSteps)
    if (!isEmpty(executionPlan.missingInputs) && !dryRun) {
      throw new AppError(
        'VALIDATION',
        `recipe 输入缺失：${executionPlan.missingInputs.map((missingInput) => missingInput.name).join(', ')}`
      )
    }
    if (!isEmpty(variableResolution.missingVariableNames) && !dryRun) {
      throw new AppError(
        'VALIDATION',
        `recipe 变量缺失：${variableResolution.missingVariableNames.join(', ')}`
      )
    }
    let beforeSnapshot = null
    let afterSnapshot = null
    let snapshotSaveSkippedReason: Nullable<string> = null
    const shouldSaveSnapshots = !dryRun && (saveSnapshots ?? true)

    if (shouldSaveSnapshots) {
      const result = await this.saveRunSnapshot({
        ctx,
        recipe,
        runName,
        startedAt,
        suffix: 'before',
        originMismatchMessage: '执行前页面已不在 recipe 同源网站，未保存 before snapshot。',
      })
      beforeSnapshot = result.snapshot
      snapshotSaveSkippedReason = result.skippedReason
    }

    const runExecutionPlan = dryRun
      ? executionPlan
      : buildRecipeExecutionPlan(recipe, variableResolution.resolvedInputs, maxSteps)
    const stepResults: BrowserRecipeRunStepResult[] = dryRun
      ? [...executionPlan.previewStepResults]
      : await executeBrowserRecipeSteps(
          {
            stepPlan: runExecutionPlan.stepPlan,
            stopOnMiss,
          },
          ctx
        )

    const finishedAt = Date.now()
    const currentContext = ctx.browser.getContext()

    if (
      shouldSaveSnapshots &&
      currentContext &&
      isSameBrowserOrigin(currentContext.url, recipe.url)
    ) {
      const result = await this.saveRunSnapshot({
        ctx,
        recipe,
        runName,
        startedAt,
        suffix: 'after',
        originMismatchMessage: '执行后页面已切换到不同网站，未保存 after snapshot。',
      })
      afterSnapshot = result.snapshot
      snapshotSaveSkippedReason = snapshotSaveSkippedReason || result.skippedReason
    } else if (shouldSaveSnapshots && currentContext) {
      snapshotSaveSkippedReason =
        snapshotSaveSkippedReason || '执行后页面已切换到不同网站，未保存 after snapshot。'
    }

    const snapshotArtifacts = {
      before: toNullable(beforeSnapshot?.artifact),
      after: toNullable(afterSnapshot?.artifact),
    }
    const runRecord = buildBrowserRecipeRunRecord({
      recipePath,
      recipe,
      dryRun: !!dryRun,
      startedAt,
      finishedAt,
      activeBrowserContext: currentContext,
      executionPlan,
      variableResolution,
      stepResults,
      snapshotArtifacts,
      snapshotSaveSkippedReason,
    })
    const { runArtifact, runSaveSkippedReason } = await writeBrowserRecipeRunRecord({
      ctx,
      recipe,
      runRecord,
      currentContext,
      dryRun: !!dryRun,
      saveRun,
      runName,
    })

    const recipeFields = {
      path: recipePath,
      url: recipe.url,
      title: recipe.title,
      dryRun: !!dryRun,
    }
    const stepSummaryFields = {
      executableStepCount: runRecord.executableStepCount,
      executedStepCount: runRecord.executedStepCount,
      readyStepCount: runRecord.readyStepCount,
      missingInputCount: runRecord.missingInputCount,
      skippedStepCount: runRecord.skippedStepCount,
    }
    const inputFields = {
      requiredInputNames: runRecord.requiredInputNames,
      optionalInputNames: runRecord.optionalInputNames,
      unusedInputNames: runRecord.unusedInputNames,
      missingInputs: runRecord.missingInputs,
    }
    const variableFields = {
      usedVariableNames: runRecord.usedVariableNames,
      unusedVariableNames: runRecord.unusedVariableNames,
      missingVariableNames: runRecord.missingVariableNames,
    }
    const artifactFields = {
      snapshotArtifacts: runRecord.snapshotArtifacts,
      snapshotSaveSkippedReason,
      runArtifact,
      runSaveSkippedReason,
    }

    return {
      ...recipeFields,
      ...stepSummaryFields,
      ...inputFields,
      ...variableFields,
      ...artifactFields,
      stepResults,
    }
  }

  private buildRunArtifactName(
    recipe: BrowserRecipeSkeleton,
    runName: Optional<string>,
    startedAt: number,
    suffix: string
  ): string {
    const baseName = runName || `${recipe.title || 'recipe'}-${new Date(startedAt).toISOString()}`
    return `${baseName}-${suffix}`
  }

  private async saveRunSnapshot(input: {
    ctx: ToolContext
    recipe: BrowserRecipeSkeleton
    runName?: string
    startedAt: number
    suffix: 'before' | 'after'
    originMismatchMessage: string
  }): Promise<{
    snapshot: Nullable<BrowserRecipeRunSnapshot>
    skippedReason: Nullable<string>
  }> {
    try {
      const inspection = await input.ctx.browser.inspectPage({
        maxTextChars: this.inspectMaxTextChars,
      })
      const context = getActiveBrowserContext(input.ctx)
      if (!isSameBrowserOrigin(context.url, input.recipe.url)) return {
          snapshot: null,
          skippedReason: input.originMismatchMessage,
        }

      const snapshot = await createArtifactManager(input.ctx).savePageSnapshot({
        context,
        inspection,
        name: this.buildRunArtifactName(input.recipe, input.runName, input.startedAt, input.suffix),
        overwrite: true,
      })

      return {
        snapshot,
        skippedReason: null,
      }
    } catch (error) {
      return {
        snapshot: null,
        skippedReason: `保存 ${input.suffix} snapshot 失败：${AppError.getMessage(error)}`,
      }
    }
  }
}

export const browserRecipeRunner: BrowserRecipeRunnerApi = new BrowserRecipeRunner()

/**
 * 干跑一份 recipe skeleton 并返回结构化结论。
 *
 * 供**宿主 UI 直调**（制品面板的「干跑」按钮走 IPC 落到这里），与模型走的
 * `browser:recipe action=run_skeleton dryRun=true` 共用同一个执行器：干跑的语义只有一处实现，
 * 按钮与工具不会各自漂移。刻意不写 run record、不存快照——预检就该零副作用。
 */
export async function runBrowserRecipeDryRun(
  input: { path: string },
  ctx: ToolContext
): Promise<BrowserRecipeDryRunSummary> {
  const result = await browserRecipeRunner.runSkeleton(
    { path: input.path, dryRun: true, saveRun: false, saveSnapshots: false },
    ctx
  )

  return {
    path: result.path,
    url: result.url,
    title: toNullable(result.title),
    executableStepCount: result.executableStepCount,
    readyStepCount: result.readyStepCount,
    missingInputCount: result.missingInputCount,
    skippedStepCount: result.skippedStepCount,
    requiredInputNames: [...result.requiredInputNames],
    missingInputs: result.missingInputs.map((missing) => ({
      stepId: missing.stepId,
      name: missing.name,
      label: missing.label,
      required: missing.required,
    })),
    steps: result.stepResults.map((step) => ({
      id: step.id,
      kind: step.kind,
      status: step.status,
      message: step.message,
      inputName: toNullable(step.inputName),
      targetCss: toNullable(step.targetCss),
    })),
  }
}

