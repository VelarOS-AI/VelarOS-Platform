import { describe, expect, test } from 'bun:test'

import { searchToolDiscoveryCards } from '../src/tool-library/builtin/ToolSpaceQueries'
import {
  parseToolSpaceQueryMethodInput,
  toolSpaceQueryMethodSchema,
  ToolSpaceQueryPageLimitMax,
} from '../src/tool-library/builtin/ToolSpaceSchemas'

describe('tool space find projection', () => {
  test('keeps the provider-facing and op-specific page limits aligned', () => {
    const atLimit = {
      op: 'find' as const,
      query: 'read project file',
      limit: ToolSpaceQueryPageLimitMax,
    }
    expect(toolSpaceQueryMethodSchema.safeParse(atLimit).success).toBe(true)
    expect(parseToolSpaceQueryMethodInput(atLimit).limit).toBe(ToolSpaceQueryPageLimitMax)

    const aboveLimit = { ...atLimit, limit: ToolSpaceQueryPageLimitMax + 1 }
    expect(toolSpaceQueryMethodSchema.safeParse(aboveLimit).success).toBe(false)
    expect(() => parseToolSpaceQueryMethodInput(aboveLimit)).toThrow()

    expect(
      toolSpaceQueryMethodSchema.safeParse({
        op: 'page',
        limit: ToolSpaceQueryPageLimitMax + 1,
      }).success
    ).toBe(false)
  })

  test('returns a compact routing card and leaves detailed diagnostics out of history', () => {
    const descriptor = {
      name: 'project:read',
      description: 'Read project files and return bounded text ranges.',
      role: 'inspect',
      permissions: ['fs:read'],
      categoryId: 'project-files',
      systemEnabled: true,
    }
    const context = {
      codingSession: {
        hasToolCategoryAccess: () => true,
        isToolCategoryAllowed: () => true,
        getEnabledPromptFeatures: () => [],
      },
      getCurrentVisibleToolNames: () => ['project:read'],
      listCapabilityPages: () => [{
        id: 'tool:project:read',
        kind: 'tool',
        name: 'project:read',
        categoryId: 'project-files',
        descriptor,
        permissions: ['fs:read'],
        availability: 'visible',
        schemaState: 'visible',
        schemaPolicy: 'full',
        nextAction: 'call_tool',
        resident: true,
        reasons: [{ layer: 'resident', code: 'visible', message: 'visible now' }],
      }],
      listToolCategories: () => [],
    }

    const result = searchToolDiscoveryCards(context as never, {
      op: 'find',
      query: 'read project file',
      kind: 'all',
      categoryIds: [],
      domainIds: [],
      toolOsStates: [],
      limit: 12,
    })
    const page = result.pages[0]
    const serialized = JSON.stringify(page)

    expect(page).toMatchObject({
      id: 'tool:project:read',
      name: 'project:read',
      resident: true,
      activation: {
        method: 'direct_call',
        nextTool: 'project:read',
      },
    })
    expect(page.matchedFields.length).toBeGreaterThan(0)
    expect(serialized.length).toBeLessThan(1_500)
    expect(serialized).not.toContain('matchSignals')
    expect(serialized).not.toContain('dependencies')
    expect(serialized).not.toContain('reasons')
    expect(serialized).not.toContain('access')
  })

  test('projects owner-declared effect risk even when no host permission is required', () => {
    const descriptor = {
      name: 'schedule:delete',
      description: 'Permanently delete a scheduled task and its run history.',
      role: 'control',
      permissions: [],
      capabilities: {
        effectKind: 'destructive',
        writeScopes: ['scheduled-tasks', 'scheduled-task-runs'],
      },
      categoryId: 'scheduling',
      systemEnabled: true,
    }
    const context = {
      codingSession: {
        hasToolCategoryAccess: () => true,
        isToolCategoryAllowed: () => true,
        getEnabledPromptFeatures: () => [],
      },
      getCurrentVisibleToolNames: () => [],
      listCapabilityPages: () => [{
        id: 'tool:schedule:delete',
        kind: 'tool',
        name: descriptor.name,
        categoryId: descriptor.categoryId,
        descriptor,
        permissions: [],
        availability: 'loadable',
        schemaState: 'visible',
        schemaPolicy: 'preview',
        nextAction: 'replace_page',
        resident: false,
        reasons: [],
      }],
      listToolCategories: () => [],
    }

    const result = searchToolDiscoveryCards(context as never, {
      op: 'find',
      query: 'delete scheduled task',
      kind: 'all',
      categoryIds: [],
      domainIds: [],
      toolOsStates: [],
      limit: 12,
    })

    expect(result.pages[0]).toMatchObject({
      id: 'tool:schedule:delete',
      risk: 'destructive',
    })
  })
})
