import { describe, expect, test } from 'bun:test'

import { CodingSessionTracker } from '../src/agent/CodingSessionTracker'
import { replaceToolSpacePages } from '../src/tool-library/builtin/ToolSpaceReplace'

describe('tool space capability residency', () => {
  test('refreshes the category residency lease when an enabled capability is paged in', async () => {
    const enabledCalls: Array<{ categories: string[]; reason?: string }> = []
    const descriptor = {
      name: 'project:read',
      description: 'Read a project file.',
      role: 'inspect' as const,
      permissions: [] as const,
      categoryId: 'project-files',
      systemEnabled: true,
    }
    const context = {
      abortSignal: new AbortController().signal,
      role: { id: 'primary-agent' },
      codingSession: {
        hasToolCategoryAccess: () => true,
        isToolCategoryAllowed: () => true,
        getEnabledPromptFeatures: () => [],
        enableToolCategories: (categories: string[], reason?: string) => {
          enabledCalls.push({ categories, reason })
          return categories
        },
        enableToolNames: () => [],
        disableToolCategories: () => [],
      },
      getCurrentVisibleToolNames: () => [],
      listTools: () => [descriptor],
      listToolCategories: () => [{
        category: {
          id: 'project-files',
          label: 'Project files',
          description: 'Read and edit project files.',
        },
        enabled: true,
        tools: [descriptor],
      }],
    }

    const result = await replaceToolSpacePages(context as never, {
      op: 'replace',
      pageIn: ['capability:project-files'],
      pageOut: [],
      reason: 'inspect project files',
    })

    expect(enabledCalls).toEqual([{
      categories: ['project-files'],
      reason: 'inspect project files',
    }])
    expect(result.enabledCapabilities).toEqual(['project-files'])
    expect(result.effectiveTurn).toBe('next')
    expect(result.nextTurnHint).toContain('下一轮')
  })

  test('temporarily pins a default-resident category without making it disableable', () => {
    const tracker = new CodingSessionTracker(
      ['project-files'],
      [],
      [],
      [],
      {
        residentToolCategories: ['project-files'],
        toolNameLeaseTurns: 3,
      }
    )

    tracker.pruneExpiredToolCategoryLeases(1)
    tracker.enableToolCategories(['project-files'], 'inspect project files')
    expect(tracker.getBudgetOverrideToolCategories()).toEqual(['project-files'])

    tracker.pruneExpiredToolCategoryLeases(2)
    expect(tracker.getBudgetOverrideToolCategories()).toEqual(['project-files'])

    tracker.pruneExpiredToolCategoryLeases(4)
    expect(tracker.getBudgetOverrideToolCategories()).toEqual([])
    expect(tracker.getEnabledToolCategories()).toContain('project-files')
  })
})
