import { describe, expect, test } from 'bun:test'

import { CapabilityRunPlanner } from '../src/agent/control-plane/CapabilityRunPlanner'
import type { AgentRuntimeCapabilityPorts } from '../src/capabilities'
import type { ToolCategoryId, ToolDescriptor } from '../src/protocol'

const GeneralCategory = 'general' as ToolCategoryId
const BrowserCategory = 'browser' as ToolCategoryId

function descriptor(name: string, categoryId: ToolCategoryId): ToolDescriptor {
  return {
    name,
    description: name,
    role: 'inspect',
    permissions: [],
    capabilities: [],
    categoryId,
    systemEnabled: true,
  }
}

const MapTool = descriptor('tooling:map', GeneralCategory)
const ReadTool = descriptor('tooling:read', GeneralCategory)
const BrowserActTool = descriptor('browser:act', BrowserCategory)
const BrowserStateTool = descriptor('browser:get_page_state', BrowserCategory)
const AllTools = [MapTool, ReadTool, BrowserActTool, BrowserStateTool]

const ports: AgentRuntimeCapabilityPorts = {
  scopePolicy: {
    resolveScopeId: () => 'browser',
    decideCategory: () => ({ allowed: true }),
    getResidency: () => ({ residentToolNames: ['tooling:map'] }),
  },
}

function plan(overrides: {
  configuredTools?: string[]
  budgetOverrideToolCategoryIds?: ToolCategoryId[]
  budgetOverrideToolNames?: string[]
} = {}) {
  return new CapabilityRunPlanner().plan({
    messages: [],
    runProfile: 'balanced',
    configuredTools: overrides.configuredTools,
    roleAllowedTools: AllTools.map(({ name }) => name),
    currentVisibleToolNames: [],
    enabledToolCategoryIds: [GeneralCategory, BrowserCategory],
    budgetOverrideToolCategoryIds: overrides.budgetOverrideToolCategoryIds ?? [],
    budgetOverrideToolNames: overrides.budgetOverrideToolNames ?? [],
    visibleEnabledToolCategories: [
      { category: { id: GeneralCategory }, tools: [MapTool, ReadTool] },
      { category: { id: BrowserCategory }, tools: [BrowserActTool, BrowserStateTool] },
    ],
    runtimeToolCategories: [
      { category: { id: GeneralCategory }, tools: [MapTool, ReadTool] },
      { category: { id: BrowserCategory }, tools: [BrowserActTool, BrowserStateTool] },
    ],
    allowedToolCategoryIds: [GeneralCategory, BrowserCategory],
    capabilityPorts: ports,
    capabilityScopeId: 'browser',
    turn: 2,
    toolSchemaChars: Object.fromEntries(AllTools.map(({ name }) => [name, 100])),
    toolSchemaCharBudget: 100_000,
  })
}

void describe('capability scope residency', () => {
  void test('keeps loadable tools out of the provider request even when schema budget has room', () => {
    const result = plan()

    expect(result.residentToolNames).toEqual(['tooling:map'])
    expect(result.droppedToolNames).toEqual([
      'tooling:read',
      'browser:act',
      'browser:get_page_state',
    ])
  })

  void test('pages in an explicit tool without exposing its whole category', () => {
    const result = plan({ budgetOverrideToolNames: ['browser:get_page_state'] })

    expect(result.residentToolNames).toHaveLength(2)
    expect(result.residentToolNames).toEqual(
      expect.arrayContaining(['tooling:map', 'browser:get_page_state'])
    )
    expect(result.droppedToolNames).toContain('browser:act')
  })

  void test('pages in a requested category and honors explicitly configured tools', () => {
    const categoryResult = plan({ budgetOverrideToolCategoryIds: [BrowserCategory] })
    expect(categoryResult.residentToolNames).toHaveLength(3)
    expect(categoryResult.residentToolNames).toEqual(
      expect.arrayContaining(['tooling:map', 'browser:act', 'browser:get_page_state'])
    )
    expect(plan({ configuredTools: ['browser:act'] }).residentToolNames).toEqual([
      'tooling:map',
      'browser:act',
    ])
  })
})
