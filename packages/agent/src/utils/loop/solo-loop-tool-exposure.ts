
import type { ResolveSoloLoopProtectedToolsArgs, ResolveSoloLoopToolCategoriesForExposureArgs,SoloLoopToolCategory } from '../../types/loop.js'

import { capabilityRunPlanner } from './capability-run-planner'

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

  return capabilityRunPlanner.resolveToolCategoriesForExposure({
    visibleEnabledToolCategories,
    runtimeToolCategories,
    enabledToolCategoryIds,
    budgetOverrideToolCategoryIds: budgetOverrideCategoryIds,
  })
}

function resolveSoloLoopProtectedTools({
  enabledToolCategories,
  budgetOverrideToolCategories,
  budgetOverrideToolNames,
}: ResolveSoloLoopProtectedToolsArgs): string[] {
  const budgetOverrideToolCategoryIds =
    budgetOverrideToolCategories instanceof Set
      ? [...budgetOverrideToolCategories]
      : [...budgetOverrideToolCategories]

  return capabilityRunPlanner.resolveProtectedTools({
    enabledToolCategories,
    budgetOverrideToolCategoryIds,
    budgetOverrideToolNames,
  })
}

export { resolveSoloLoopProtectedTools, resolveSoloLoopToolCategoriesForExposure }
