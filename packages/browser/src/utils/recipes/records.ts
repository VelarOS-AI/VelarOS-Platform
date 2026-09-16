import { isFalse, stringifyPretty } from '@velaros-ai/core'

import type { ToolContext } from '../../contract/requires'
import { createArtifactManager } from '../../impl/operations/Artifacts.js'
import type {
  BrowserRecipeSkeleton,
  BrowserSiteContext,
  BrowserWorkspaceArtifactRecord,
} from '../../types/browser'
import type { BrowserRecipeExecutionPlan, BrowserRecipeRunArtifactFields, BrowserRecipeRunInputFields, BrowserRecipeRunRecipeFields, BrowserRecipeRunRecordArtifact, BrowserRecipeRunSnapshotArtifacts, BrowserRecipeRunStepResult, BrowserRecipeRunStepSummaryFields, BrowserRecipeRunWindowFields, BrowserRecipeVariableResolution } from '../../types/recipes.js'

import { isSameBrowserOrigin } from './paths'

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

/** 按策略写入 runs/ run record；可能因 dryRun、显式关闭或跨源而跳过。 */
export async function writeBrowserRecipeRunRecord(input: {
  ctx: ToolContext
  recipe: BrowserRecipeSkeleton
  runRecord: BrowserRecipeRunRecordArtifact
  currentContext: LooseOptional<BrowserSiteContext>
  dryRun: boolean
  saveRun?: boolean
  runName?: string
}): Promise<{
  runArtifact: LooseOptional<BrowserWorkspaceArtifactRecord>
  runSaveSkippedReason: LooseOptional<string>
}> {
  // dryRun 只预检，不持久化运行记录。
  if (input.dryRun) return {
      runArtifact: null,
      runSaveSkippedReason: 'dryRun=true，仅预检，不写入运行记录。',
    }

  // 调用方可显式关闭 run 保存。
  if (isFalse(input.saveRun)) return {
      runArtifact: null,
      runSaveSkippedReason: null,
    }

  // 没有当前 browser context 时无法确定写入哪个站点工区。
  if (!input.currentContext) return {
      runArtifact: null,
      runSaveSkippedReason: '当前没有激活的浏览器网站工区。',
    }

  // 如果执行导致跨站跳转，不把原站点 recipe 的 run record 写到新站点目录。
  if (!isSameBrowserOrigin(input.currentContext.url, input.recipe.url)) return {
      runArtifact: null,
      runSaveSkippedReason: 'recipe 执行后已切换到不同网站，未把运行记录写入新的站点工区。',
    }

  // run record 作为 json artifact 写入当前站点 runs/。
  const runArtifact = await createArtifactManager(input.ctx).writeArtifact({
    context: input.currentContext,
    kind: 'run',
    format: 'json',
    content: `${stringifyPretty(input.runRecord)}\n`,
    name:
      input.runName ||
      `${input.recipe.title || 'recipe'}-${new Date(input.runRecord.finishedAt).toISOString()}-run`,
  })

  return {
    runArtifact,
    runSaveSkippedReason: null,
  }
}

export type { BrowserRecipeRunSnapshotArtifacts } from '../../types/recipes.js'
export type { BrowserRecipeRunRecordArtifact } from '../../types/recipes.js'
