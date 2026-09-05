import { describe, expect, test } from 'bun:test'

import { CodingSessionTracker } from '../src/agent/CodingSessionTracker'
import { replaceToolSpacePages } from '../src/tool-library/builtin/ToolSpaceReplace'

describe('tool space capability residency', () => {
  test.each([
    { pageIn: ['tool:project:read'], preparedTools: [] },
    {
      pageIn: ['tool:project:read', 'tool:project:search'],
      preparedTools: ['project:search'],
    },
  ])('reports directly callable tools when paging in $pageIn', async ({ pageIn, preparedTools }) => {
    const enabledToolNames: string[] = []
    const descriptors = ['project:read', 'project:search'].map((name) => ({
      name,
      description: 'Inspect project files.',
      role: 'inspect' as const,
      permissions: [] as const,
      categoryId: 'project-files',
      systemEnabled: true,
    }))
    const context = {
      abortSignal: new AbortController().signal,
      role: { id: 'primary-agent' },
      codingSession: {
        hasToolCategoryAccess: () => true,
        isToolCategoryAllowed: () => true,
        getEnabledPromptFeatures: () => [],
        enableToolCategories: () => [],
        enableToolNames: (names: string[]) => {
          enabledToolNames.push(...names)
          return names
        },
        disableToolCategories: () => [],
      },
      getCurrentVisibleToolNames: () => ['project:read'],
      listTools: () => descriptors,
      listToolCategories: () => [{
        category: {
          id: 'project-files',
          label: 'Project files',
          description: 'Inspect project files.',
        },
        enabled: true,
        tools: descriptors,
      }],
    }

    const result = await replaceToolSpacePages(context as never, {
      op: 'replace',
      pageIn,
      pageOut: [],
      reason: 'inspect project files',
    })

    expect(result.alreadyResidentTools).toEqual(['project:read'])
    expect(result.activeThisTurn).toBe(true)
    expect(result.preparedTools).toEqual(preparedTools)
    expect(enabledToolNames).toEqual(preparedTools)
    expect(result.message).toContain('project:read 已驻留，本轮即可直接调用')
    expect(result.nextTurnHint).toContain('project:read 已驻留，本轮即可直接调用')
    expect(result.nextTurnHint).not.toContain('再用 tooling:replace')
    if (preparedTools.length > 0) {
      expect(result.nextTurnHint).toContain('project:search 已换入；下一轮')
    } else {
      expect(result.nextTurnHint).not.toContain('下一轮')
      expect(result.nextTurnHint).not.toContain('tooling:map')
    }
  })

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
