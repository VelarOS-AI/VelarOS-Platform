import { describe, expect, test } from 'bun:test'

import { contextHandoffTools, createBuiltinAgentModDefinition } from '../src/impl/AgentTools'
import type { RuntimePromptSnapshot } from '../src/types/guidance.js'
import { createRuntimePromptSegments } from '../src/utils/guidance/runtime'

function buildContextPrompt(): string {
  const toolNames = ['context:recall', 'context:handoff']
  const snapshot: RuntimePromptSnapshot = {
    locale: 'zh-CN',
    roleId: 'chat',
    roleLabel: 'Chat',
    workflowType: 'chat',
    thinkingDepth: 'balanced',
    developerContext: null,
    agentSurfaceId: 'chat',
    contextPhase: 'operational',
    activeCapabilityScope: 'system',
    toolCategories: ['context'],
    toolSurfaceProfile: 'full',
    runProfile: 'balanced',
    toolCapabilityCategories: [
      {
        id: 'context',
        label: 'Context',
        description: 'Session context',
        enabled: true,
        toolOsDefaultState: 'resident',
        tools: toolNames.map((name) => ({ name, description: name })),
        hiddenToolCount: 0,
      },
    ],
    requestableToolCapabilityCategories: [],
    canUpdatePlan: false,
    userRequestedPlan: false,
    goalMode: false,
    selectedPromptFeatureLabels: [],
    enabledPromptFeatures: [],
    autoPromptFeatureLabels: [],
    availableSkills: [],
    customSubAgents: [],
    executionPlanPreview: null,
    currentExecutionAdvice: null,
    recentToolFailures: [],
    hasCompactedContext: false,
  }
  return createRuntimePromptSegments(snapshot)
    .map((segment) => segment.render({}))
    .join('\n')
}

describe('automatic context management tool surface', () => {
  test('default manifest and bindings expose recall and task state without manual compression', () => {
    const builtin = createBuiltinAgentModDefinition()
    const names = builtin.manifest.contributes.tools?.map((tool) => tool.name) ?? []

    expect(names).not.toContain('context:distill')
    expect(builtin.bindings.tools).not.toHaveProperty('context:distill')
    for (const name of ['context:recall', 'context:handoff', 'goal:update', 'directive:upsert']) {
      expect(names).toContain(name)
      expect(builtin.bindings.tools).toHaveProperty(name)
    }
  })

  test('runtime and handoff prompts keep compression owned by the system for legacy hosts too', () => {
    const prompt = buildContextPrompt()

    expect(prompt).not.toContain('context:distill')
    expect(prompt).toContain('完整请求超出模型可用容量时')
    expect(prompt).toContain('context:recall')
    expect(contextHandoffTools['context:handoff'].description).not.toContain('context:distill')
    expect(contextHandoffTools['context:handoff'].description).toContain('自动整理')
  })

})
