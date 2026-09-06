import { describe, expect, test } from 'bun:test'

import { replaceToolSpacePages } from '../src/tool-library/builtin/ToolSpaceReplace'
import { toolSpaceReplaceMethodSchema } from '../src/tool-library/builtin/ToolSpaceSchemas'

function createHarness() {
  const calls: string[] = []
  const enabledCategories = new Set(['alpha', 'beta'])
  const enabledTools = new Set(['alpha:read'])
  const descriptors = ['alpha', 'beta', 'bundle', 'other-bundle'].map((categoryId) => ({
    name: `${categoryId}:read`,
    description: 'Read a value.',
    role: 'inspect',
    permissions: [],
    categoryId,
    systemEnabled: true,
  }))
  descriptors.push({ ...descriptors[0]!, name: 'alpha:search' })
  const context = {
    abortSignal: new AbortController().signal,
    role: { id: 'primary-agent' },
    capabilityPorts: {
      scopePolicy: {
        resolveScopeId: () => 'default',
        decideCategory: () => ({ allowed: true }),
        expandCategoryIds: (ids: string[]) => ids.flatMap((id) =>
          id === 'bundle' || id === 'other-bundle' ? [id, 'alpha'] : [id]),
      },
    },
    codingSession: {
      hasToolCategoryAccess: (id: string) => enabledCategories.has(id),
      isToolCategoryAllowed: () => true,
      getEnabledPromptFeatures: () => [],
      enableToolCategories: (ids: string[]) => {
        calls.push('enable categories')
        ids.forEach((id) => enabledCategories.add(id))
      },
      disableToolCategories: (ids: string[]) => {
        calls.push('disable categories')
        ids.forEach((id) => enabledCategories.delete(id))
      },
      enableToolNames: (ids: string[]) => {
        calls.push('enable tools')
        ids.forEach((id) => enabledTools.add(id))
      },
      disableToolNames: (ids: string[]) => {
        calls.push('disable tools')
        ids.forEach((id) => enabledTools.delete(id))
      },
    },
    requestToolCategoryAccess: async (ids: string[]) => {
      calls.push('request approval')
      ids.forEach((id) => enabledCategories.add(id))
      return { approved: true, enabledCategories: ids }
    },
    getCurrentVisibleToolNames: () => [],
    listTools: () => descriptors,
    listToolCategories: () => descriptors.map((descriptor) => ({
      category: { id: descriptor.categoryId, label: descriptor.categoryId, description: 'Read values.' },
      enabled: enabledCategories.has(descriptor.categoryId),
      tools: [descriptor],
    })),
  }
  return { context, calls, enabledCategories, enabledTools }
}

describe('tool space replacement conflicts', () => {
  test('rejects the same normalized page in both schema inputs', () => {
    const parsed = toolSpaceReplaceMethodSchema.safeParse({
      pageIn: [' tool:alpha:read '],
      pageOut: ['tool:alpha:read'],
      reason: 'refresh tools',
    })
    expect(parsed.success).toBe(false)
  })

  test.each([
    { pageIn: ['tool:alpha:read'], pageOut: ['tool:alpha:read'] },
    { pageIn: ['tool:alpha:read'], pageOut: ['capability:alpha'] },
    { pageIn: ['capability:alpha'], pageOut: ['tool:alpha:read'] },
    { pageIn: ['tool:alpha:read'], pageOut: ['capability:bundle'] },
    { pageIn: ['capability:bundle'], pageOut: ['tool:alpha:read'] },
    { pageIn: ['capability:bundle'], pageOut: ['capability:other-bundle'] },
  ])('rejects overlapping targets before changing state: $pageIn / $pageOut', async (input) => {
    const harness = createHarness()
    await expect(replaceToolSpacePages(harness.context as never, {
      op: 'replace',
      ...input,
      reason: 'replace tools',
    })).rejects.toThrow('pageIn')
    expect(harness.calls).toEqual([])
    expect([...harness.enabledCategories]).toEqual(['alpha', 'beta'])
    expect([...harness.enabledTools]).toEqual(['alpha:read'])
  })

  test('allows replacing different tools in the same category', async () => {
    const harness = createHarness()
    const result = await replaceToolSpacePages(harness.context as never, {
      op: 'replace',
      pageIn: ['tool:alpha:search'],
      pageOut: ['tool:alpha:read'],
      reason: 'switch tools',
    })
    expect(result.preparedTools).toEqual(['alpha:search'])
    expect(result.pageOutTools).toEqual(['alpha:read'])
    expect([...harness.enabledTools]).toEqual(['alpha:search'])
  })
})
