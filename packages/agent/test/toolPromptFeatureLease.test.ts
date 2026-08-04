import { describe, expect, test } from 'bun:test'

import { ToolRegistryHelper } from '../src/tools/registry'

const helper = new ToolRegistryHelper({
  normalize: (features) => [...features],
  getLabel: (feature) => feature,
  getCategoriesForFeatures: () => [],
  getFeaturesForCategories: () => [],
  getRequiredFeatureForTool: (toolName) =>
    toolName === 'office:create_word_document' ? 'office-document' : null,
  isOfficeFeature: (feature) => feature.startsWith('office'),
})

const registry = new Map([
  [
    'office:create_word_document',
    {
      categoryId: 'office',
      tool: {
        description: 'fixture',
        permissions: [],
      },
    },
  ],
])

function context(hasToolNameAccess: boolean) {
  return {
    role: { id: 'primary-agent' },
    grantedPermissions: new Set(),
    codingSession: {
      isToolCategoryAllowed: () => true,
      hasToolCategoryAccess: () => true,
      hasActiveToolCategoryAccess: () => true,
      hasToolNameAccess: () => hasToolNameAccess,
      hasPromptFeatureAccess: () => false,
      getToolSurfaceProfile: () => 'direct',
    },
    isToolSystemEnabled: () => true,
  }
}

describe('prompt-feature protected tool residency', () => {
  test('keeps a protected tool hidden without a feature or explicit tool lease', () => {
    expect(
      helper.listAvailableEntries(registry as never, context(false) as never, undefined, 'enabled')
    ).toEqual([])
  })

  test('lets an exact tooling:replace lease cross only the prompt selection gate', () => {
    expect(
      helper
        .listAvailableEntries(registry as never, context(true) as never, undefined, 'enabled')
        .map(([name]) => name)
    ).toEqual(['office:create_word_document'])
  })
})
