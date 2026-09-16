import { toNullable } from '@velaros-ai/core'

import type { ToolContext } from '../../contract/requires.js'
import type {
  BrowserRecipeDryRunSummary,
  BrowserRecipeSkeletonPreview,
} from '../../types/browser.js'
import { normalizeBrowserRecipePath } from '../../utils/artifacts.js'
import {
  assertSameBrowserOrigin,
  buildRecipeSkeletonPreview,
} from '../../utils/recipes/preview.js'

import { BrowserRecipeOperations } from './BrowserRecipeOperations.js'

/**
 * 给**宿主界面**的 recipe 面：产物面板要读一份骨架、要按「干跑」按钮，走的是这一件能力。
 *
 * 和模型面的 `browser:recipe` 共用同一个执行器与同一套路径、同源校验——按钮与工具不会
 * 对同一份产物给出两种结论。这里一件状态都不持有，整个进程共用 `browserRecipes` 这一份。
 */
export interface BrowserRecipesApi {
  /** 把用户或界面给的路径收敛成站点工作区里的 recipe 相对路径。 */
  normalizePath(path: string): string
  /**
   * 解析一份 recipe 骨架，给出界面要的预览摘要。
   *
   * `siteUrl` 给了就顺手核一次同源：产物属于哪个站点是产物自己写着的，读别的站点的骨架
   * 一律当场报错，而不是把另一个站点的输入名回给用户。
   */
  preview(path: string, content: string, siteUrl?: string): BrowserRecipeSkeletonPreview
  /** 干跑一份 recipe：只预检，不写运行记录、不存快照。 */
  dryRun(input: { path: string }, ctx: ToolContext): Promise<BrowserRecipeDryRunSummary>
}

/** 见 {@link BrowserRecipesApi}。 */
class BrowserRecipes implements BrowserRecipesApi {
  public normalizePath(path: string): string {
    return normalizeBrowserRecipePath(path)
  }

  public preview(path: string, content: string, siteUrl?: string): BrowserRecipeSkeletonPreview {
    const preview = buildRecipeSkeletonPreview(path, content)
    if (siteUrl) assertSameBrowserOrigin(preview.url, siteUrl)
    return preview
  }

  public async dryRun(
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
}

/** 整个进程共用的宿主 recipe 面实例。 */
export const browserRecipes: BrowserRecipesApi = new BrowserRecipes()
