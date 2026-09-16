import type { z } from 'zod'

import { isEmpty, isFalse, stringifyPretty, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { ToolContext } from '../../contract/requires'
import type {
  BrowserRecipeDryRunSummary,
  BrowserRecipeSkeleton,
  BrowserSiteContext,
  BrowserWorkspaceArtifactRecord,
} from '../../types/browser'
import type {
  BrowserPageSnapshotRead,
  BrowserRecipeRunOutcome,
  BrowserRecipeRunRead,
  BrowserRecipeRunRecordArtifact,
  BrowserRecipeRunReview,
  BrowserRecipeRunSnapshot,
  BrowserRecipeRunStepResult,
  BrowserRecipeSkeletonGenerate,
  BrowserRecipeSkeletonRead,
  BrowserRecipeSkeletonSave,
  GenerateBrowserRecipeSkeletonFromSnapshotInput,
  GenerateBrowserRecipeSkeletonInput,
  ReadBrowserRecipeRunInput,
  ReadBrowserRecipeSkeletonInput,
  ReadBrowserRecipeSkeletonResult,
  RerunBrowserRecipeFromRunInput,
  RunBrowserRecipeSkeletonInput,
} from '../../types/recipes.js'
import { buildBrowserArtifactAccess } from '../../utils/artifacts.js'
import {
  parseBrowserPageSnapshot,
  parseBrowserRecipeRunRecord,
  parseRecipeSkeleton,
} from '../../utils/recipes/parser'
import {
  isSameBrowserOrigin,
  requirePageSnapshotPath,
  requireRecipePath,
  requireRunPath,
  requireSameBrowserOrigin,
} from '../../utils/recipes/paths'
import { buildRecipeExecutionPlan } from '../../utils/recipes/plan'
import { buildBrowserRecipeRunRecord } from '../../utils/recipes/records'
import { executeBrowserRecipeSteps } from '../../utils/recipes/steps'
import { resolveBrowserRecipeInputVariables } from '../../utils/recipes/variables'
import type { browserRecipeExactSchema } from '../../utils/schemas/recipe'
import { getActiveBrowserContext } from '../../utils/tool.js'
import { BrowserTuning } from '../../utils/tuning'
import { BrowserWorkspaceArtifactManager } from '../workspace/BrowserWorkspaceArtifactManager.js'

import { BrowserExtractOperations } from './BrowserExtractOperations.js'

/**
 * `browser:recipe` 背后的执行类：骨架的生成与读取、运行记录的读取与重跑、逐步执行。
 *
 * 每次工具调用建一份，实例带住这一次调用的工具上下文。读三类产物（recipes/、pages/、runs/）
 * 时都先校验路径在对应目录下、内容与当前站点同源，不同源直接报错而不是读出别的站点的东西。
 * 执行会写运行记录与前后两张页面快照；`dryRun` 只预检、零副作用。
 */
export interface BrowserRecipeOperationsApi {
  /** 按收敛好的入参分派到六个 recipe 动作。 */
  run(input: z.output<typeof browserRecipeExactSchema>): Promise<unknown>
  /** 按当前页面生成一份 recipe 骨架并落盘，顺手存一张页面快照。 */
  generateSkeleton(input: GenerateBrowserRecipeSkeletonInput): Promise<BrowserRecipeSkeletonGenerate>
  /** 按一张已有的页面快照生成 recipe 骨架。 */
  generateSkeletonFromSnapshot(
    input: GenerateBrowserRecipeSkeletonFromSnapshotInput
  ): Promise<BrowserRecipeSkeletonSave>
  /** 读一份 recipe 骨架，并算出输入与步骤的预检概要。 */
  readSkeleton(input: ReadBrowserRecipeSkeletonInput): Promise<ReadBrowserRecipeSkeletonResult>
  /** 读一份运行记录，并算出输入与变量的对账概要。 */
  readRun(input: ReadBrowserRecipeRunInput): Promise<BrowserRecipeRunReview>
  /** 按 recipe 骨架逐步执行，落盘运行记录与页面快照。 */
  runSkeleton(input: RunBrowserRecipeSkeletonInput): Promise<BrowserRecipeRunOutcome>
  /** 照一份运行记录再跑一次同一个 recipe。 */
  rerunFromRun(input: RerunBrowserRecipeFromRunInput): Promise<BrowserRecipeRunOutcome>
}

export class BrowserRecipeOperations implements BrowserRecipeOperationsApi {
  constructor(private readonly ctx: ToolContext) {}

  public async run(input: z.output<typeof browserRecipeExactSchema>): Promise<unknown> {
    switch (input.action) {
      case 'generate_skeleton':
        return this.generateSkeleton(input)
      case 'generate_skeleton_from_snapshot':
        return this.generateSkeletonFromSnapshot(input)
      case 'read_skeleton':
        return this.readSkeleton(input)
      case 'run_skeleton':
        return this.runSkeleton(input)
      case 'read_run':
        return this.readRun(input)
      case 'rerun_from_run':
        return this.rerunFromRun(input)
      default:
        input satisfies never
        throw new AppError('VALIDATION', 'browser:recipe 不认识这个 action。')
    }
  }

  public async generateSkeleton(
    input: GenerateBrowserRecipeSkeletonInput
  ): Promise<BrowserRecipeSkeletonGenerate> {
    this.ctx.abortSignal.throwIfAborted()

    const inspection = await this.ctx.browser.inspectPage({ maxTextChars: input.maxTextChars })
    const artifacts = this.artifacts()
    const context = getActiveBrowserContext(this.ctx)
    const sourceSnapshot = isFalse(input.saveSnapshot)
      ? null
      : await artifacts.savePageSnapshot({
          context,
          inspection,
          name: input.snapshotName,
          overwrite: input.overwriteSnapshot ?? true,
        })
    const recipeSkeleton = await artifacts.saveRecipeSkeleton({
      context,
      inspection,
      sourceSnapshotPath: toNullable(sourceSnapshot?.artifact.relativePath),
      name: input.name,
      overwrite: input.overwrite,
      template: input.template,
    })

    return { ...recipeSkeleton, sourceSnapshot }
  }

  public async generateSkeletonFromSnapshot(
    input: GenerateBrowserRecipeSkeletonFromSnapshotInput
  ): Promise<BrowserRecipeSkeletonSave> {
    this.ctx.abortSignal.throwIfAborted()

    const { path: snapshotPath, inspection, context } = await this.readPageSnapshot(input.path)
    return this.artifacts().saveRecipeSkeleton({
      context,
      inspection,
      sourceSnapshotPath: snapshotPath,
      name: input.name,
      overwrite: input.overwrite,
      template: input.template,
    })
  }

  public async readSkeleton(
    input: ReadBrowserRecipeSkeletonInput
  ): Promise<ReadBrowserRecipeSkeletonResult> {
    this.ctx.abortSignal.throwIfAborted()

    const { path: recipePath, recipe } = await this.readRecipeSkeleton(input.path)
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

  public async readRun(input: ReadBrowserRecipeRunInput): Promise<BrowserRecipeRunReview> {
    this.ctx.abortSignal.throwIfAborted()

    const { path: runPath, run } = await this.readRecipeRunRecord(input.path)
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

  public async runSkeleton(input: RunBrowserRecipeSkeletonInput): Promise<BrowserRecipeRunOutcome> {
    this.ctx.abortSignal.throwIfAborted()

    const { path, inputs, variables, maxSteps, dryRun, stopOnMiss, saveRun, saveSnapshots, runName } =
      input
    const startedAt = Date.now()
    const { path: recipePath, recipe } = await this.readRecipeSkeleton(path)
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
        recipe,
        runName,
        startedAt,
        suffix: 'before',
        originMismatchMessage: '执行前页面已不在 recipe 同源网站，未保存执行前快照。',
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
            extraction: new BrowserExtractOperations(this.ctx),
          },
          this.ctx
        )

    const finishedAt = Date.now()
    const currentContext = this.ctx.browser.getContext()

    if (shouldSaveSnapshots && currentContext && isSameBrowserOrigin(currentContext.url, recipe.url)) {
      const result = await this.saveRunSnapshot({
        recipe,
        runName,
        startedAt,
        suffix: 'after',
        originMismatchMessage: '执行后页面已切换到不同网站，未保存执行后快照。',
      })
      afterSnapshot = result.snapshot
      snapshotSaveSkippedReason = snapshotSaveSkippedReason || result.skippedReason
    } else if (shouldSaveSnapshots && currentContext) {
      snapshotSaveSkippedReason =
        snapshotSaveSkippedReason || '执行后页面已切换到不同网站，未保存执行后快照。'
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
      snapshotArtifacts: {
        before: toNullable(beforeSnapshot?.artifact),
        after: toNullable(afterSnapshot?.artifact),
      },
      snapshotSaveSkippedReason,
    })
    const { runArtifact, runSaveSkippedReason } = await this.writeRunRecord({
      recipe,
      runRecord,
      currentContext,
      dryRun: !!dryRun,
      saveRun,
      runName,
    })

    return {
      path: recipePath,
      url: recipe.url,
      title: recipe.title,
      dryRun: !!dryRun,
      executableStepCount: runRecord.executableStepCount,
      executedStepCount: runRecord.executedStepCount,
      readyStepCount: runRecord.readyStepCount,
      missingInputCount: runRecord.missingInputCount,
      skippedStepCount: runRecord.skippedStepCount,
      requiredInputNames: runRecord.requiredInputNames,
      optionalInputNames: runRecord.optionalInputNames,
      unusedInputNames: runRecord.unusedInputNames,
      missingInputs: runRecord.missingInputs,
      usedVariableNames: runRecord.usedVariableNames,
      unusedVariableNames: runRecord.unusedVariableNames,
      missingVariableNames: runRecord.missingVariableNames,
      snapshotArtifacts: runRecord.snapshotArtifacts,
      snapshotSaveSkippedReason,
      runArtifact,
      runSaveSkippedReason,
      stepResults,
    }
  }

  public async rerunFromRun(input: RerunBrowserRecipeFromRunInput): Promise<BrowserRecipeRunOutcome> {
    this.ctx.abortSignal.throwIfAborted()

    const { run } = await this.readRecipeRunRecord(input.path)

    return this.runSkeleton({
      path: run.recipePath,
      inputs: input.inputs,
      variables: input.variables,
      maxSteps: input.maxSteps,
      dryRun: input.dryRun,
      stopOnMiss: input.stopOnMiss,
      saveRun: input.saveRun,
      saveSnapshots: input.saveSnapshots,
      runName: input.runName ?? `${run.recipeTitle || 'recipe'}-rerun`,
    })
  }

  /** 当前站点的产物管理器：只经工具上下文的文件 API 读写，出不了站点目录。 */
  private artifacts(): BrowserWorkspaceArtifactManager {
    return new BrowserWorkspaceArtifactManager(buildBrowserArtifactAccess(this.ctx))
  }

  /** 读一份 recipe 骨架；路径不在 recipes/ 下或与当前站点不同源时报错。 */
  private async readRecipeSkeleton(inputPath: string): Promise<BrowserRecipeSkeletonRead> {
    const recipePath = requireRecipePath(inputPath)
    const file = await this.ctx.browser.readFile(
      recipePath,
      1,
      undefined,
      BrowserTuning.recipes.skeletonReadChars
    )
    const recipe = parseRecipeSkeleton(recipePath, file.content)
    const context = getActiveBrowserContext(this.ctx)
    requireSameBrowserOrigin(recipe.url, context.url, 'recipe')

    return { path: recipePath, recipe, context }
  }

  /** 读一份页面快照；路径不在 pages/ 下或与当前站点不同源时报错。 */
  private async readPageSnapshot(inputPath: string): Promise<BrowserPageSnapshotRead> {
    const snapshotPath = requirePageSnapshotPath(inputPath)
    const file = await this.ctx.browser.readFile(
      snapshotPath,
      1,
      undefined,
      BrowserTuning.recipes.snapshotReadChars
    )
    const inspection = parseBrowserPageSnapshot(snapshotPath, file.content)
    const context = getActiveBrowserContext(this.ctx)
    requireSameBrowserOrigin(inspection.url, context.url, '页面快照')

    return { path: snapshotPath, inspection, context }
  }

  /** 读一份 recipe 运行记录；路径不在 runs/ 下或与当前站点不同源时报错。 */
  private async readRecipeRunRecord(inputPath: string): Promise<BrowserRecipeRunRead> {
    const runPath = requireRunPath(inputPath)
    const file = await this.ctx.browser.readFile(
      runPath,
      1,
      undefined,
      BrowserTuning.recipes.snapshotReadChars
    )
    const run = parseBrowserRecipeRunRecord(runPath, file.content)
    const context = getActiveBrowserContext(this.ctx)
    requireSameBrowserOrigin(run.recipeUrl, context.url, '运行记录')

    return { path: runPath, run, context }
  }

  /** 执行前后各存一张页面快照；跨站或存盘失败时不算执行失败，只在回执里说明跳过原因。 */
  private async saveRunSnapshot(input: {
    recipe: BrowserRecipeSkeleton
    runName?: string
    startedAt: number
    suffix: 'before' | 'after'
    originMismatchMessage: string
  }): Promise<{ snapshot: Nullable<BrowserRecipeRunSnapshot>; skippedReason: Nullable<string> }> {
    try {
      const inspection = await this.ctx.browser.inspectPage({
        maxTextChars: BrowserTuning.extraction.recipeInspectTextChars,
      })
      const context = getActiveBrowserContext(this.ctx)
      if (!isSameBrowserOrigin(context.url, input.recipe.url))
        return { snapshot: null, skippedReason: input.originMismatchMessage }

      const baseName =
        input.runName || `${input.recipe.title || 'recipe'}-${new Date(input.startedAt).toISOString()}`
      const snapshot = await this.artifacts().savePageSnapshot({
        context,
        inspection,
        name: `${baseName}-${input.suffix}`,
        overwrite: true,
      })

      return { snapshot, skippedReason: null }
    } catch (error) {
      return {
        snapshot: null,
        skippedReason: `保存${input.suffix === 'before' ? '执行前' : '执行后'}快照失败：${AppError.getMessage(error)}`,
      }
    }
  }

  /** 把运行记录写进当前站点 runs/；干跑、显式关闭、跨站或没有站点时不写，并说明原因。 */
  private async writeRunRecord(input: {
    recipe: BrowserRecipeSkeleton
    runRecord: BrowserRecipeRunRecordArtifact
    currentContext: LooseOptional<BrowserSiteContext>
    dryRun: boolean
    saveRun?: boolean
    runName?: string
  }): Promise<{
    runArtifact: Nullable<BrowserWorkspaceArtifactRecord>
    runSaveSkippedReason: Nullable<string>
  }> {
    // 干跑只预检，不持久化运行记录。
    if (input.dryRun)
      return { runArtifact: null, runSaveSkippedReason: 'dryRun=true，仅预检，不写入运行记录。' }
    // 调用方可以显式关闭 run 保存。
    if (isFalse(input.saveRun)) return { runArtifact: null, runSaveSkippedReason: null }
    // 没有当前站点上下文时无法确定写入哪个站点工作区。
    if (!input.currentContext)
      return { runArtifact: null, runSaveSkippedReason: '当前没有激活的浏览器站点工作区。' }
    // 执行导致跨站跳转时，不把原站点 recipe 的运行记录写到新站点目录。
    if (!isSameBrowserOrigin(input.currentContext.url, input.recipe.url))
      return {
        runArtifact: null,
        runSaveSkippedReason: 'recipe 执行后已切换到不同网站，未把运行记录写入新的站点工作区。',
      }

    const runArtifact = await this.artifacts().writeArtifact({
      context: input.currentContext,
      kind: 'run',
      format: 'json',
      content: `${stringifyPretty(input.runRecord)}\n`,
      name:
        input.runName ||
        `${input.recipe.title || 'recipe'}-${new Date(input.runRecord.finishedAt).toISOString()}-run`,
    })

    return { runArtifact, runSaveSkippedReason: null }
  }
}

/**
 * 干跑一份 recipe 骨架并返回结构化结论。
 *
 * 供**宿主界面直调**（产物面板的「干跑」按钮走 IPC 落到这里），与模型走的
 * `browser:recipe action=run_skeleton dryRun=true` 共用同一个执行器：干跑的语义只有一处实现，
 * 按钮与工具不会各自漂移。刻意不写运行记录、不存快照——预检就该零副作用。
 */
export async function runBrowserRecipeDryRun(
  input: { path: string },
  ctx: ToolContext
): Promise<BrowserRecipeDryRunSummary> {
  const result = await new BrowserRecipeOperations(ctx).runSkeleton({
    path: input.path,
    dryRun: true,
    saveRun: false,
    saveSnapshots: false,
  })

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
