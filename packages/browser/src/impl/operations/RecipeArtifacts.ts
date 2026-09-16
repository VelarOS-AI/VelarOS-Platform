import { isFalse, toNullable } from '@velaros-ai/core'

import type { ToolContext } from '../../contract/requires'
import type {
  BrowserRecipeRunOutcome,
  BrowserRecipeRunReview,
  BrowserRecipeSkeletonGenerate,
  BrowserRecipeSkeletonSave,
} from '../../types/recipes'
import type {GenerateBrowserRecipeSkeletonFromSnapshotInput, GenerateBrowserRecipeSkeletonInput, ReadBrowserRecipeRunInput, ReadBrowserRecipeSkeletonInput, ReadBrowserRecipeSkeletonResult, RerunBrowserRecipeFromRunInput } from '../../types/recipes.js'
import { buildRecipeExecutionPlan } from '../../utils/recipes/plan'

import { createArtifactManager } from './Artifacts.js'
import { browserRecipeReader } from './RecipeReader'
import { browserRecipeRunner } from './RecipeRun'

/**
 * recipe 产物操作：生成骨架、读骨架与运行记录、照记录重跑。
 *
 * 无实例状态，文件末尾给出进程唯一的一份；每次调用要的东西都从工具上下文取。
 */
export interface BrowserRecipeArtifactsApi {
  /** 按当前页面生成一份 recipe 骨架并落盘，顺手存一张页面快照。 */
  generateSkeleton(input: GenerateBrowserRecipeSkeletonInput, ctx: ToolContext): Promise<BrowserRecipeSkeletonGenerate>
  /** 按一张已有的页面快照生成 recipe 骨架。 */
  generateSkeletonFromSnapshot(
    input: GenerateBrowserRecipeSkeletonFromSnapshotInput,
    ctx: ToolContext
  ): Promise<BrowserRecipeSkeletonSave>
  /** 读一份 recipe 骨架，并核对它与当前站点同源。 */
  readSkeleton(input: ReadBrowserRecipeSkeletonInput, ctx: ToolContext): Promise<ReadBrowserRecipeSkeletonResult>
  /** 读一份运行记录，并算出输入与变量的对账概要。 */
  readRun(input: ReadBrowserRecipeRunInput, ctx: ToolContext): Promise<BrowserRecipeRunReview>
  /** 照一份运行记录再跑一次同一个 recipe。 */
  rerunFromRun(input: RerunBrowserRecipeFromRunInput, ctx: ToolContext): Promise<BrowserRecipeRunOutcome>
}

class BrowserRecipeArtifacts implements BrowserRecipeArtifactsApi {
  public async generateSkeleton(
    input: GenerateBrowserRecipeSkeletonInput,
    ctx: ToolContext
  ): Promise<BrowserRecipeSkeletonGenerate> {
    ctx.abortSignal.throwIfAborted()

    const inspection = await ctx.browser.inspectPage({
      maxTextChars: input.maxTextChars,
    })
    const artifactManager = createArtifactManager(ctx)
    const context = ctx.browser.getContext()!
    const sourceSnapshot = isFalse(input.saveSnapshot)
      ? null
      : await artifactManager.savePageSnapshot({
          context,
          inspection,
          name: input.snapshotName,
          overwrite: input.overwriteSnapshot ?? true,
        })
    const recipeSkeleton = await artifactManager.saveRecipeSkeleton({
      context,
      inspection,
      sourceSnapshotPath: toNullable(sourceSnapshot?.artifact.relativePath),
      name: input.name,
      overwrite: input.overwrite,
      template: input.template,
    })

    return {
      ...recipeSkeleton,
      sourceSnapshot,
    }
  }

  public async generateSkeletonFromSnapshot(
    input: GenerateBrowserRecipeSkeletonFromSnapshotInput,
    ctx: ToolContext
  ): Promise<BrowserRecipeSkeletonSave> {
    ctx.abortSignal.throwIfAborted()

    const {
      path: snapshotPath,
      inspection,
      context,
    } = await browserRecipeReader.readPageSnapshot(input.path, ctx)
    return createArtifactManager(ctx).saveRecipeSkeleton({
      context,
      inspection,
      sourceSnapshotPath: snapshotPath,
      name: input.name,
      overwrite: input.overwrite,
      template: input.template,
    })
  }

  public async readSkeleton(
    input: ReadBrowserRecipeSkeletonInput,
    ctx: ToolContext
  ): Promise<ReadBrowserRecipeSkeletonResult> {
    ctx.abortSignal.throwIfAborted()

    const { path: recipePath, recipe } = await browserRecipeReader.readRecipeSkeleton(
      input.path,
      ctx
    )
    const executionPlan = buildRecipeExecutionPlan(recipe, input.inputs ?? {}, input.maxSteps)

    return {
      path: recipePath,
      recipe,
      summary: {
        url: recipe.url,
        title: recipe.title,
        sourceSnapshotPath: recipe.sourceSnapshotPath,
        inputCount: recipe.inputs?.length ?? 0,
        requiredInputNames: executionPlan.inputNames.requiredInputNames,
        optionalInputNames: executionPlan.inputNames.optionalInputNames,
        executableStepCount: executionPlan.executableSteps.length,
        previewStepCount: executionPlan.previewStepResults.length,
        readyStepCount: executionPlan.readyStepCount,
        missingInputCount: executionPlan.missingInputCount,
        skippedStepCount: executionPlan.skippedStepCount,
        unusedInputNames: executionPlan.unusedInputNames,
        missingInputs: executionPlan.missingInputs,
      },
      stepResults: executionPlan.previewStepResults,
    }
  }

  public async readRun(
    input: ReadBrowserRecipeRunInput,
    ctx: ToolContext
  ): Promise<BrowserRecipeRunReview> {
    ctx.abortSignal.throwIfAborted()

    const { path: runPath, run } = await browserRecipeReader.readRecipeRunRecord(input.path, ctx)
    const variableFields = {
      usedVariableNames: run.usedVariableNames ?? [],
      unusedVariableNames: run.unusedVariableNames ?? [],
      missingVariableNames: run.missingVariableNames ?? [],
    }

    return {
      path: runPath,
      run,
      summary: {
        recipePath: run.recipePath,
        recipeUrl: run.recipeUrl,
        recipeTitle: run.recipeTitle,
        dryRun: run.dryRun,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        executableStepCount: run.executableStepCount,
        executedStepCount: run.executedStepCount,
        skippedStepCount: run.skippedStepCount,
        requiredInputNames: run.requiredInputNames,
        optionalInputNames: run.optionalInputNames,
        missingInputs: run.missingInputs,
        ...variableFields,
      },
    }
  }

  public async rerunFromRun(
    input: RerunBrowserRecipeFromRunInput,
    ctx: ToolContext
  ): Promise<BrowserRecipeRunOutcome> {
    ctx.abortSignal.throwIfAborted()

    const { run } = await browserRecipeReader.readRecipeRunRecord(input.path, ctx)

    return browserRecipeRunner.runSkeleton(
      {
        path: run.recipePath,
        inputs: input.inputs,
        variables: input.variables,
        maxSteps: input.maxSteps,
        dryRun: input.dryRun,
        stopOnMiss: input.stopOnMiss,
        saveRun: input.saveRun,
        saveSnapshots: input.saveSnapshots,
        runName: input.runName ?? `${run.recipeTitle || 'recipe'}-rerun`,
      },
      ctx
    )
  }
}

export const browserRecipeArtifacts: BrowserRecipeArtifactsApi = new BrowserRecipeArtifacts()

