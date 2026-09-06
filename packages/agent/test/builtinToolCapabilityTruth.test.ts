import { describe, expect, test } from 'bun:test'

import { confirmationTools } from '../src/kernel/execution/confirmation-tool'
import { activeDirectiveTools } from '../src/tool-library/builtin/ActiveDirectives.tool'
import { agentWorkflowTools } from '../src/tool-library/builtin/AgentWorkflow.tool'
import { backgroundJobTools } from '../src/tool-library/builtin/BackgroundJobs.tool'
import { categoriesTools } from '../src/tool-library/builtin/Categories.tool'
import { contextDistillTools } from '../src/tool-library/builtin/ContextDistill.tool'
import { contextHandoffTools } from '../src/tool-library/builtin/ContextHandoff.tool'
import { contextRetrievalTools } from '../src/tool-library/builtin/ContextRetrieval.tool'
import { dispatchAgentTools } from '../src/tool-library/builtin/DispatchAgent.tool'
import { goalTools } from '../src/tool-library/builtin/Goals.tool'
import { plansTools } from '../src/tool-library/builtin/Plans.tool'
import { pageToolDiscoveryCards } from '../src/tool-library/builtin/ToolSpaceQueries'
import type { VelaTool } from '../src/tool-library/defineVelaTool'

const tools = {
  ...activeDirectiveTools,
  ...agentWorkflowTools,
  ...backgroundJobTools,
  ...categoriesTools,
  ...contextDistillTools,
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
  'context:distill': 'write',
  'context:handoff': 'external',
  'context:recall': 'read',
  'directive:archive': 'write',
  'directive:list': 'read',
  'directive:upsert': 'write',
  'goal:create': 'write',
  'goal:get': 'read',
  'goal:update': 'write',
  'interaction:confirm': 'external',
  'job:cancel': 'execute',
  'job:read_output': 'read',
  'job:wait': 'read',
  'plan:get': 'read',
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
