import { describe, expect, test } from 'bun:test'

import {
  mapToolDiscoveryCards,
  pageToolDiscoveryCards,
} from '../src/tool-library/builtin/ToolSpaceQueries'
import { toolSpacePageSchema } from '../src/tool-library/builtin/ToolSpaceSchemas'

function createToolSpaceContext() {
  const categorySpecs = [
    { id: 'alpha', domain: 'alpha-domain' },
    { id: 'beta', domain: 'beta-domain' },
  ]
  const categories = categorySpecs.map(({ id, domain }) => {
    const tools = Array.from({ length: 6 }, (_, index) => ({
      name: `${id}:tool-${index + 1}`,
      description: `Inspect ${id} item ${index + 1}.`,
      role: 'inspect',
      permissions: [],
      categoryId: id,
      systemEnabled: true,
    }))
    return {
      category: {
        id,
        label: `${id} tools`,
        description: `Tools in ${id}.`,
        toolOs: { domain, defaultState: 'resident' },
      },
      enabled: true,
      tools,
    }
  })
  const capabilityPages = categories.flatMap((entry) =>
    entry.tools.map((descriptor) => ({
      id: `tool:${descriptor.name}`,
      kind: 'tool',
      name: descriptor.name,
      categoryId: descriptor.categoryId,
      descriptor,
      permissions: [],
      availability: 'visible',
      schemaState: 'visible',
      schemaPolicy: 'full',
      nextAction: 'call_tool',
      resident: true,
      reasons: [{ layer: 'resident', code: 'visible', message: 'visible now' }],
    }))
  )

  return {
    codingSession: {
      hasToolCategoryAccess: () => true,
      isToolCategoryAllowed: () => true,
      getEnabledPromptFeatures: () => [],
    },
    getCurrentVisibleToolNames: () => capabilityPages.map((page) => page.name),
    listCapabilityPages: () => capabilityPages,
    listToolCategories: () => categories,
  } as never
}

const mapInput = {
  op: 'map' as const,
  kind: 'tool' as const,
  categoryIds: [],
  domainIds: [],
  toolOsStates: [],
  categoryLimit: 12,
  maxToolsPerCategory: 8,
}

describe('tool space map ergonomics', () => {
  test('allocates the row budget across categories actually returned on the page', () => {
    const result = mapToolDiscoveryCards(createToolSpaceContext(), mapInput)

    expect(result.categories).toHaveLength(2)
    expect(result.filters.effectiveMaxToolsPerCategory).toBe(8)
    expect(result.categories.map((category) => category.toolsReturnedCount)).toEqual([6, 6])
  })

  test('keeps capability metadata for kind=tool and returns an executable continuation', () => {
    const context = createToolSpaceContext()
    const result = mapToolDiscoveryCards(context, {
      ...mapInput,
      categoryIds: ['alpha'],
      maxToolsPerCategory: 2,
    })
    const category = result.categories[0]!

    expect(category.capability).toMatchObject({
      kind: 'capability',
      categoryId: 'alpha',
    })
    expect(category.activation.capabilityId).toBe('capability:alpha')
    expect(category.toolPage).toEqual({
      tool: 'tooling:map',
      input: {
        op: 'page',
        kind: 'tool',
        categoryIds: ['alpha'],
        domainIds: [],
        toolOsStates: [],
        limit: 50,
        cursor: '2',
      },
    })

    const continuation = toolSpacePageSchema.parse(category.toolPage!.input)
    const page = pageToolDiscoveryCards(context, continuation)
    expect(page.pages[0]?.name).toBe('alpha:tool-3')
  })

  test('returns valid domain ids and no broad results for an unknown domain', () => {
    const result = mapToolDiscoveryCards(createToolSpaceContext(), {
      ...mapInput,
      domainIds: ['typo-domain'],
    })

    expect(result.categories).toEqual([])
    expect(result.filters.expandedCategoryIds).toEqual([])
    expect(result.filters.unknownDomainIds).toEqual(['typo-domain'])
    expect(result.filters.validDomainIds).toEqual(['alpha-domain', 'beta-domain'])
  })
})
