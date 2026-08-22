import { isFalse, toNullable } from '@velaros-ai/core'

import type { BrowserRecipeSkeleton } from '../core'

import { createArtifactManager } from './Context'
import { type BrowserRecipeRunStepResult, buildRecipeExecutionPlan } from './RecipePlan'
import { browserRecipeReader } from './RecipeReader'
import { browserRecipeRunner } from './RecipeRun'
import type { BrowserRecipeRunVariables } from './RecipeVariables'
import type { ToolContext } from './Types'

/** recipe skeleton 可选预设模板。 */
type BrowserRecipeTemplate = 'login' | 'search' | 'pagination' | 'form_submit'

/** 从当前页面生成 recipe skeleton 的入参。 */
export interface GenerateBrowserRecipeSkeletonInput {
  name?: string
  saveSnapshot?: boolean
  snapshotName?: string
  overwriteSnapshot?: boolean
  maxTextChars?: number
  overwrite?: boolean
  template?: BrowserRecipeTemplate
}

/** 从已保存 snapshot 生成 recipe skeleton 的入参。 */
export interface GenerateBrowserRecipeSkeletonFromSnapshotInput {
  path: string
  name?: string
  overwrite?: boolean
  template?: BrowserRecipeTemplate
}

/** 读取并预览 recipe skeleton 的入参。 */
export interface ReadBrowserRecipeSkeletonInput {
  path: string
  inputs?: Record<string, string>
  maxSteps?: number
}

/** recipe skeleton 的读取结果及可执行性摘要。 */
export interface ReadBrowserRecipeSkeletonResult {
  path: string
  recipe: BrowserRecipeSkeleton
  summary: {
    url: string
    title: string
    sourceSnapshotPath: Nullable<string>
    inputCount: number
    requiredInputNames: string[]
    optionalInputNames: string[]
    executableStepCount: number
    previewStepCount: number
    readyStepCount: number
    missingInputCount: number
    skippedStepCount: number
    unusedInputNames: string[]
    missingInputs: Array<{
      stepId: string
      name: string
      label: string
      type: string
      required: boolean
    }>
  }
  stepResults: BrowserRecipeRunStepResult[]
}

/** 读取 run record 的入参。 */
export interface ReadBrowserRecipeRunInput {
  path: string
}

/** 基于历史 run record 重跑 recipe 的入参。 */
export interface RerunBrowserRecipeFromRunInput {
  path: string
  inputs?: Record<string, string>
  variables?: BrowserRecipeRunVariables
  maxSteps?: number
  dryRun?: boolean
  stopOnMiss?: boolean
  saveRun?: boolean
  saveSnapshots?: boolean
  runName?: string
}

class BrowserRecipeArtifacts {
  public async generateSkeleton(input: GenerateBrowserRecipeSkeletonInput, ctx: ToolContext) {
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
  ) {
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

  public async readRun(input: ReadBrowserRecipeRunInput, ctx: ToolContext) {
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

  public async rerunFromRun(input: RerunBrowserRecipeFromRunInput, ctx: ToolContext) {
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

const browserRecipeArtifacts = new BrowserRecipeArtifacts()

export { BrowserRecipeArtifacts, browserRecipeArtifacts }
