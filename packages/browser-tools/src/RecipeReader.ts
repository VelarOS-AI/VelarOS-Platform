import { getActiveBrowserContext } from './Context'
import {
  parseBrowserPageSnapshot,
  parseBrowserRecipeRunRecord,
  parseRecipeSkeleton,
} from './RecipeParser'
import {
  requirePageSnapshotPath,
  requireRecipePath,
  requireRunPath,
  requireSameBrowserOrigin,
} from './RecipePaths'
import type { ToolContext } from './Types'

/** 读取当前站点 browser artifact（recipes/pages/runs）并做同源校验。 */
class BrowserRecipeReader {
  public async readRecipeSkeleton(inputPath: string, ctx: ToolContext) {
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

  public async readPageSnapshot(inputPath: string, ctx: ToolContext) {
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

  public async readRecipeRunRecord(inputPath: string, ctx: ToolContext) {
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

const browserRecipeReader = new BrowserRecipeReader()

export { BrowserRecipeReader,browserRecipeReader }
