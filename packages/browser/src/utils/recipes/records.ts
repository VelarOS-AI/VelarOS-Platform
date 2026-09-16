
import type { BrowserRecipeSkeleton, BrowserSiteContext } from '../../types/browser'
import type { BrowserRecipeExecutionPlan, BrowserRecipeRunArtifactFields, BrowserRecipeRunInputFields, BrowserRecipeRunRecipeFields, BrowserRecipeRunRecordArtifact, BrowserRecipeRunSnapshotArtifacts, BrowserRecipeRunStepResult, BrowserRecipeRunStepSummaryFields, BrowserRecipeRunWindowFields, BrowserRecipeVariableResolution } from '../../types/recipes.js'


/** 根据执行计划和步骤结果生成可持久化 run record。 */
export function buildBrowserRecipeRunRecord(input: {
  recipePath: string
  recipe: BrowserRecipeSkeleton
  dryRun: boolean
  startedAt: number
  finishedAt: number
  activeBrowserContext: LooseOptional<BrowserSiteContext>
  executionPlan: BrowserRecipeExecutionPlan
  variableResolution: BrowserRecipeVariableResolution
  stepResults: BrowserRecipeRunStepResult[]
  snapshotArtifacts: BrowserRecipeRunSnapshotArtifacts
  snapshotSaveSkippedReason: LooseOptional<string>
}): BrowserRecipeRunRecordArtifact {
  const recipeFields = {
    recipePath: input.recipePath,
    recipeUrl: input.recipe.url,
    recipeTitle: input.recipe.title,
    dryRun: input.dryRun,
  } satisfies BrowserRecipeRunRecipeFields
  const windowFields = {
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    activeBrowserContext: input.activeBrowserContext,
  } satisfies BrowserRecipeRunWindowFields
  const stepSummaryFields = {
    executableStepCount: input.executionPlan.executableSteps.length,
    // 统计 executed/ready/skipped，供 UI 和模型快速判断执行质量。
    executedStepCount: input.stepResults.filter((step) => step.status === 'executed').length,
    readyStepCount: input.stepResults.filter((step) => step.status === 'ready').length,
    missingInputCount: input.executionPlan.missingInputs.length,
    skippedStepCount: input.stepResults.filter(
      (step) => step.status !== 'executed' && step.status !== 'ready'
    ).length,
  } satisfies BrowserRecipeRunStepSummaryFields
  const inputFields = {
    requiredInputNames: input.executionPlan.inputNames.requiredInputNames,
    optionalInputNames: input.executionPlan.inputNames.optionalInputNames,
    unusedInputNames: input.executionPlan.unusedInputNames,
    missingInputs: input.executionPlan.missingInputs,
    usedVariableNames: input.variableResolution.usedVariableNames,
    unusedVariableNames: input.variableResolution.unusedVariableNames,
    missingVariableNames: input.variableResolution.missingVariableNames,
  } satisfies BrowserRecipeRunInputFields
  const artifactFields = {
    snapshotArtifacts: input.snapshotArtifacts,
    snapshotSaveSkippedReason: input.snapshotSaveSkippedReason,
    stepResults: input.stepResults,
  } satisfies BrowserRecipeRunArtifactFields

  return {
    ...recipeFields,
    ...windowFields,
    ...stepSummaryFields,
    ...inputFields,
    ...artifactFields,
  }
}

export type { BrowserRecipeRunSnapshotArtifacts } from '../../types/recipes.js'
export type { BrowserRecipeRunRecordArtifact } from '../../types/recipes.js'
