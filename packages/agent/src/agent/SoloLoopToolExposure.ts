import type { ToolCategoryId } from '@velaros-ai/agent/protocol'

import { capabilityRunPlanner } from './control-plane'

interface SoloLoopToolCategory<TTool extends { name: string } = { name: string }> {
  category: { id: ToolCategoryId }
  tools: TTool[]
}

type SoloLoopProtectedToolCategory = SoloLoopToolCategory

interface ResolveSoloLoopProtectedToolsArgs {
  enabledToolCategories: SoloLoopProtectedToolCategory[]
  budgetOverrideToolCategories: ReadonlySet<ToolCategoryId> | readonly ToolCategoryId[]
  budgetOverrideToolNames: readonly string[]
}

interface ResolveSoloLoopToolCategoriesForExposureArgs<TTool extends { name: string }> {
  visibleEnabledToolCategories: Array<SoloLoopToolCategory<TTool>>
  runtimeToolCategories: Array<SoloLoopToolCategory<TTool>>
  enabledToolCategoryIds: readonly ToolCategoryId[]
  budgetOverrideToolCategories: ReadonlySet<ToolCategoryId> | readonly ToolCategoryId[]
}

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
export type {
  ResolveSoloLoopProtectedToolsArgs,
  ResolveSoloLoopToolCategoriesForExposureArgs,
  SoloLoopProtectedToolCategory,
  SoloLoopToolCategory,
}
