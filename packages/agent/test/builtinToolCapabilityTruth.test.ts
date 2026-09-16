import { describe, expect, test } from 'bun:test'

import { activeDirectiveTools } from '../src/impl/AgentTools'
import { agentWorkflowTools } from '../src/impl/AgentTools'
import { backgroundJobTools } from '../src/impl/AgentTools'
import { categoriesTools } from '../src/impl/AgentTools'
import { confirmationTools } from '../src/impl/AgentTools'
import { contextHandoffTools } from '../src/impl/AgentTools'
import { contextRetrievalTools } from '../src/impl/AgentTools'
import { dispatchAgentTools } from '../src/impl/AgentTools'
import { goalTools } from '../src/impl/AgentTools'
import { plansTools } from '../src/impl/AgentTools'
import type { VelaTool } from '../src/types/builtin.js'
import { pageToolDiscoveryCards } from '../src/utils/builtin/tool-space-queries'

const tools = {
  ...activeDirectiveTools,
  ...agentWorkflowTools,
  ...backgroundJobTools,
  ...categoriesTools,
  ...contextHandoffTools,
  ...contextRetrievalTools,
  ...dispatchAgentTools,
  ...goalTools,
  ...plansTools,
  ...confirmationTools,
} satisfies Record<string, VelaTool<any, any>>

const expectedEffects = {
  'agent:dispatch': 'execute',
  'agent:run_workflow': 'execute',
  'context:handoff': 'external',
  'context:recall': 'read',
  'directive:archive': 'write',
  'directive:list': 'read',
  'directive:upsert': 'write',
  'goal:create': 'write',
  'goal:update': 'write',
  'interaction:confirm': 'external',
  'job:read_output': 'read',
  'job:wait': 'read',
  'plan:update': 'write',
  'tooling:map': 'read',
  'tooling:read': 'read',
  'tooling:replace': 'write',
} as const

function createToolSpaceContext() {
  const entries = Object.entries(tools)
  const categoryIds = [...new Set(entries.map(([, tool]) => tool.category))]
  const capabilityPages = entries.map(([name, tool]) => ({
    id: `tool:${name}`,
    name,
    categoryId: tool.category,
    descriptor: {
      name,
      description: tool.description,
      role: tool.role,
      permissions: tool.permissions,
      capabilities: tool.capabilities,
      categoryId: tool.category,
      systemEnabled: true,
    },
    permissions: tool.permissions,
    availability: 'visible' as const,
    schemaState: 'visible' as const,
    schemaPolicy: 'full' as const,
    nextAction: 'call_tool' as const,
    resident: true,
    reasons: [],
  }))

  return {
    codingSession: {
      hasToolCategoryAccess: () => true,
      isToolCategoryAllowed: () => true,
      getEnabledPromptFeatures: () => [],
    },
    getCurrentVisibleToolNames: () => entries.map(([name]) => name),
    listCapabilityPages: () => capabilityPages,
    listToolCategories: () => categoryIds.map((categoryId) => ({
      category: {
        id: categoryId,
        label: categoryId,
        description: `${categoryId} tools`,
        toolOs: { domain: 'agent', defaultState: 'resident' as const },
      },
      enabled: true,
      tools: capabilityPages
        .filter((page) => page.categoryId === categoryId)
        .map((page) => page.descriptor),
    })),
  } as never
}

describe('built-in tool capability truth', () => {
  test('declares the behavior effect and derives readOnly from it', () => {
    expect(Object.keys(tools).sort()).toEqual(Object.keys(expectedEffects).sort())

    for (const [name, expectedEffect] of Object.entries(expectedEffects)) {
      const tool = tools[name as keyof typeof tools]
      expect(tool.capabilities?.effectKind, name).toBe(expectedEffect)
      expect(tool.readOnly, name).toBe(expectedEffect === 'read')
    }
  })

  test('projects owner-declared effects into tooling map risk', () => {
    const result = pageToolDiscoveryCards(createToolSpaceContext(), {
      op: 'page',
      kind: 'tool',
      categoryIds: [],
      domainIds: [],
      toolOsStates: [],
      limit: 50,
    })
    const risks = Object.fromEntries(result.pages.map((page) => [page.name, page.risk]))

    expect(risks).toEqual(expectedEffects)
  })

  test('serializes plan updates because they mutate interaction and active context', () => {
    const updatePlan = plansTools['plan:update']

    expect(updatePlan.capabilities?.concurrency).toBe('unsafe')
    expect(updatePlan.isConcurrencySafe?.({
      plan: [{ step: '更新计划', status: 'in_progress' }],
    })).toBe(false)
  })
})
