
import type { ResolveSoloLoopProtectedToolsArgs, ResolveSoloLoopToolCategoriesForExposureArgs,SoloLoopToolCategory } from '../../types/loop.js'

import { resolveCapabilityProtectedTools, resolveCapabilityToolCategoriesForExposure } from './capability-run-planner'

/**
 * 算这一轮要暴露给模型的工具类别：把可见的已启用类别、运行时全量类别、已启用类别 id 与预算豁免类别
 * 一并交给 `resolveCapabilityToolCategoriesForExposure`。
 * 这一层只干一件实事——把预算豁免类别统一摊成数组（调用方给 Set 还是数组都收），真正的取舍都在 planner 里。
 */
function resolveSoloLoopToolCategoriesForExposure<TTool extends { name: string }>({
  visibleEnabledToolCategories,
  runtimeToolCategories,
  enabledToolCategoryIds,
  budgetOverrideToolCategories,
}: ResolveSoloLoopToolCategoriesForExposureArgs<TTool>): Array<SoloLoopToolCategory<TTool>> {
  const budgetOverrideCategoryIds =
    budgetOverrideToolCategories instanceof Set
      ? [...budgetOverrideToolCategories]
      : [...budgetOverrideToolCategories]

  return resolveCapabilityToolCategoriesForExposure({
    visibleEnabledToolCategories,
    runtimeToolCategories,
    enabledToolCategoryIds,
    budgetOverrideToolCategoryIds: budgetOverrideCategoryIds,
  })
}

/**
 * 算这一轮的受保护工具名单，即 schema 预算裁剪时不许被砍掉的那批。
 * 同样只负责把预算豁免类别摊成数组后转交 `resolveCapabilityProtectedTools`。
 */
function resolveSoloLoopProtectedTools({
  enabledToolCategories,
  budgetOverrideToolCategories,
  budgetOverrideToolNames,
}: ResolveSoloLoopProtectedToolsArgs): string[] {
  const budgetOverrideToolCategoryIds =
    budgetOverrideToolCategories instanceof Set
      ? [...budgetOverrideToolCategories]
      : [...budgetOverrideToolCategories]

  return resolveCapabilityProtectedTools({
    enabledToolCategories,
    budgetOverrideToolCategoryIds,
    budgetOverrideToolNames,
  })
}

export { resolveSoloLoopProtectedTools, resolveSoloLoopToolCategoriesForExposure }
