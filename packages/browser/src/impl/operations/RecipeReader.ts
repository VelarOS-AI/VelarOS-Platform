import type { ToolContext } from '../../contract/requires'
import type {
  BrowserPageSnapshotRead,
  BrowserRecipeRunRead,
  BrowserRecipeSkeletonRead,
} from '../../types/recipes'
import {
  parseBrowserPageSnapshot,
  parseBrowserRecipeRunRecord,
  parseRecipeSkeleton,
} from '../../utils/recipes/parser'
import {
  requirePageSnapshotPath,
  requireRecipePath,
  requireRunPath,
  requireSameBrowserOrigin,
} from '../../utils/recipes/paths'
import { getActiveBrowserContext } from '../../utils/tool.js'

/** 读取当前站点 browser artifact（recipes/pages/runs）并做同源校验。 */
export interface BrowserRecipeReaderApi {
  /** 读一份 recipe 骨架；路径不在 recipes/ 下或与当前站点不同源时报错。 */
  readRecipeSkeleton(inputPath: string, ctx: ToolContext): Promise<BrowserRecipeSkeletonRead>
  /** 读一份页面快照；路径不在 pages/ 下或与当前站点不同源时报错。 */
  readPageSnapshot(inputPath: string, ctx: ToolContext): Promise<BrowserPageSnapshotRead>
  /** 读一份 recipe 运行记录；路径不在 runs/ 下或与当前站点不同源时报错。 */
  readRecipeRunRecord(inputPath: string, ctx: ToolContext): Promise<BrowserRecipeRunRead>
}

class BrowserRecipeReader implements BrowserRecipeReaderApi {
  public async readRecipeSkeleton(inputPath: string, ctx: ToolContext): Promise<BrowserRecipeSkeletonRead> {
    const recipePath = requireRecipePath(inputPath)
    const file = await ctx.browser.readFile(recipePath, 1, undefined, 200000)
    const recipe = parseRecipeSkeleton(recipePath, file.content)
    const context = getActiveBrowserContext(ctx)
    requireSameBrowserOrigin(recipe.url, context.url, 'recipe')

    return {
      path: recipePath,
      recipe,
      context,
    }
  }

  public async readPageSnapshot(inputPath: string, ctx: ToolContext): Promise<BrowserPageSnapshotRead> {
    const snapshotPath = requirePageSnapshotPath(inputPath)
    const file = await ctx.browser.readFile(snapshotPath, 1, undefined, 500000)
    const inspection = parseBrowserPageSnapshot(snapshotPath, file.content)
    const context = getActiveBrowserContext(ctx)
    requireSameBrowserOrigin(inspection.url, context.url, '页面快照')

    return {
      path: snapshotPath,
      inspection,
      context,
    }
  }

  public async readRecipeRunRecord(inputPath: string, ctx: ToolContext): Promise<BrowserRecipeRunRead> {
    const runPath = requireRunPath(inputPath)
    const file = await ctx.browser.readFile(runPath, 1, undefined, 500000)
    const run = parseBrowserRecipeRunRecord(runPath, file.content)
    const context = getActiveBrowserContext(ctx)
    requireSameBrowserOrigin(run.recipeUrl, context.url, '运行记录')

    return {
      path: runPath,
      run,
      context,
    }
  }
}

export const browserRecipeReader: BrowserRecipeReaderApi = new BrowserRecipeReader()

