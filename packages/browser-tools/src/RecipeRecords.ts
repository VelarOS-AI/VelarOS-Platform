import type { BrowserRecipeSkeleton, BrowserSiteContext, BrowserWorkspaceArtifactRecord } from '@velaros-ai/browser-core'
import { isFalse, stringifyPretty } from '@velaros-ai/core'

import { createArtifactManager } from './Context'
import { isSameBrowserOrigin } from './RecipePaths'
import type { BrowserRecipeExecutionPlan, BrowserRecipeRunStepResult } from './RecipePlan'
import type { BrowserRecipeVariableResolution } from './RecipeVariables'
import type { ToolContext } from './Types'

/** run record 中记录的 before/after snapshot artifact。 */
interface BrowserRecipeRunSnapshotArtifacts {
  before: LooseOptional<BrowserWorkspaceArtifactRecord>
  after: LooseOptional<BrowserWorkspaceArtifactRecord>
}

/** 写入 runs/ 的 recipe 执行记录。 */
interface BrowserRecipeRunRecordArtifact {
  /** recipe artifact 路径。 */
  recipePath: string
  /** recipe 关联页面 URL。 */
  recipeUrl: string
  /** recipe 标题。 */
  recipeTitle: string
  /** 是否只是 dryRun。 */
  dryRun: boolean
  /** 执行开始时间。 */
  startedAt: number
  /** 执行结束时间。 */
  finishedAt: number
  /** 执行结束时的 browser context。 */
  activeBrowserContext: LooseOptional<BrowserSiteContext>
  /** 可执行步骤总数。 */
  executableStepCount: number
  /** 已执行步骤数。 */
  executedStepCount: number
  /** ready 但未执行的步骤数，通常来自 dryRun。 */
  readyStepCount: number
  /** 缺失输入数。 */
  missingInputCount: number
  /** 跳过/未命中步骤数。 */
  skippedStepCount: number
  /** 必填输入名。 */
  requiredInputNames: string[]
  /** 可选输入名。 */
  optionalInputNames: string[]
  /** 未被 recipe 使用的输入名。 */
  unusedInputNames: string[]
  /** 缺失输入详情。 */
  missingInputs: BrowserRecipeExecutionPlan['missingInputs']
  /** 本次输入中实际引用的变量占位符名，不包含变量值。 */
  usedVariableNames: string[]
  /** 调用方传入但未被输入占位符使用的变量名。 */
  unusedVariableNames: string[]
  /** dryRun 中发现、真实执行前会要求补齐的变量名。 */
  missingVariableNames: string[]
  /** before/after 快照 artifact。 */
  snapshotArtifacts: BrowserRecipeRunSnapshotArtifacts
  /** 快照未保存的原因。 */
  snapshotSaveSkippedReason: LooseOptional<string>
  /** 每一步结果。 */
  stepResults: BrowserRecipeRunStepResult[]
}

type BrowserRecipeRunRecipeFields = Pick<
  BrowserRecipeRunRecordArtifact,
  'recipePath' | 'recipeUrl' | 'recipeTitle' | 'dryRun'
>

type BrowserRecipeRunWindowFields = Pick<
  BrowserRecipeRunRecordArtifact,
  'startedAt' | 'finishedAt' | 'activeBrowserContext'
>

type BrowserRecipeRunStepSummaryFields = Pick<
  BrowserRecipeRunRecordArtifact,
  | 'executableStepCount'
  | 'executedStepCount'
  | 'readyStepCount'
  | 'missingInputCount'
  | 'skippedStepCount'
>

type BrowserRecipeRunInputFields = Pick<
  BrowserRecipeRunRecordArtifact,
  | 'requiredInputNames'
  | 'optionalInputNames'
  | 'unusedInputNames'
  | 'missingInputs'
  | 'usedVariableNames'
  | 'unusedVariableNames'
  | 'missingVariableNames'
>

type BrowserRecipeRunArtifactFields = Pick<
  BrowserRecipeRunRecordArtifact,
  'snapshotArtifacts' | 'snapshotSaveSkippedReason' | 'stepResults'
>

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

export type { BrowserRecipeRunRecordArtifact, BrowserRecipeRunSnapshotArtifacts }
