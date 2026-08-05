import { isEmpty, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { BrowserWorkspaceArtifactManager } from '../core'
import type { BrowserRecipeDryRunSummary, BrowserRecipeSkeleton } from '../core'

import { createArtifactManager, getActiveBrowserContext } from './Context'
import { isSameBrowserOrigin } from './RecipePaths'
import {
  type BrowserRecipeRunStepResult,
  buildRecipeExecutionPlan,
} from './RecipePlan'
import { browserRecipeReader } from './RecipeReader'
import {
  buildBrowserRecipeRunRecord,
  writeBrowserRecipeRunRecord,
} from './RecipeRecords'
import { executeBrowserRecipeSteps } from './RecipeSteps'
import {
  type BrowserRecipeRunVariables,
  resolveBrowserRecipeInputVariables,
} from './RecipeVariables'
import type { ToolContext } from './Types'

/** 执行 recipe skeleton 的入参。 */
export interface RunBrowserRecipeSkeletonInput {
  /** recipes/xxx.json 路径。 */
  path: string
  /** recipe input.name -> 输入值。 */
  inputs?: Record<string, string>
  /** %variableName% -> 真实执行值；不会写入 run record。 */
  variables?: BrowserRecipeRunVariables
  /** 最多执行多少个可执行步骤。 */
  maxSteps?: number
  /** 只预检，不执行页面动作、不写 run record。 */
  dryRun?: boolean
  /** target 未命中时是否立即停止。 */
  stopOnMiss?: boolean
  /** 是否保存 runs/ 运行记录。 */
  saveRun?: boolean
  /** 是否保存 before/after 页面快照。 */
  saveSnapshots?: boolean
  /** run/snapshot artifact 名称前缀。 */
  runName?: string
}

type BrowserRecipeRunSnapshot = Awaited<
  ReturnType<BrowserWorkspaceArtifactManager['savePageSnapshot']>
>

/** 读取、预检并执行 browser recipe skeleton。 */
class BrowserRecipeRunner {
  private readonly inspectMaxTextChars = 20_000

  public async runSkeleton(input: RunBrowserRecipeSkeletonInput, ctx: ToolContext) {
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
    runName: string | undefined,
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

const browserRecipeRunner = new BrowserRecipeRunner()

/**
 * 干跑一份 recipe skeleton 并返回结构化结论。
 *
 * 供**宿主 UI 直调**（制品面板的「干跑」按钮走 IPC 落到这里），与模型走的
 * `browser:recipe action=run_skeleton dryRun=true` 共用同一个执行器：干跑的语义只有一处实现，
 * 按钮与工具不会各自漂移。刻意不写 run record、不存快照——预检就该零副作用。
 */
async function runBrowserRecipeDryRun(
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

export { BrowserRecipeRunner, browserRecipeRunner, runBrowserRecipeDryRun }
